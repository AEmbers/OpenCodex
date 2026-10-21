const STATSIG_OFFLINE_FALLBACK_ENV = "OPENCODEX_STATSIG_OFFLINE_FALLBACK";
const STATSIG_INITIALIZE_DELAY_ENV = "OPENCODEX_STATSIG_INITIALIZE_DELAY_MS";
const STATSIG_INITIALIZE_TIMEOUT_ENV = "OPENCODEX_STATSIG_INITIALIZE_TIMEOUT_MS";

const DEFAULT_STATSIG_INITIALIZE_DELAY_MS = 400;
const MAX_STATSIG_INITIALIZE_DELAY_MS = 3_000;
const DEFAULT_STATSIG_INITIALIZE_TIMEOUT_MS = 2_500;
const MAX_STATSIG_INITIALIZE_TIMEOUT_MS = 5_000;
const STATSIG_IPC_FALLBACK_MAX_ENTRIES = 64;
const STATSIG_IPC_FALLBACK_TOMBSTONE_MAX_ENTRIES = 256;

const STATSIG_DEFAULT_FEATURES_CONFIG = "statsig_default_enable_features";
const STATSIG_I18N_LAYER_CONFIG = "72216192";
const STATSIG_I18N_LAYER_VALUES = { enable_i18n: true, locale_source: "IDE" };
// 这些 gate 是 Web/隐藏运行时缺少远端配置时也必须保留的基础能力，不能在离线降级时被清空。
const STATSIG_DEFAULT_FEATURE_OVERRIDES = {
  "3903742690": true,
  "505458": true,
  artifacts: true,
};

function boundedDuration(value, fallback, maxValue) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(maxValue, Math.trunc(parsed));
}

function parseTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

/**
 * 解析 Statsig 降级参数。延迟必须有下限，避免合成 initialize 在启动副作用注册前抢跑；
 * 超时和延迟都设上限，防止错误环境变量把整个首屏无限期挂起。
 */
function resolveStatsigNetworkPolicy(env = process.env, overrides = {}) {
  const delaySource =
    overrides.initializeDelayMs === undefined
      ? env?.[STATSIG_INITIALIZE_DELAY_ENV]
      : overrides.initializeDelayMs;
  const timeoutSource =
    overrides.initializeTimeoutMs === undefined
      ? env?.[STATSIG_INITIALIZE_TIMEOUT_ENV]
      : overrides.initializeTimeoutMs;
  const parsedDelay = boundedDuration(
    delaySource,
    DEFAULT_STATSIG_INITIALIZE_DELAY_MS,
    MAX_STATSIG_INITIALIZE_DELAY_MS
  );
  const parsedTimeout = boundedDuration(
    timeoutSource,
    DEFAULT_STATSIG_INITIALIZE_TIMEOUT_MS,
    MAX_STATSIG_INITIALIZE_TIMEOUT_MS
  );
  return Object.freeze({
    initializeDelayMs: Math.max(100, parsedDelay),
    initializeTimeoutMs: Math.max(100, parsedTimeout),
    offlineFallback:
      typeof overrides.offlineFallback === "boolean"
        ? overrides.offlineFallback
        : parseTruthyEnv(env?.[STATSIG_OFFLINE_FALLBACK_ENV]),
  });
}

function classifyStatsigRequestUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (parsed.hostname === "ab.chatgpt.com") {
    if (pathname === "/v1/initialize") return "initialize";
    if (pathname === "/v1/sdk_exception") return "sdk_exception";
    return "";
  }
  if (
    parsed.hostname === "chatgpt.com" &&
    (pathname === "/ces/v1/rgstr" || pathname === "/ces/v1/log_event")
  ) {
    return "telemetry";
  }
  return "";
}

function buildStatsigInitializeResponse() {
  const feature_gates = {};
  const dynamic_configs = {
    [STATSIG_DEFAULT_FEATURES_CONFIG]: {
      name: STATSIG_DEFAULT_FEATURES_CONFIG,
      value: { ...STATSIG_DEFAULT_FEATURE_OVERRIDES },
      rule_id: "gateway_override",
      secondary_exposures: [],
    },
  };
  for (const [name, value] of Object.entries(STATSIG_DEFAULT_FEATURE_OVERRIDES)) {
    feature_gates[name] = {
      name,
      value,
      rule_id: "gateway_override",
      secondary_exposures: [],
    };
  }
  return {
    has_updates: true,
    time: Date.now(),
    hash_used: "djb2",
    feature_gates,
    dynamic_configs,
    layer_configs: {
      [STATSIG_I18N_LAYER_CONFIG]: {
        name: STATSIG_I18N_LAYER_CONFIG,
        value: { ...STATSIG_I18N_LAYER_VALUES },
        rule_id: "gateway_override",
        secondary_exposures: [],
      },
    },
    param_stores: {},
    exposures: {},
    sdk_flags: {},
  };
}

function buildStatsigLocalBody(kind) {
  return kind === "initialize" ? JSON.stringify(buildStatsigInitializeResponse()) : "{}";
}

function buildStatsigFetchResponseMessage(message, kind) {
  const requestId = String(message?.requestId || "");
  if (!requestId) return null;
  return {
    type: "fetch-response",
    responseType: "success",
    requestId,
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyJsonString: buildStatsigLocalBody(kind),
  };
}

/**
 * initialize 优先等待真实响应；只有网络拒绝或超时才生成合成响应。
 * 合成响应仍等待至少 delayMs，保证官方路由完成必要的副作用注册。
 */
function preferNativeStatsigInitialize({
  nativePromise,
  startedAt,
  delayMs,
  timeoutMs,
  fallbackFactory,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutTimer = null;
    let fallbackTimer = null;

    const clearTimers = () => {
      if (timeoutTimer != null) clearTimer(timeoutTimer);
      if (fallbackTimer != null) clearTimer(fallbackTimer);
      timeoutTimer = null;
      fallbackTimer = null;
    };

    const finishNative = (response) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ fallback: false, reason: "", response });
    };

    const finishFallback = (reason, error = null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer != null) clearTimer(timeoutTimer);
      timeoutTimer = null;
      const remainingMs = Math.max(0, Number(startedAt) + delayMs - now());
      const deliver = () => {
        try {
          resolve({
            fallback: true,
            reason,
            error,
            response: fallbackFactory(reason, error),
          });
        } catch (fallbackError) {
          reject(fallbackError);
        }
      };
      if (remainingMs > 0) {
        fallbackTimer = setTimer(deliver, remainingMs);
        fallbackTimer?.unref?.();
      } else {
        deliver();
      }
    };

    timeoutTimer = setTimer(() => finishFallback("timeout"), timeoutMs);
    timeoutTimer?.unref?.();
    Promise.resolve(nativePromise).then(finishNative, (error) => {
      finishFallback("network_error", error);
    });
  });
}

function waitForStatsigInitializeDelay(startedAt, delayMs, options = {}) {
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const remainingMs = Math.max(0, Number(startedAt) + delayMs - now());
  return new Promise((resolve) => {
    if (remainingMs === 0) return resolve();
    const timer = setTimer(resolve, remainingMs);
    timer?.unref?.();
  });
}

function payloadFromIpcArgs(args) {
  if (!Array.isArray(args)) return args ?? null;
  return args.length <= 1 ? (args[0] ?? null) : args;
}

function fetchMessageFromIpcArgs(args) {
  const payload = payloadFromIpcArgs(args);
  if (!payload || typeof payload !== "object" || payload.type !== "fetch") return null;
  return typeof payload.url === "string" ? payload : null;
}

function fetchResponseFromIpcArgs(args) {
  const payload = payloadFromIpcArgs(args);
  if (!payload || typeof payload !== "object" || payload.type !== "fetch-response") return null;
  return payload;
}

/**
 * IPC 路径不能同步伪造 initialize：先让官方 handler 发真实请求，并由出站 fetch-response
 * 决定放行成功响应、取消超时兜底，还是在网络错误后延迟返回合成配置。
 */
function createStatsigIpcFallbackCoordinator({
  policy,
  sendFallback,
  onFallback = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  maxPending = STATSIG_IPC_FALLBACK_MAX_ENTRIES,
}) {
  const pending = new Map();
  const fallbackCompleted = new Map();

  function rememberFallbackCompleted(requestId) {
    fallbackCompleted.delete(requestId);
    fallbackCompleted.set(requestId, now());
    while (fallbackCompleted.size > STATSIG_IPC_FALLBACK_TOMBSTONE_MAX_ENTRIES) {
      fallbackCompleted.delete(fallbackCompleted.keys().next().value);
    }
  }

  function clearPending(requestId) {
    const entry = pending.get(requestId);
    if (!entry) return null;
    if (entry.timer != null) clearTimer(entry.timer);
    pending.delete(requestId);
    return entry;
  }

  function deliver(entry) {
    if (pending.get(entry.requestId) !== entry) return;
    if (entry.timer != null) clearTimer(entry.timer);
    pending.delete(entry.requestId);
    rememberFallbackCompleted(entry.requestId);
    const response = buildStatsigFetchResponseMessage(entry.message, "initialize");
    if (!response) return;
    try {
      onFallback({ kind: "initialize", reason: entry.reason, requestId: entry.requestId });
    } catch {}
    try {
      sendFallback(response, {
        kind: "initialize",
        reason: entry.reason,
        requestId: entry.requestId,
      });
    } catch {}
  }

  function schedule(entry) {
    if (pending.size >= maxPending) {
      // 异常页面可能制造大量悬空初始化；达到上限时先完成最老请求，保证定时器与路由状态有界。
      deliver(pending.values().next().value);
    }
    const previous = pending.get(entry.requestId);
    if (previous?.timer != null) clearTimer(previous.timer);
    const remainingMs = Math.max(0, entry.startedAt + entry.delayMs - now());
    entry.timer = setTimer(() => deliver(entry), remainingMs);
    entry.timer?.unref?.();
    pending.set(entry.requestId, entry);
  }

  function beforeInvoke(channel, messageChannel, args) {
    if (channel !== messageChannel) return { handled: false };
    const message = fetchMessageFromIpcArgs(args);
    if (!message) return { handled: false };
    const kind = classifyStatsigRequestUrl(message.url);
    if (!kind) return { handled: false };
    const response = buildStatsigFetchResponseMessage(message, kind);
    if (!response) return { handled: false };

    if (kind !== "initialize") {
      try {
        onFallback({ kind, reason: kind, requestId: response.requestId });
      } catch {}
      try {
        sendFallback(response, { kind, reason: kind, requestId: response.requestId });
      } catch {}
      return { handled: true, kind, requestId: response.requestId };
    }

    const startedAt = now();
    const entry = {
      delayMs: policy.initializeDelayMs,
      message,
      reason: policy.offlineFallback ? "offline" : "timeout",
      requestId: response.requestId,
      startedAt,
      timer: null,
    };
    if (policy.offlineFallback) {
      schedule(entry);
      return { handled: true, kind, requestId: entry.requestId };
    }

    // 在线模式继续调用官方 handler；仅登记超时兜底，真实成功响应会在出站阶段取消它。
    entry.delayMs = Math.max(policy.initializeTimeoutMs, policy.initializeDelayMs);
    schedule(entry);
    return { handled: false, kind, requestId: entry.requestId };
  }

  function observeOutgoing(channel, messageChannel, args) {
    if (channel !== messageChannel) return { suppress: false };
    const response = fetchResponseFromIpcArgs(args);
    const requestId = String(response?.requestId || "");
    if (!requestId) return { suppress: false };
    if (fallbackCompleted.has(requestId)) return { suppress: true, requestId };
    const entry = pending.get(requestId);
    if (!entry) return { suppress: false };

    if (response.responseType === "success") {
      clearPending(requestId);
      return { suppress: false, requestId };
    }

    /**
     * 官方 fetch-response 的 error 表示传输层失败；此时不能把错误放给 Statsig 触发重试，
     * 应在防竞态延迟后改用合成初始化响应。
     */
    clearPending(requestId);
    schedule({
      ...entry,
      reason: "network_error",
      delayMs: Math.max(entry.startedAt + policy.initializeDelayMs - now(), 0),
      startedAt: now(),
      timer: null,
    });
    return { suppress: true, requestId };
  }

  function dispose() {
    for (const entry of pending.values()) {
      if (entry.timer != null) clearTimer(entry.timer);
    }
    pending.clear();
    fallbackCompleted.clear();
  }

  return {
    beforeInvoke,
    observeOutgoing,
    dispose,
    pendingCount: () => pending.size,
  };
}

module.exports = {
  DEFAULT_STATSIG_INITIALIZE_DELAY_MS,
  DEFAULT_STATSIG_INITIALIZE_TIMEOUT_MS,
  MAX_STATSIG_INITIALIZE_DELAY_MS,
  MAX_STATSIG_INITIALIZE_TIMEOUT_MS,
  STATSIG_OFFLINE_FALLBACK_ENV,
  STATSIG_INITIALIZE_DELAY_ENV,
  STATSIG_INITIALIZE_TIMEOUT_ENV,
  buildStatsigFetchResponseMessage,
  buildStatsigInitializeResponse,
  buildStatsigLocalBody,
  classifyStatsigRequestUrl,
  createStatsigIpcFallbackCoordinator,
  parseTruthyEnv,
  preferNativeStatsigInitialize,
  resolveStatsigNetworkPolicy,
  waitForStatsigInitializeDelay,
};
