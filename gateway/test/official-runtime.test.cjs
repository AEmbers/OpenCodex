const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openFileTargetFromIpc } = require("../runtime/ipc/open-file-context.cjs");
const {
  createIpcFrameParser,
  createOfficialLiveObserver,
  encodeIpcFrame,
  __test: observerTest,
} = require("../runtime/ipc/official-live-observer.cjs");
const {
  createOfficialAppHostRelay,
  __test,
  requestContext,
  setWsHub,
} = require("../runtime/ipc/official-runtime.cjs");
const { __test: portableRunnerTest } = require("../runner/platform/portable.cjs");
const {
  installOfficialNetFetchStatsigHook,
} = require("../runtime/electron/official-net-fetch-statsig-hook.cjs");
const {
  createStatsigIpcFallbackCoordinator,
  resolveStatsigNetworkPolicy,
} = require("../runtime/electron/statsig-network-resilience.cjs");

function createFakeStatsigClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, dueAt: current + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = current + Math.max(0, ms);
      while (true) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.dueAt <= target && (!next || timer.dueAt < next.timer.dueAt)) {
            next = { id, timer };
          }
        }
        if (!next) break;
        timers.delete(next.id);
        current = next.timer.dueAt;
        next.timer.callback();
      }
      current = target;
    },
  };
}

function createStatsigNetHarness(t, options = {}) {
  const calls = [];
  const intercepted = [];
  const nativeNet = {
    fetch: options.fetch || (async (...args) => {
      calls.push(args);
      return { ok: true, status: 201, source: "native" };
    }),
    request() {},
  };
  const hook = installOfficialNetFetchStatsigHook(
    { net: nativeNet },
    {
      initializeDelayMs: 100,
      initializeTimeoutMs: 140,
      registerElectronOverride() {},
      onIntercept: (url, details) => intercepted.push({ url, ...details }),
      ...options,
    }
  );
  t.after(() => {
    if (typeof options.dispose === "function") options.dispose();
  });
  return { calls, hookedNet: hook.net, intercepted, nativeNet };
}

test("Statsig net.fetch preserves the real initialize response and exact telemetry shortcuts", async (t) => {
  const remoteResponse = new Response('{"has_updates":true,"remote":true}', { status: 200 });
  const { calls, hookedNet, intercepted } = createStatsigNetHarness(t, {
    fetch: async (...args) => {
      calls.push(args);
      return remoteResponse;
    },
  });

  const initialize = await hookedNet.fetch("https://ab.chatgpt.com/v1/initialize?k=x");
  assert.equal(initialize, remoteResponse);
  assert.equal(calls.length, 1);
  assert.equal(intercepted.length, 0, "real network responses must not be reported as local fallback");

  const telemetry = await hookedNet.fetch("https://chatgpt.com/ces/v1/rgstr?k=1");
  assert.equal(await telemetry.text(), "{}");
  const sdkException = await hookedNet.fetch("https://ab.chatgpt.com/v1/sdk_exception");
  assert.equal(await sdkException.text(), "{}");
  assert.equal(calls.length, 1, "only the exact telemetry routes are swallowed");

  const nearMatch = await hookedNet.fetch("https://chatgpt.com/ces/v1/rgstr/extra");
  assert.equal(nearMatch, remoteResponse);
  assert.equal(calls.length, 2);
});

test("Statsig net.fetch falls back after network rejection without racing initialization", async (t) => {
  const startedAt = Date.now();
  const { calls, hookedNet, intercepted } = createStatsigNetHarness(t, {
    fetch: async (...args) => {
      calls.push(args);
      throw new Error("ECONNREFUSED");
    },
  });

  const response = await hookedNet.fetch("https://ab.chatgpt.com/v1/initialize?k=x");
  const elapsedMs = Date.now() - startedAt;
  const payload = JSON.parse(await response.text());
  assert.equal(payload.feature_gates["505458"].value, true);
  assert.ok(elapsedMs >= 90, `fallback returned too early: ${elapsedMs}ms`);
  assert.equal(calls.length, 1);
  assert.equal(intercepted.length, 1);
  assert.equal(intercepted[0].reason, "network_error");
});

test("Statsig net.fetch bounds hangs and honors explicit offline fallback", async (t) => {
  const timedStartedAt = Date.now();
  const timed = createStatsigNetHarness(t, {
    fetch: () => new Promise(() => {}),
  });
  const timedResponse = await timed.hookedNet.fetch("https://ab.chatgpt.com/v1/initialize?k=x");
  assert.equal(timedResponse.status, 200);
  assert.ok(Date.now() - timedStartedAt >= 130);
  assert.equal(timed.intercepted.at(-1).reason, "timeout");

  const offlineStartedAt = Date.now();
  const offline = createStatsigNetHarness(t, {
    offlineFallback: true,
    fetch: () => {
      throw new Error("offline mode must not call native fetch");
    },
  });
  const offlineResponse = await offline.hookedNet.fetch("https://ab.chatgpt.com/v1/initialize?k=x");
  assert.equal(JSON.parse(await offlineResponse.text()).has_updates, true);
  assert.ok(Date.now() - offlineStartedAt >= 90);
  assert.equal(offline.calls.length, 0);
  assert.equal(offline.intercepted[0].reason, "offline");
});

test("Statsig net.fetch treats non-2xx and malformed initialize responses as fallback candidates", async (t) => {
  for (const fixture of [
    { body: "forbidden", reason: "http_403", status: 403 },
    { body: "server failure", reason: "http_500", status: 500 },
    { body: "not-json", reason: "malformed_response", status: 200 },
    { body: "{}", reason: "malformed_response", status: 200 },
    { body: "[]", reason: "malformed_response", status: 200 },
  ]) {
    const { hookedNet, intercepted } = createStatsigNetHarness(t, {
      fetch: async () => new Response(fixture.body, { status: fixture.status }),
    });
    const response = await hookedNet.fetch("https://ab.chatgpt.com/v1/initialize?k=x");
    const payload = JSON.parse(await response.text());
    assert.equal(payload.has_updates, true);
    assert.equal(intercepted.at(-1).reason, fixture.reason);
  }
});

test("Statsig net.fetch rejects external aborts without producing a synthetic response", async (t) => {
  const preAborted = createStatsigNetHarness(t, {
    fetch: async () => {
      throw new Error("pre-aborted fetch must not run");
    },
  });
  const preAbortController = new AbortController();
  preAbortController.abort();
  await assert.rejects(
    preAborted.hookedNet.fetch("https://ab.chatgpt.com/v1/initialize", {
      signal: preAbortController.signal,
    }),
    (error) => error?.name === "AbortError"
  );
  assert.equal(preAborted.calls.length, 0);
  assert.equal(preAborted.intercepted.length, 0);

  let nativeSignal = null;
  const inFlight = createStatsigNetHarness(t, {
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        nativeSignal = init.signal;
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
  });
  const controller = new AbortController();
  const pending = inFlight.hookedNet.fetch("https://ab.chatgpt.com/v1/initialize", {
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(nativeSignal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(inFlight.intercepted.length, 0, "external abort must cancel the fallback timer");

  const rejected = createStatsigNetHarness(t, {
    fetch: async () => {
      throw new Error("ECONNRESET");
    },
  });
  const rejectedController = new AbortController();
  const rejectedPending = rejected.hookedNet.fetch("https://ab.chatgpt.com/v1/initialize", {
    signal: rejectedController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  rejectedController.abort();
  await assert.rejects(rejectedPending, (error) => error?.name === "AbortError");
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(
    rejected.intercepted.length,
    0,
    "external abort must also cancel a fallback scheduled after network rejection"
  );
});

test("Statsig net.fetch timeout aborts the native request before returning fallback", async (t) => {
  let nativeSignal = null;
  const { hookedNet, intercepted } = createStatsigNetHarness(t, {
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        nativeSignal = init.signal;
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
  });
  const response = await hookedNet.fetch("https://ab.chatgpt.com/v1/initialize");
  assert.equal(nativeSignal.aborted, true);
  assert.equal((await response.json()).has_updates, true);
  assert.equal(intercepted.at(-1).reason, "timeout");
});

test("Statsig net.fetch preserves Request.signal when init has no signal property", async (t) => {
  for (const init of [{}, { headers: { "x-statsig-client": "test" } }]) {
    let nativeSignal = null;
    const harness = createStatsigNetHarness(t, {
      fetch: (_request, nativeInit) =>
        new Promise((_resolve, reject) => {
          nativeSignal = nativeInit.signal;
          nativeInit.signal.addEventListener("abort", () => reject(nativeInit.signal.reason), {
            once: true,
          });
        }),
    });
    const controller = new AbortController();
    const request = new Request("https://ab.chatgpt.com/v1/initialize", {
      method: "POST",
      signal: controller.signal,
    });
    const pending = harness.hookedNet.fetch(request, init);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === "AbortError");
    assert.equal(nativeSignal.aborted, true);
    assert.equal(harness.intercepted.length, 0);
  }
});

test("Statsig timing policy rejects invalid values and caps oversized environment values", () => {
  const safe = resolveStatsigNetworkPolicy({
    OPENCODEX_STATSIG_INITIALIZE_DELAY_MS: "invalid",
    OPENCODEX_STATSIG_INITIALIZE_TIMEOUT_MS: "",
  });
  assert.equal(safe.initializeDelayMs, 400);
  assert.equal(safe.initializeTimeoutMs, 2_500);
  assert.equal(safe.offlineFallback, false);

  const raceSafe = resolveStatsigNetworkPolicy({
    OPENCODEX_STATSIG_INITIALIZE_DELAY_MS: "0",
    OPENCODEX_STATSIG_INITIALIZE_TIMEOUT_MS: "-1",
  });
  assert.equal(raceSafe.initializeDelayMs, 100);
  assert.equal(raceSafe.initializeTimeoutMs, 2_500);

  const bounded = resolveStatsigNetworkPolicy({
    OPENCODEX_STATSIG_INITIALIZE_DELAY_MS: "999999",
    OPENCODEX_STATSIG_INITIALIZE_TIMEOUT_MS: "999999",
    OPENCODEX_STATSIG_OFFLINE_FALLBACK: "YES",
  });
  assert.equal(bounded.initializeDelayMs, 3_000);
  assert.equal(bounded.initializeTimeoutMs, 5_000);
  assert.equal(bounded.offlineFallback, true);
});

test("Statsig IPC coordinator preserves success and emits bounded fallback protocol", async () => {
  const clock = createFakeStatsigClock();
  const sent = [];
  const createCoordinator = (offlineFallback = false) =>
    createStatsigIpcFallbackCoordinator({
      policy: {
        initializeDelayMs: 100,
        initializeTimeoutMs: 200,
        offlineFallback,
      },
      sendFallback: (response, details) => {
        sent.push({ response, details });
        return true;
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  const channel = "message-from-view";
  const initializeMessage = {
    type: "fetch",
    requestId: "request-1",
    url: "https://ab.chatgpt.com/v1/initialize?k=x",
  };

  const online = createCoordinator();
  const successfulDispatch = online.beforeInvoke(channel, channel, [initializeMessage]);
  assert.equal(successfulDispatch.handled, false);
  assert.equal(successfulDispatch.kind, "initialize");
  assert.equal(successfulDispatch.requestId, "request-1");
  assert.ok(successfulDispatch.completion instanceof Promise);
  assert.deepEqual(
    online.observeOutgoing(channel, channel, [
      {
        type: "fetch-response",
        requestId: "request-1",
        responseType: "success",
        status: 200,
        bodyJsonString: '{"has_updates":false}',
      },
    ]),
    { suppress: false, requestId: "request-1" }
  );
  assert.equal(await successfulDispatch.completion, true);
  assert.equal(
    online.handlerFailed(successfulDispatch, new Error("late handler rejection")).alreadySettled,
    true
  );
  clock.advance(250);
  assert.equal(sent.length, 0, "a real success response must cancel the synthetic fallback");

  assert.equal(
    online.beforeInvoke(channel, channel, [
      { ...initializeMessage, requestId: "request-timeout" },
    ]).handled,
    false
  );
  clock.advance(199);
  assert.equal(sent.length, 0);
  clock.advance(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].response.type, "fetch-response");
  assert.equal(sent[0].response.responseType, "success");
  assert.equal(sent[0].response.requestId, "request-timeout");
  assert.equal(sent[0].response.status, 200);
  assert.deepEqual(sent[0].response.headers, {
    "content-type": "application/json; charset=utf-8",
  });
  const fallbackPayload = JSON.parse(sent[0].response.bodyJsonString);
  assert.equal(fallbackPayload.feature_gates["505458"].value, true);
  assert.equal(
    fallbackPayload.dynamic_configs.statsig_default_enable_features.value["505458"],
    true
  );
  assert.equal(sent[0].details.reason, "timeout");
  assert.deepEqual(
    online.observeOutgoing(channel, channel, [
      { type: "fetch-response", requestId: "request-timeout", responseType: "success" },
    ]),
    { suppress: true, requestId: "request-timeout" }
  );

  online.beforeInvoke(channel, channel, [
    { ...initializeMessage, requestId: "request-network-error" },
  ]);
  clock.advance(20);
  assert.deepEqual(
    online.observeOutgoing(channel, channel, [
      { type: "fetch-response", requestId: "request-network-error", responseType: "error" },
    ]),
    { suppress: true, requestId: "request-network-error" }
  );
  clock.advance(79);
  assert.equal(sent.length, 1);
  clock.advance(1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].details.reason, "network_error");

  const offline = createCoordinator(true);
  assert.equal(
    offline.beforeInvoke(channel, channel, [
      { ...initializeMessage, requestId: "request-offline" },
    ]).handled,
    true
  );
  clock.advance(99);
  assert.equal(sent.length, 2);
  clock.advance(1);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].details.reason, "offline");
});

test("Statsig IPC invalid initialize responses use the same 400ms fallback deadline", () => {
  for (const fixture of [
    { reason: "http_403", response: { status: 403, bodyJsonString: "{}" } },
    { reason: "http_500", response: { status: 500, bodyJsonString: "{}" } },
    { reason: "malformed_response", response: { status: 200, bodyJsonString: "not-json" } },
    { reason: "malformed_response", response: { status: 200, bodyJsonString: "{}" } },
    { reason: "malformed_response", response: { status: 200, bodyJsonString: "[]" } },
  ]) {
    const clock = createFakeStatsigClock();
    const sent = [];
    const coordinator = createStatsigIpcFallbackCoordinator({
      policy: { initializeDelayMs: 100, initializeTimeoutMs: 200, offlineFallback: false },
      sendFallback: (response, details) => {
        sent.push({ response, details });
        return true;
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const channel = "message-from-view";
    const dispatch = coordinator.beforeInvoke(channel, channel, [
      {
        type: "fetch",
        requestId: `invalid-${fixture.reason}`,
        url: "https://ab.chatgpt.com/v1/initialize",
      },
    ]);
    assert.equal(dispatch.handled, false);
    assert.deepEqual(
      coordinator.observeOutgoing(channel, channel, [
        {
          type: "fetch-response",
          requestId: dispatch.requestId,
          responseType: "success",
          ...fixture.response,
        },
      ]),
      { suppress: true, requestId: dispatch.requestId }
    );
    clock.advance(99);
    assert.equal(sent.length, 0);
    clock.advance(1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.reason, fixture.reason);
  }
});

test("Statsig IPC late failures only update reason and keep the first fallback deadline", () => {
  const clock = createFakeStatsigClock();
  const sent = [];
  const coordinator = createStatsigIpcFallbackCoordinator({
    policy: { initializeDelayMs: 100, initializeTimeoutMs: 300, offlineFallback: false },
    sendFallback: (response, details) => {
      sent.push({ response, details });
      return true;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const channel = "message-from-view";
  const dispatch = coordinator.beforeInvoke(channel, channel, [
    {
      type: "fetch",
      requestId: "immutable-deadline",
      url: "https://ab.chatgpt.com/v1/initialize",
    },
  ]);
  assert.equal(coordinator.pendingState(dispatch.requestId).deadlineAt, 100);

  clock.advance(40);
  coordinator.observeOutgoing(channel, channel, [
    { type: "fetch-response", requestId: dispatch.requestId, responseType: "error" },
  ]);
  clock.advance(30);
  coordinator.observeOutgoing(channel, channel, [
    {
      type: "fetch-response",
      requestId: dispatch.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: "{}",
    },
  ]);
  clock.advance(20);
  coordinator.handlerFailed(dispatch, new Error("late handler failure"));

  assert.deepEqual(
    {
      deadlineAt: coordinator.pendingState(dispatch.requestId).deadlineAt,
      dueAt: coordinator.pendingState(dispatch.requestId).dueAt,
      reason: coordinator.pendingState(dispatch.requestId).reason,
    },
    { deadlineAt: 100, dueAt: 100, reason: "handler_error" }
  );
  clock.advance(9);
  assert.equal(sent.length, 0);
  clock.advance(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].details.reason, "handler_error");
});

test("Statsig IPC handler rejection finalizes to one fallback response", async () => {
  const clock = createFakeStatsigClock();
  const sent = [];
  const coordinator = createStatsigIpcFallbackCoordinator({
    policy: { initializeDelayMs: 100, initializeTimeoutMs: 200, offlineFallback: false },
    sendFallback: (response, details) => {
      sent.push({ response, details });
      return true;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const channel = "message-from-view";
  const dispatch = coordinator.beforeInvoke(channel, channel, [
    {
      type: "fetch",
      requestId: "handler-rejected",
      url: "https://ab.chatgpt.com/v1/initialize",
    },
  ]);
  clock.advance(25);
  const handlerFailure = coordinator.handlerFailed(dispatch, new Error("handler rejected"));
  assert.equal(handlerFailure.handled, true);
  assert.equal(handlerFailure.requestId, "handler-rejected");
  assert.equal(coordinator.handlerFailed(dispatch, new Error("duplicate rejection")).handled, true);
  clock.advance(74);
  assert.equal(sent.length, 0);
  clock.advance(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].details.reason, "handler_error");
  assert.equal(await dispatch.completion, true);
  clock.advance(500);
  assert.equal(sent.length, 1, "handler rejection must not emit IPC error plus a later success");
});

test("Statsig IPC keeps failed fallback deliveries recoverable until a real send succeeds", async () => {
  const clock = createFakeStatsigClock();
  const attempts = [];
  const coordinator = createStatsigIpcFallbackCoordinator({
    policy: { initializeDelayMs: 100, initializeTimeoutMs: 200, offlineFallback: true },
    sendFallback: (response, details) => {
      attempts.push({ response, details });
      return attempts.length > 1;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const channel = "message-from-view";
  const dispatch = coordinator.beforeInvoke(channel, channel, [
    {
      type: "fetch",
      requestId: "send-retry",
      url: "https://ab.chatgpt.com/v1/initialize",
    },
  ]);
  assert.equal(dispatch.handled, true);

  clock.advance(100);
  assert.equal(attempts.length, 1);
  assert.deepEqual(coordinator.pendingState("send-retry"), {
    deliveryAttempts: 1,
    deliveryState: "pending",
    deadlineAt: 100,
    dueAt: 200,
    reason: "offline",
    timeoutAt: 200,
  });
  assert.equal(coordinator.failedDeliveryState("send-retry"), null);

  clock.advance(99);
  assert.equal(attempts.length, 1);
  clock.advance(1);
  assert.equal(attempts.length, 2);
  assert.equal(coordinator.pendingState("send-retry"), null);
  assert.equal(await dispatch.completion, true);
  assert.deepEqual(
    coordinator.observeOutgoing(channel, channel, [
      { type: "fetch-response", requestId: "send-retry", responseType: "success" },
    ]),
    { suppress: true, requestId: "send-retry" }
  );
});

test("Statsig IPC terminal delivery failure rejects the caller and only a real success clears its tombstone", async () => {
  const clock = createFakeStatsigClock();
  const attempts = [];
  const failures = [];
  const coordinator = createStatsigIpcFallbackCoordinator({
    policy: { initializeDelayMs: 100, initializeTimeoutMs: 200, offlineFallback: true },
    sendFallback: (response, details) => {
      attempts.push({ response, details });
      return false;
    },
    onDeliveryFailure: (failure) => failures.push(failure),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const channel = "message-from-view";
  const dispatch = coordinator.beforeInvoke(channel, channel, [
    {
      type: "fetch",
      requestId: "terminal-send",
      url: "https://ab.chatgpt.com/v1/initialize",
    },
  ]);
  assert.equal(dispatch.handled, true);

  clock.advance(300);
  assert.equal(attempts.length, 3);
  assert.equal(coordinator.pendingCount(), 0);
  assert.equal(failures.length, 1);
  await assert.rejects(
    dispatch.completion,
    (error) => error?.code === "STATSIG_FALLBACK_DELIVERY_FAILED"
  );
  const terminal = coordinator.terminalFailureState("terminal-send");
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.deliveryAttempts, 3);

  assert.deepEqual(
    coordinator.observeOutgoing(channel, channel, [
      { type: "fetch-response", requestId: "terminal-send", responseType: "error" },
    ]),
    { suppress: true, requestId: "terminal-send" }
  );
  assert.deepEqual(
    coordinator.observeOutgoing(channel, channel, [
      {
        type: "fetch-response",
        requestId: "terminal-send",
        responseType: "success",
        status: 200,
        bodyJsonString: "{}",
      },
    ]),
    { suppress: true, requestId: "terminal-send" }
  );
  assert.equal(coordinator.terminalFailureState("terminal-send").terminal, true);

  assert.deepEqual(
    coordinator.observeOutgoing(channel, channel, [
      {
        type: "fetch-response",
        requestId: "terminal-send",
        responseType: "success",
        status: 200,
        bodyJsonString: '{"has_updates":false}',
      },
    ]),
    { suppress: false, requestId: "terminal-send" }
  );
  assert.equal(coordinator.terminalFailureState("terminal-send"), null);
});

test("Statsig IPC exact matches swallow telemetry and pass all other fetch routes", () => {
  const clock = createFakeStatsigClock();
  const sent = [];
  const coordinator = createStatsigIpcFallbackCoordinator({
    policy: { initializeDelayMs: 100, initializeTimeoutMs: 200, offlineFallback: false },
    sendFallback: (response) => {
      sent.push(response);
      return true;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const channel = "message-from-view";

  assert.equal(
    coordinator.beforeInvoke(channel, channel, [
      { type: "fetch", requestId: "telemetry", url: "https://chatgpt.com/ces/v1/rgstr" },
    ]).handled,
    true
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].bodyJsonString, "{}");
  assert.equal(sent[0].requestId, "telemetry");

  for (const url of [
    "https://chatgpt.com/ces/v1/rgstr/extra",
    "https://chatgpt.com.example/ces/v1/rgstr",
    "https://example.com/ces/v1/log_event",
    "https://ab.chatgpt.com/v1/other",
  ]) {
    assert.equal(
      coordinator.beforeInvoke(channel, channel, [{ type: "fetch", requestId: "pass", url }]).handled,
      false,
      url
    );
  }
  assert.equal(sent.length, 1);
});

function createFakeMessageChannel() {
  class FakePort extends EventEmitter {
    constructor() {
      super();
      this.closed = false;
      this.messages = [];
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit("close");
    }

    postMessage(data) {
      this.messages.push(data);
    }

    start() {}
  }

  // 测试 relay 生命周期时使用内存端口，避免依赖真实 Electron 主进程。
  return { port1: new FakePort(), port2: new FakePort() };
}

test("attributes concurrent app-host cleanups to one relay at a time", async () => {
  const owner = new EventEmitter();
  const disposed = [];
  owner.on("destroyed", () => disposed.push("baseline"));

  let finishFirst;
  const firstCanFinish = new Promise((resolve) => {
    finishFirst = resolve;
  });
  let secondStarted = false;
  const first = __test.registerAppHostSession(owner, async () => {
    owner.once("destroyed", () => disposed.push("first"));
    await firstCanFinish;
  });
  const second = __test.registerAppHostSession(owner, () => {
    secondStarted = true;
    owner.once("destroyed", () => disposed.push("second"));
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  finishFirst();
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.equal(owner.listenerCount("destroyed"), 3);
  assert.equal(__test.releaseAppHostSession(firstSession), true);
  assert.deepEqual(disposed, ["first"]);
  assert.equal(owner.listenerCount("destroyed"), 2);

  assert.equal(__test.releaseAppHostSession(secondSession), true);
  assert.deepEqual(disposed, ["first", "second"]);
  assert.equal(owner.listenerCount("destroyed"), 1);
  assert.equal(__test.releaseAppHostSession(secondSession), false);
});

test("releases a partially registered app-host session after listener failure", async () => {
  const owner = new EventEmitter();
  const disposed = [];

  await assert.rejects(
    __test.registerAppHostSession(owner, () => {
      owner.once("destroyed", () => disposed.push("partial"));
      throw new Error("official listener failed");
    }),
    /official listener failed/
  );

  assert.deepEqual(disposed, ["partial"]);
  assert.equal(owner.listenerCount("destroyed"), 0);
});

test("keeps repeated app-host connection cycles within one owner baseline", async () => {
  const owner = new EventEmitter();
  let disposed = 0;
  owner.on("destroyed", () => {});

  for (let index = 0; index < 80; index += 1) {
    const session = await __test.registerAppHostSession(owner, () => {
      owner.once("destroyed", () => {
        disposed += 1;
      });
    });
    __test.releaseAppHostSession(session);
    assert.equal(owner.listenerCount("destroyed"), 1);
  }

  assert.equal(disposed, 80);
});

test("releases an app-host session resolved after its relay was replaced", async () => {
  const owner = new EventEmitter();
  const disposed = [];
  owner.once("destroyed", () => disposed.push("replaced"));
  const listener = owner.rawListeners("destroyed")[0];
  let finishConnect;
  const pendingConnect = new Promise((resolve) => {
    finishConnect = resolve;
  });
  const relay = createOfficialAppHostRelay({
    clientId: "client",
    portId: "port",
    connectPort: () => pendingConnect,
    createMessageChannel: createFakeMessageChannel,
  });

  relay.close("replaced");
  finishConnect({ listeners: [listener], owner, released: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(disposed, ["replaced"]);
  assert.equal(owner.listenerCount("destroyed"), 0);
});

test("releases an app-host session when its connected relay closes", async () => {
  const owner = new EventEmitter();
  const disposed = [];
  owner.once("destroyed", () => disposed.push("closed"));
  const listener = owner.rawListeners("destroyed")[0];
  const relay = createOfficialAppHostRelay({
    clientId: "client",
    portId: "port",
    connectPort: async () => ({ listeners: [listener], owner, released: false }),
    createMessageChannel: createFakeMessageChannel,
  });

  await new Promise((resolve) => setImmediate(resolve));
  relay.close("client_disconnected");

  assert.deepEqual(disposed, ["closed"]);
  assert.equal(owner.listenerCount("destroyed"), 0);
});

test("forwards structured official app-host messages and preserves close signals", () => {
  const forwarded = [];
  const closed = [];
  const payload = { id: 1n, sentAt: new Date(1234), value: new Uint8Array([1, 2]) };

  assert.equal(
    __test.deliverOfficialAppHostMessage(
      Object.create({ data: payload }),
      (data) => forwarded.push(data),
      (reason) => closed.push(reason)
    ),
    true
  );
  assert.equal(forwarded[0], payload);
  assert.deepEqual(closed, []);

  assert.equal(
    __test.deliverOfficialAppHostMessage(
      { data: undefined },
      (data) => forwarded.push(data),
      (reason) => closed.push(reason)
    ),
    true
  );
  assert.equal(forwarded[1], undefined);
  assert.deepEqual(closed, []);

  assert.equal(
    __test.deliverOfficialAppHostMessage(
      { data: null },
      (data) => forwarded.push(data),
      (reason) => closed.push(reason)
    ),
    false
  );
  assert.deepEqual(closed, ["official_closed"]);
});

function threadStreamStateMessage(conversationId, sourceClientId, change) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId,
    params: { conversationId, hostId: "local", change },
  };
}

test("bridges only the primary official renderer to the Web client", () => {
  const primary = { id: 1, isDestroyed: () => false };
  const samePrimaryWrapper = { id: 1, isDestroyed: () => false };
  const auxiliary = { id: 2, isDestroyed: () => false };

  assert.equal(__test.shouldBridgeOfficialWebContents(primary, null), true);
  assert.equal(__test.shouldBridgeOfficialWebContents(samePrimaryWrapper, primary), true);
  assert.equal(__test.shouldBridgeOfficialWebContents(auxiliary, primary), false);
  assert.equal(
    __test.shouldBridgeOfficialWebContents(auxiliary, { id: 1, isDestroyed: () => true }),
    true
  );
});

test("raises only a bounded listener budget for the hidden official renderer", () => {
  let maxListeners = 10;
  const webContents = {
    getMaxListeners: () => maxListeners,
    setMaxListeners: (value) => {
      maxListeners = value;
    },
  };

  assert.equal(__test.configureOfficialWebContentsListenerBudget(webContents), true);
  assert.equal(maxListeners, 64);
  assert.equal(__test.configureOfficialWebContentsListenerBudget(webContents), false);
  assert.equal(__test.configureOfficialWebContentsListenerBudget({}), false);
});

test("hidden app-server receives a bounded MCP startup budget", () => {
  const args = ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"];
  assert.deepEqual(__test.withHiddenAppServerMcpStartupBudget(args), [
    "-c",
    "features.code_mode_host=true",
    "-c",
    "mcp_servers.node_repl.startup_timeout_sec=5",
    "app-server",
    "--analytics-default-enabled",
  ]);
  assert.deepEqual(args, ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"]);
});

test("hidden app-server preserves explicit MCP startup timeouts", () => {
  const args = [
    "-c",
    "mcp_servers.node_repl.startup_timeout_sec=30",
    "app-server",
  ];
  assert.deepEqual(__test.withHiddenAppServerMcpStartupBudget(args), args);
});

test("bounds stalled official IPC routes and refreshes their LRU order", () => {
  const routes = new Map();
  const summaries = new Map();
  __test.storeBoundedRequestRoute(routes, summaries, "request-1", "client-1", { url: "/one" }, 2);
  __test.storeBoundedRequestRoute(routes, summaries, "request-2", "client-2", { url: "/two" }, 2);
  __test.storeBoundedRequestRoute(routes, summaries, "request-1", "client-1b", { url: "/one-new" }, 2);
  __test.storeBoundedRequestRoute(routes, summaries, "request-3", "client-3", { url: "/three" }, 2);

  assert.deepEqual(Array.from(routes.entries()), [
    ["request-1", "client-1b"],
    ["request-3", "client-3"],
  ]);
  assert.equal(summaries.has("request-2"), false);
  assert.equal(summaries.get("request-1").url, "/one-new");
});

test("bounds route id extraction across wide and cyclic IPC arguments", () => {
  assert.equal(__test.routeIdFromValue([{ payload: { requestId: "request-nested" } }]), "request-nested");
  let reads = 0;
  const wide = new Proxy(Array.from({ length: 50_000 }, () => ({})), {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(__test.routeIdFromValue(wide), "");
  assert.ok(reads > 0 && reads <= 256, `route scan read ${reads} array items`);
  const cyclic = {};
  cyclic.payload = cyclic;
  assert.equal(__test.routeIdFromValue(cyclic), "");
});

test("omits only a recoverable duplicate args copy from outgoing WebSocket envelopes", () => {
  const payload = { type: "mcp-notification", params: { apps: [1, 2, 3] } };

  assert.deepEqual(__test.outgoingWsEnvelope("message", [payload]), {
    channel: "message",
    payload,
  });
  assert.deepEqual(__test.outgoingWsEnvelope("message", []), {
    channel: "message",
    payload: null,
    args: [],
  });
  assert.deepEqual(__test.outgoingWsEnvelope("message", [undefined]), {
    channel: "message",
    payload: null,
    args: [undefined],
  });
  assert.deepEqual(__test.outgoingWsEnvelope("message", ["first", "second"]), {
    channel: "message",
    payload: ["first", "second"],
    args: ["first", "second"],
  });
});

test("compacts only renderer-unused app catalog subfields without mutating official payloads", () => {
  const entry = {
    id: "app-1",
    name: "App One",
    description: "kept",
    iconAssets: {
      "256_square": "square-light",
      "256_circle": "circle-light",
      original: "original-light",
    },
    iconDarkAssets: {
      "256_square": "square-dark",
      "256_circle": "circle-dark",
    },
    appMetadata: {
      categories: ["productivity"],
      firstPartyType: "first-party",
      review: { status: "approved" },
      screenshots: null,
    },
  };
  const payload = {
    type: "mcp-response",
    message: { id: "request-1", result: { data: [entry], nextCursor: null } },
  };

  const compacted = __test.compactOfficialAppCatalogPayload(
    "codex_desktop:message-for-view",
    payload,
    { requestMethod: "app/list" }
  );

  assert.notEqual(compacted, payload);
  assert.notEqual(compacted.message.result.data[0], entry);
  assert.deepEqual(compacted.message.result.data[0], {
    id: "app-1",
    name: "App One",
    description: "kept",
    iconAssets: { "256_square": "square-light" },
    iconDarkAssets: { "256_square": "square-dark" },
    appMetadata: {
      categories: ["productivity"],
      firstPartyType: "first-party",
    },
  });
  assert.equal(entry.iconAssets["256_circle"], "circle-light");
  assert.equal(entry.appMetadata.review.status, "approved");
  assert.equal(
    __test.compactOfficialAppCatalogPayload(
      "codex_desktop:message-for-view",
      payload,
      { requestMethod: "thread/list" }
    ),
    payload
  );
});

test("compacts full app catalog update notifications with the same renderer shape", () => {
  const payload = {
    type: "mcp-notification",
    method: "app/list/updated",
    params: {
      data: [
        {
          id: "app-2",
          iconAssets: { "256_square": "square", "256_circle": "circle" },
          iconDarkAssets: null,
          appMetadata: { categories: ["tools"], review: null },
        },
      ],
    },
  };

  const compacted = __test.compactOfficialAppCatalogPayload(
    "codex_desktop:message-for-view",
    payload
  );

  assert.deepEqual(compacted.params.data[0], {
    id: "app-2",
    iconAssets: { "256_square": "square" },
    iconDarkAssets: null,
    appMetadata: { categories: ["tools"] },
  });
  assert.equal(payload.params.data[0].iconAssets["256_circle"], "circle");
});

test("never broadcasts a targeted official response when its browser is offline", (t) => {
  const sends = [];
  const broadcasts = [];
  setWsHub({
    broadcast(payload) {
      broadcasts.push(payload);
      return 1;
    },
    sendTo(clientId, payload) {
      sends.push({ clientId, payload });
      return false;
    },
  });
  t.after(() => setWsHub(null));

  const delivered = requestContext.run({ clientId: "offline-client" }, () =>
    __test.routeOfficialWebContentsSend("fetch-response", [
      { type: "fetch-response", requestId: "offline-request", responseType: "success" },
    ])
  );

  assert.equal(delivered, false);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].clientId, "offline-client");
  assert.equal(broadcasts.length, 0);

  const hiddenRuntimeResponseDelivered = __test.routeOfficialWebContentsSend(
    "codex_desktop:message-for-view",
    [
      {
        type: "mcp-response",
        message: { id: "hidden-runtime-thread-list", result: { data: [] } },
      },
    ]
  );
  assert.equal(hiddenRuntimeResponseDelivered, false);
  assert.equal(broadcasts.length, 0);

  __test.routeOfficialWebContentsSend("account-updated", [{ type: "account-updated" }]);
  assert.equal(broadcasts.length, 1);
});

test("Statsig IPC synthetic responses bypass the outbound fallback observer", (t) => {
  const sends = [];
  setWsHub({
    broadcast() {
      return 0;
    },
    sendTo(clientId, payload) {
      sends.push({ clientId, payload });
      return true;
    },
  });
  t.after(() => setWsHub(null));

  const delivered = requestContext.run({ clientId: "statsig-client" }, () =>
    __test.routeOfficialWebContentsSend(
      "codex_desktop:message-for-view",
      [
        {
          type: "fetch-response",
          responseType: "success",
          requestId: "statsig-fallback-request",
          status: 200,
          bodyJsonString: "{}",
        },
      ],
      { id: 1, isDestroyed: () => false },
      "statsig-ipc-fallback"
    )
  );

  assert.equal(delivered, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].clientId, "statsig-client");
  assert.equal(sends[0].payload.payload.requestId, "statsig-fallback-request");
});

test("remote file manager interception condition is target and host based", () => {
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: false,
      openFileTarget: "fileManager",
    }),
    true
  );
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: true,
      openFileTarget: "fileManager",
    }),
    false
  );
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: false,
      openFileTarget: "vscode",
    }),
    false
  );
});

test("recognizes platform file manager spawn targets", () => {
  // macOS 官方实现用 open -R 定位文件；其它平台适配只负责提取路径，业务条件仍由统一 helper 判断。
  assert.equal(__test.fileManagerPathFromSpawn("open", ["-R", "/tmp/report.txt"]), "/tmp/report.txt");
  assert.equal(__test.fileManagerPathFromSpawn("open", ["/tmp/report.txt"]), "");
  assert.equal(__test.fileManagerPathFromSpawn("xdg-open", ["/tmp/report.txt"]), "/tmp/report.txt");
  assert.equal(__test.fileManagerPathFromSpawn("node", ["script.js"]), "");
});

test("recognizes app-server after official Codex global options", () => {
  // 官方 Desktop 会按版本在子命令前插入全局配置，hook 需要兼容两种参数布局。
  assert.equal(__test.isHiddenOfficialAppServerArgs(["app-server", "--analytics-default-enabled"]), true);
  assert.equal(
    __test.isHiddenOfficialAppServerArgs([
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
    ]),
    true
  );
  assert.equal(__test.isHiddenOfficialAppServerArgs(["exec", "app-server-like-value"]), false);
});

test("vscode fetch open-file payloads feed the same interception condition", () => {
  const openFileTarget = openFileTargetFromIpc("codex_desktop:message-from-view", {
    type: "fetch",
    url: "vscode://codex/open-file",
    body: JSON.stringify({ path: "/tmp/report.txt", target: "fileManager" }),
  });
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: false,
      openFileTarget,
    }),
    true
  );
});

test("falls back to read/write copy for WindowsApps encrypted runtime files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-runner-copy-"));
  const sourcePath = path.join(tmpDir, "chrome.dll");
  const targetPath = path.join(tmpDir, "runner", "chrome.dll");
  const previousCpSync = fs.cpSync;
  const logs = [];
  try {
    fs.writeFileSync(sourcePath, "encrypted-runtime-content");
    fs.cpSync = () => {
      const error = new Error("UNKNOWN: unknown error, copyfile");
      error.code = "UNKNOWN";
      throw error;
    };

    const result = portableRunnerTest.copyPortableRuntimeEntry({
      entry: {
        name: "chrome.dll",
        isFile: () => true,
      },
      sourcePath,
      targetPath,
      logger: (line) => logs.push(line),
      platform: "win32",
    });

    assert.deepEqual(result, { copied: true, synthesized: false });
    assert.equal(fs.readFileSync(targetPath, "utf8"), "encrypted-runtime-content");
    assert.match(logs.join(""), /read\/write fallback/);
  } finally {
    fs.cpSync = previousCpSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("falls back to recursive read/write copy for WindowsApps encrypted runtime directories", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-runner-dir-"));
  const sourcePath = path.join(tmpDir, "angledata");
  const targetPath = path.join(tmpDir, "runner", "angledata");
  const previousCpSync = fs.cpSync;
  const logs = [];
  try {
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "VkICD_mock_icd.json"), "{\"ok\":true}");
    fs.cpSync = () => {
      const error = new Error("UNKNOWN: unknown error, copyfile");
      error.code = "UNKNOWN";
      throw error;
    };

    const result = portableRunnerTest.copyPortableRuntimeEntry({
      entry: {
        name: "angledata",
        isFile: () => false,
        isDirectory: () => true,
      },
      sourcePath,
      targetPath,
      logger: (line) => logs.push(line),
      platform: "win32",
    });

    assert.deepEqual(result, { copied: true, synthesized: false });
    assert.equal(fs.readFileSync(path.join(targetPath, "VkICD_mock_icd.json"), "utf8"), "{\"ok\":true}");
    assert.match(logs.join(""), /Windows directory/);
  } finally {
    fs.cpSync = previousCpSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("falls back to read/write copy for WindowsApps encrypted runner executable", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-runner-exe-"));
  const sourcePath = path.join(tmpDir, "Codex.exe");
  const targetPath = path.join(tmpDir, "OpenCodex.exe");
  const previousCopyFileSync = fs.copyFileSync;
  try {
    fs.writeFileSync(sourcePath, "encrypted-exe-content");
    fs.copyFileSync = () => {
      const error = new Error("UNKNOWN: unknown error, copyfile");
      error.code = "UNKNOWN";
      throw error;
    };

    portableRunnerTest.copyPortableRuntimeExecutable({
      sourcePath,
      targetPath,
      platform: "win32",
    });

    assert.equal(fs.readFileSync(targetPath, "utf8"), "encrypted-exe-content");
  } finally {
    fs.copyFileSync = previousCopyFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sidebar bootstrap accepts only the synchronous renderer-safe shape", () => {
  const bootstrap = {
    catalogSnapshot: { revision: 7, isComplete: true, hosts: [], entries: [] },
    globalStateEntries: [{ key: "pinned-thread-ids", value: [] }],
    projectlessWorkspaceRoot: { workspaceRoot: null },
    workspaceRootOptions: [],
  };

  // 合法快照必须原样保留；Promise 或缺失数组字段都不能交给 renderer 同步遍历。
  assert.equal(__test.normalizeInitialSidebarBootstrap(bootstrap), bootstrap);
  assert.equal(__test.normalizeInitialSidebarBootstrap(Promise.resolve(bootstrap)), null);
  assert.equal(__test.normalizeInitialSidebarBootstrap({ globalStateEntries: {} }), null);
  assert.equal(__test.normalizeInitialSidebarBootstrap(null), null);
});

test("uses the Desktop named pipe on Windows", () => {
  assert.deepEqual(__test.officialDesktopIpcSocketPaths("win32"), ["\\\\.\\pipe\\codex-ipc"]);
  assert.match(__test.officialDesktopIpcSocketPaths("darwin")[0], /ipc[\\/]ipc\.sock$/);
});

test("official IPC parser handles fragmented headers and payloads", () => {
  const messages = [];
  const errors = [];
  const parser = createIpcFrameParser((message) => messages.push(message), (error) => errors.push(error));
  const first = encodeIpcFrame({ type: "first", payload: "x".repeat(32) });
  const second = encodeIpcFrame({ type: "second" });

  parser.consume(first.subarray(0, 2));
  parser.consume(first.subarray(2, 9));
  parser.consume(Buffer.concat([first.subarray(9), second]));

  assert.deepEqual(messages, [
    { type: "first", payload: "x".repeat(32) },
    { type: "second" },
  ]);
  assert.deepEqual(errors, []);
});

test("official observer caps reconnect backoff and treats an absent Desktop socket as expected", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((attempt) => observerTest.reconnectDelayForAttempt(5_000, 30_000, attempt)),
    [5_000, 10_000, 20_000, 30_000, 30_000]
  );
  assert.equal(observerTest.isExpectedSocketUnavailableError({ code: "ENOENT" }), true);
  assert.equal(observerTest.isExpectedSocketUnavailableError({ code: "ECONNREFUSED" }), true);
  assert.equal(observerTest.isExpectedSocketUnavailableError({ code: "EACCES" }), false);
});

test("official observer suppresses expected connection errors when Desktop is not running", () => {
  const { EventEmitter } = require("node:events");
  const errors = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.destroy = () => {
    socket.destroyed = true;
  };
  const observer = createOfficialLiveObserver({
    socketPaths: ["/tmp/missing-codex.sock"],
    socketFactory: () => socket,
    onError: (error) => errors.push(error),
    reconnectDelayMs: -1,
  });

  observer.start();
  socket.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));

  assert.deepEqual(errors, []);
  observer.stop();
});

test("sidebar bootstrap reconciles threads that are no longer visible", () => {
  const observer = createOfficialLiveObserver({ reconnectDelayMs: -1 });
  observer.observeSidebarBootstrap({
    catalogSnapshot: { entries: [{ threadId: "thread-old" }, { threadId: "thread-kept" }] },
  });
  observer.observeSidebarBootstrap({
    catalogSnapshot: { entries: [{ threadId: "thread-kept" }, { threadId: "thread-new" }] },
  });

  assert.deepEqual([...observer.__test.getKnownThreads().keys()], ["local\u0000thread-kept", "local\u0000thread-new"]);
  observer.stop();
});

test("official observer bounds known threads and unsubscribes the least recently used stream", () => {
  const { EventEmitter } = require("node:events");
  const writes = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.write = (frame) => writes.push(JSON.parse(frame.subarray(4).toString("utf8")));
  socket.destroy = () => {
    socket.destroyed = true;
  };
  const observer = createOfficialLiveObserver({
    socketPaths: ["/tmp/original-codex.sock"],
    socketFactory: () => socket,
    reconnectDelayMs: -1,
    maxKnownThreads: 2,
  });

  observer.start();
  socket.emit("connect");
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "response",
      method: "initialize",
      resultType: "success",
      handledByClientId: "observer-client",
    })
  );
  observer.observeThread("thread-one");
  observer.observeThread("thread-two");
  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: {
      conversationId: "thread-two",
      hostId: "local",
      change: { type: "snapshot", revision: 1 },
    },
  });
  // 再次观察 thread-one 会刷新 LRU，因此第三条线程应淘汰 thread-two。
  observer.observeThread("thread-one");
  observer.observeThread("thread-three");

  assert.deepEqual([...observer.__test.getKnownThreads().keys()], ["local\u0000thread-one", "local\u0000thread-three"]);
  assert.equal(observer.__test.getActiveOwners().has("local\u0000thread-two"), false);
  assert.deepEqual(
    writes
      .filter((message) => message.method === "thread-stream-following-changed")
      .slice(-2)
      .map((message) => [message.params.conversationId, message.params.following]),
    [["thread-two", false], ["thread-three", true]]
  );
  observer.stop();
});

test("official chunked messages are acknowledged and restored before browser routing", () => {
  const receiver = new __test.OfficialChunkedMessageReceiver();
  const marker = "codex-host-chunked-message-v1";

  const started = receiver.receive({
    marker,
    transferId: "transfer-1",
    sequence: 4,
    kind: "start",
  });
  assert.deepEqual(started, {
    type: "pending",
    acknowledgement: { transferId: "transfer-1", sequence: 4 },
  });

  const chunked = receiver.receive({
    marker,
    transferId: "transfer-1",
    sequence: 5,
    kind: "chunk",
    tokens: [
      { type: "object-start" },
      { type: "key", value: "type" },
      { type: "value", value: "fetch-response" },
      { type: "key", value: "body" },
      { type: "string-start", target: "value" },
      { type: "string-chunk", value: "large-" },
      { type: "string-chunk", value: "payload" },
      { type: "string-end" },
      { type: "key", value: "optional" },
      // 官方协议用缺失 value 字段表示 undefined，接收器必须保留而不是拒绝整个分块。
      { type: "value" },
      { type: "container-end" },
    ],
  });
  assert.deepEqual(chunked, {
    type: "pending",
    acknowledgement: { transferId: "transfer-1", sequence: 5 },
  });

  const completed = receiver.receive({
    marker,
    transferId: "transfer-1",
    sequence: 6,
    kind: "end",
  });
  assert.deepEqual(completed, {
    type: "complete",
    acknowledgement: { transferId: "transfer-1", sequence: 6 },
    message: { type: "fetch-response", body: "large-payload", optional: undefined },
  });
});

test("official chunk receiver rejects an out-of-order continuation without acknowledging it", () => {
  const receiver = new __test.OfficialChunkedMessageReceiver();
  const marker = "codex-host-chunked-message-v1";
  receiver.receive({ marker, transferId: "transfer-2", sequence: 0, kind: "start" });

  // 序号不连续时必须和官方 preload 一样停止确认，避免把已损坏的消息误组装后交给 renderer。
  assert.deepEqual(
    receiver.receive({
      marker,
      transferId: "transfer-2",
      sequence: 2,
      kind: "chunk",
      tokens: [{ type: "value", value: null }],
    }),
    { type: "pending", acknowledgement: null }
  );
});

test("official live observer follows known threads without sending control requests", () => {
  const { EventEmitter } = require("node:events");
  const writes = [];
  const published = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.write = (frame) => writes.push(JSON.parse(frame.subarray(4).toString("utf8")));
  socket.destroy = () => {
    socket.destroyed = true;
  };

  const observer = createOfficialLiveObserver({
    socketPaths: ["/tmp/original-codex.sock"],
    socketFactory: () => socket,
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.start();
  observer.observeThread("thread-known");
  socket.emit("connect");
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "response",
      method: "initialize",
      resultType: "success",
      handledByClientId: "observer-client",
    })
  );

  assert.deepEqual(
    writes.map((message) => message.method),
    ["initialize", "thread-stream-following-changed"]
  );
  assert.equal(writes.some((message) => String(message.method).startsWith("thread-follower-")), false);

  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner",
      params: {
        conversationId: "thread-known",
        hostId: "local",
        change: { type: "snapshot", revision: 1 },
      },
    })
  );
  assert.equal(published.at(-1).channel, "thread-stream-state-changed");
  assert.equal(observer.__test.getActiveOwners().get("local\u0000thread-known"), "desktop-owner");

  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-following-status-requested",
      sourceClientId: "desktop-owner",
      params: { conversationId: "thread-second", hostId: "local" },
    })
  );
  assert.equal(writes.at(-1).method, "thread-stream-following-changed");
  assert.equal(writes.at(-1).params.conversationId, "thread-second");
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner",
      params: {
        conversationId: "thread-second",
        hostId: "local",
        change: { type: "snapshot", revision: 1 },
      },
    })
  );
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "client-status-changed",
      params: { clientId: "desktop-owner", status: "disconnected" },
    })
  );
  assert.equal(observer.__test.getActiveOwners().size, 0);
  assert.equal(published.at(-1).channel, "client-status-changed");
  assert.equal(
    published.filter((payload) => payload.channel === "client-status-changed").length,
    1
  );
  observer.stop();
});

test("official live observer forwards reset and clears active owners when the IPC disconnects", () => {
  const { EventEmitter } = require("node:events");
  const published = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.write = () => true;
  socket.destroy = () => {
    socket.destroyed = true;
  };
  const observer = createOfficialLiveObserver({
    socketPaths: ["/tmp/original-codex.sock"],
    socketFactory: () => socket,
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.start();
  observer.observeThread("thread-known");
  socket.emit("connect");
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "response",
      method: "initialize",
      resultType: "success",
      handledByClientId: "observer-client",
    })
  );
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner",
      params: {
        conversationId: "thread-known",
        hostId: "local",
        change: { type: "snapshot", revision: 1 },
      },
    })
  );

  socket.emit("close");

  assert.equal(observer.__test.getActiveOwners().size, 0);
  assert.equal(published.at(-1).channel, "ipc-connection-reset");
  observer.stop();
});

test("bridges official thread list changes to recent conversation metadata invalidation", () => {
  const channel = "codex_desktop:message-for-view";
  const expected = { type: "query-cache-invalidate", queryKey: ["recent-conversations-meta"] };
  const startedArgs = [
    {
      type: "mcp-notification",
      hostId: "local",
      method: "thread/started",
      params: { thread: { id: "thread-1" } },
    },
  ];

  assert.deepEqual(__test.threadListInvalidationForOfficialMessage(channel, startedArgs, {}), expected);
  for (const method of [
    "thread/name",
    "thread/name/updated",
    "thread/archived",
    "thread/unarchived",
    "thread/deleted",
  ]) {
    assert.deepEqual(
      __test.threadListInvalidationForOfficialMessage(channel, [
        { type: "mcp-notification", method, params: { threadId: "thread-1" } },
      ]),
      expected
    );
  }
  assert.deepEqual(
    __test.threadListInvalidationForOfficialMessage(channel, [
      {
        type: "ipc-broadcast",
        method: "thread-stream-state-changed",
        params: { conversationId: "thread-2", change: { type: "snapshot" } },
      },
    ]),
    expected
  );
  assert.equal(
    __test.threadListInvalidationForOfficialMessage(channel, [
      {
        type: "ipc-broadcast",
        method: "thread-stream-state-changed",
        params: { conversationId: "thread-2", change: { type: "delta" } },
      },
    ]),
    null
  );
  assert.deepEqual(
    __test.threadListInvalidationForOfficialMessage(channel, [
      { type: "ipc-broadcast", method: "thread-archived", params: { conversationId: "thread-2" } },
    ]),
    expected
  );
});

test("uses the renderer-specific invalidation shape for Web and hidden native renderers", () => {
  const payload = {
    type: "ipc-broadcast",
    method: "query-cache-invalidate",
    params: { queryKey: ["recent-conversations-meta"] },
  };
  assert.deepEqual(__test.threadListInvalidationEnvelope(), {
    channel: "codex_desktop:message-for-view",
    payload,
  });
  assert.deepEqual(__test.threadListInvalidationRequest(), {
    type: "query-cache-invalidate",
    queryKey: ["recent-conversations-meta"],
  });
});

test("ignores an unknown thread stream patch", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: {
      conversationId: "thread-new",
      hostId: "local",
      change: { type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "replace" }] },
    },
  });

  assert.equal(published.length, 0);
  assert.equal(observer.__test.getKnownThreads().size, 0);
  assert.equal(observer.__test.getActiveOwners().size, 0);
  observer.stop();
});

test("accepts and tracks an unknown thread stream snapshot without replaying it on refresh", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });
  const snapshot = {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: {
      conversationId: "thread-new",
      hostId: "local",
      change: { type: "snapshot", revision: 1 },
    },
  };

  observer.__test.handleMessage(snapshot);

  assert.equal(observer.__test.getKnownThreads().has("local\u0000thread-new"), true);
  assert.equal(observer.__test.getActiveOwners().get("local\u0000thread-new"), "desktop-owner");
  observer.refresh();
  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    1
  );
  observer.stop();
});

test("ignores the first patches after an IPC reset until a fresh snapshot arrives", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-reset-patches", "desktop-owner", {
    type: "snapshot",
    revision: 7,
  }));
  observer.__test.handleMessage({
    type: "broadcast",
    method: "ipc-connection-reset",
    params: { reason: "peer-reset" },
  });
  observer.__test.handleMessage(threadStreamStateMessage("thread-reset-patches", "desktop-owner", {
    type: "patches",
    baseRevision: 7,
    revision: 8,
    patches: [{ op: "replace" }],
  }));

  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    1
  );
  observer.stop();
});

test("ignores patches whose baseRevision does not match the accepted snapshot", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-base-mismatch", "desktop-owner", {
    type: "snapshot",
    revision: 7,
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-base-mismatch", "desktop-owner", {
    type: "patches",
    baseRevision: 6,
    revision: 8,
    patches: [{ op: "replace" }],
  }));

  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    1
  );
  observer.stop();
});

test("ignores patches when no stream revision has been accepted", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-no-revision", "desktop-owner", {
    type: "snapshot",
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-no-revision", "desktop-owner", {
    type: "patches",
    baseRevision: undefined,
    revision: 1,
    patches: [{ op: "replace" }],
  }));

  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    1
  );
  observer.stop();
});

test("forwards matching patches and advances the accepted stream revision", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-revisions", "desktop-owner", {
    type: "snapshot",
    revision: 7,
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-revisions", "desktop-owner", {
    type: "patches",
    baseRevision: 7,
    revision: 8,
    patches: [{ op: "replace", path: "/status", value: "running" }],
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-revisions", "desktop-owner", {
    type: "patches",
    baseRevision: 8,
    revision: 9,
    patches: [{ op: "replace", path: "/status", value: "completed" }],
  }));

  const states = published.filter((payload) => payload.channel === "thread-stream-state-changed");
  assert.equal(states.length, 3);
  assert.equal(states.at(-1).payload.params.change.revision, 9);
  observer.stop();
});

test("ignores patches from a different stream owner", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-owner-mismatch", "desktop-owner", {
    type: "snapshot",
    revision: 7,
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-owner-mismatch", "other-owner", {
    type: "patches",
    baseRevision: 7,
    revision: 8,
    patches: [{ op: "replace" }],
  }));

  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    1
  );
  observer.stop();
});

test("owner disconnect clears the owner and forwards the disconnect", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: { conversationId: "thread-finished", change: { type: "snapshot" } },
  });
  observer.__test.handleMessage({
    type: "broadcast",
    method: "client-status-changed",
    params: { clientId: "desktop-owner", status: "disconnected" },
  });

  assert.equal(observer.__test.getActiveOwners().size, 0);
  assert.equal(published.at(-1).channel, "client-status-changed");
  observer.stop();
});

test("re-subscribes known threads after a peer reset without follower control requests", () => {
  const { EventEmitter } = require("node:events");
  const writes = [];
  const published = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.write = (frame) => writes.push(JSON.parse(frame.subarray(4).toString("utf8")));
  socket.destroy = () => {
    socket.destroyed = true;
  };
  const observer = createOfficialLiveObserver({
    socketPaths: ["/tmp/original-codex.sock"],
    socketFactory: () => socket,
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.start();
  observer.observeThread("thread-reset");
  socket.emit("connect");
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "response",
      method: "initialize",
      resultType: "success",
      handledByClientId: "observer-client",
    })
  );
  writes.length = 0;

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: { conversationId: "thread-reset", change: { type: "snapshot" } },
  });
  observer.__test.handleMessage({
    type: "broadcast",
    method: "ipc-connection-reset",
    params: { reason: "peer-reset" },
  });

  assert.equal(observer.__test.getActiveOwners().size, 0);
  assert.equal(published.at(-1).channel, "ipc-connection-reset");
  assert.deepEqual(writes.map((message) => message.method), ["thread-stream-following-changed"]);
  assert.equal(writes.some((message) => String(message.method).startsWith("thread-follower-")), false);
  const stateCount = published.filter((payload) => payload.channel === "thread-stream-state-changed").length;
  observer.refresh();
  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    stateCount
  );
  observer.stop();
});
