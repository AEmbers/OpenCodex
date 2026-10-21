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

function createStatsigAbortError(signal) {
  const reason = signal?.reason;
  if (reason && typeof reason === "object" && reason.name === "AbortError") return reason;
  if (typeof DOMException === "function") {
    return new DOMException("This operation was aborted", "AbortError");
  }
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function statsigResponseError(reason, message) {
  const error = new Error(message || reason);
  error.statsigFallbackReason = reason;
  return error;
}

function extractAbortSignalFromFetchArgs(args) {
  const first = args?.[0];
  const init = args?.[1];
  const signal = init && typeof init === "object" ? init.signal : first?.signal;
  return signal && typeof signal.addEventListener === "function" ? signal : null;
}

function withStatsigAbortSignal(args, signal) {
  const first = args?.[0];
  const init = args?.[1];
  const nextInit =
    init && typeof init === "object"
      ? { ...init, signal }
      : { signal };
  return [first, nextInit, ...args.slice(2)];
}

// Statsig 初始化必须返回带 has_updates 的 JSON 对象；数组、空 body 和任意错误对象都不能冒充成功。
function isConsumableStatsigInitializeJson(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.has_updates === "boolean"
  );
}

function isConsumableStatsigInitializeFetchResponse(response) {
  const status = Number(response?.status);
  if (!Number.isInteger(status) || status < 200 || status >= 300) return false;
  if (typeof response?.bodyJsonString !== "string") return false;
  try {
    return isConsumableStatsigInitializeJson(JSON.parse(response.bodyJsonString));
  } catch {
    return false;
  }
}

async function validateStatsigInitializeNetResponse(response) {
  const status = Number(response?.status);
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw statsigResponseError(`http_${Number.isInteger(status) ? status : "unknown"}`, "Statsig initialize returned a non-2xx response");
  }
  let payload;
  try {
    if (!response || typeof response.clone !== "function") throw new Error("response cannot be cloned");
    payload = await response.clone().json();
  } catch {
    throw statsigResponseError("malformed_response", "Statsig initialize returned malformed JSON");
  }
  if (!isConsumableStatsigInitializeJson(payload)) {
    throw statsigResponseError("malformed_response", "Statsig initialize returned an unusable JSON value");
  }
  return response;
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
  externalSignal = null,
  abortNative = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (externalSignal?.aborted) return Promise.reject(createStatsigAbortError(externalSignal));
  return new Promise((resolve, reject) => {
    let finished = false;
    let fallbackScheduled = false;
    let timeoutTimer = null;
    let fallbackTimer = null;
    let externalAbortListener = null;

    const clearTimers = () => {
      if (timeoutTimer != null) clearTimer(timeoutTimer);
      if (fallbackTimer != null) clearTimer(fallbackTimer);
      timeoutTimer = null;
      fallbackTimer = null;
    };

    const cleanup = () => {
      clearTimers();
      if (externalSignal && externalAbortListener) {
        externalSignal.removeEventListener?.("abort", externalAbortListener);
      }
      externalAbortListener = null;
    };

    const finishNative = (response) => {
      if (finished || fallbackScheduled) return;
      finished = true;
      cleanup();
      resolve({ fallback: false, reason: "", response });
    };

    const finishFallback = (reason, error = null) => {
      if (finished || fallbackScheduled) return;
      fallbackScheduled = true;
      if (reason === "timeout") {
        try {
          abortNative(statsigResponseError("timeout", "Statsig initialize timed out"));
        } catch {}
      }
      if (timeoutTimer != null) clearTimer(timeoutTimer);
      timeoutTimer = null;
      const remainingMs = Math.max(0, Number(startedAt) + delayMs - now());
      const deliver = () => {
        if (finished) return;
        finished = true;
        cleanup();
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

    const finishExternalAbort = () => {
      if (finished) return;
      finished = true;
      const error = createStatsigAbortError(externalSignal);
      try {
        abortNative(error);
      } catch {}
      cleanup();
      reject(error);
    };

    if (externalSignal) {
      if (externalSignal.aborted) {
        finishExternalAbort();
        return;
      }
      externalAbortListener = finishExternalAbort;
      externalSignal.addEventListener("abort", externalAbortListener, { once: true });
      if (externalSignal.aborted) {
        finishExternalAbort();
        return;
      }
    }
    timeoutTimer = setTimer(() => finishFallback("timeout"), timeoutMs);
    timeoutTimer?.unref?.();
    Promise.resolve(nativePromise).then(finishNative, (error) => {
      finishFallback(error?.statsigFallbackReason || "network_error", error);
    });
  });
}

function waitForStatsigInitializeDelay(startedAt, delayMs, options = {}) {
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const signal = options.signal || null;
  if (signal?.aborted) return Promise.reject(createStatsigAbortError(signal));
  const remainingMs = Math.max(0, Number(startedAt) + delayMs - now());
  return new Promise((resolve, reject) => {
    if (remainingMs === 0) return resolve();
    let abortListener = null;
    const cleanup = () => {
      if (signal && abortListener) signal.removeEventListener?.("abort", abortListener);
      abortListener = null;
    };
    const timer = setTimer(() => {
      cleanup();
      resolve();
    }, remainingMs);
    timer?.unref?.();
    if (signal) {
      abortListener = () => {
        clearTimer(timer);
        cleanup();
        reject(createStatsigAbortError(signal));
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    }
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
 * sendFallback 必须返回布尔送达结果；false 会保留 pending 并执行有界重试，不能提前写成功状态。
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
  const successCompleted = new Map();
  const failedDeliveries = new Map();
  const maxDeliveryAttempts = 3;

  function rememberFallbackCompleted(requestId) {
    fallbackCompleted.delete(requestId);
    fallbackCompleted.set(requestId, now());
    while (fallbackCompleted.size > STATSIG_IPC_FALLBACK_TOMBSTONE_MAX_ENTRIES) {
      fallbackCompleted.delete(fallbackCompleted.keys().next().value);
    }
  }

  function rememberSuccessCompleted(requestId) {
    successCompleted.delete(requestId);
    successCompleted.set(requestId, now());
    while (successCompleted.size > STATSIG_IPC_FALLBACK_TOMBSTONE_MAX_ENTRIES) {
      successCompleted.delete(successCompleted.keys().next().value);
    }
  }

  function clearPending(requestId) {
    const entry = pending.get(requestId);
    if (!entry) return null;
    if (entry.timer != null) clearTimer(entry.timer);
    pending.delete(requestId);
    return entry;
  }

  function rememberFailedDelivery(entry) {
    failedDeliveries.delete(entry.requestId);
    failedDeliveries.set(entry.requestId, {
      deliveryFailures: entry.deliveryFailures || 1,
      kind: entry.kind || "initialize",
      message: entry.message,
      reason: entry.reason,
      recordedAt: now(),
      requestId: entry.requestId,
    });
    while (failedDeliveries.size > STATSIG_IPC_FALLBACK_TOMBSTONE_MAX_ENTRIES) {
      failedDeliveries.delete(failedDeliveries.keys().next().value);
    }
  }

  function trySendResponse(response, details) {
    let delivered = false;
    try {
      delivered = sendFallback(response, details) === true;
    } catch {}
    if (delivered) {
      try {
        onFallback(details);
      } catch {}
    }
    return delivered;
  }

  function deliver(entry) {
    if (pending.get(entry.requestId) !== entry) return false;
    if (entry.timer != null) clearTimer(entry.timer);
    entry.timer = null;
    const response = buildStatsigFetchResponseMessage(entry.message, "initialize");
    if (!response) {
      rememberFailedDelivery({ ...entry, deliveryFailures: 1 });
      clearPending(entry.requestId);
      return false;
    }
    const delivered = trySendResponse(response, {
      kind: "initialize",
      reason: entry.reason,
      requestId: entry.requestId,
    });
    if (delivered) {
      clearPending(entry.requestId);
      fallbackCompleted.delete(entry.requestId);
      rememberFallbackCompleted(entry.requestId);
      return true;
    }

    entry.deliveryFailures = (entry.deliveryFailures || 0) + 1;
    entry.deliveryState = "delivery_failed";
    rememberFailedDelivery(entry);
    if (entry.deliveryFailures < maxDeliveryAttempts && pending.get(entry.requestId) === entry) {
      schedule(entry, now() + policy.initializeDelayMs);
    }
    return false;
  }

  function schedule(entry, dueAt = entry.startedAt + entry.delayMs) {
    while (pending.size >= maxPending) {
      // 达到上限时先尝试完成最老请求；若投递失败则把状态移入有界可恢复记录，避免无限占位。
      const oldest = pending.values().next().value;
      if (!oldest || deliver(oldest)) break;
      if (pending.get(oldest.requestId) === oldest) {
        const failed = clearPending(oldest.requestId);
        if (failed) rememberFailedDelivery(failed);
      }
    }
    const previous = pending.get(entry.requestId);
    if (previous?.timer != null) clearTimer(previous.timer);
    const remainingMs = Math.max(0, dueAt - now());
    entry.deliveryState = "pending";
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
      const delivered = trySendResponse(response, {
        kind,
        reason: kind,
        requestId: response.requestId,
      });
      if (!delivered) {
        rememberFailedDelivery({
          deliveryFailures: 1,
          kind,
          message,
          reason: kind,
          requestId: response.requestId,
        });
      }
      return {
        handled: delivered,
        deliveryFailed: !delivered,
        kind,
        requestId: response.requestId,
      };
    }

    const startedAt = now();
    const entry = {
      delayMs: policy.initializeDelayMs,
      message,
      reason: policy.offlineFallback ? "offline" : "timeout",
      requestId: response.requestId,
      startedAt,
      timer: null,
      deliveryFailures: 0,
      deliveryState: "pending",
      kind: "initialize",
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

    if (
      response.responseType === "success" &&
      isConsumableStatsigInitializeFetchResponse(response)
    ) {
      clearPending(requestId);
      rememberSuccessCompleted(requestId);
      return { suppress: false, requestId };
    }

    /**
     * 官方 fetch-response 的 error 表示传输层失败；此时不能把错误放给 Statsig 触发重试，
     * 应在防竞态延迟后改用合成初始化响应。
     */
    const status = Number(response.status);
    entry.reason =
      response.responseType === "success"
        ? Number.isInteger(status) && (status < 200 || status >= 300)
          ? `http_${status}`
          : "malformed_response"
        : "network_error";
    entry.delayMs = Math.max(entry.startedAt + policy.initializeDelayMs - now(), 0);
    entry.startedAt = now();
    schedule(entry);
    return { suppress: true, requestId };
  }

  function handlerFailed(dispatch, error) {
    const requestId = String(dispatch?.requestId || "");
    if (fallbackCompleted.has(requestId) || successCompleted.has(requestId)) {
      return { handled: true, alreadySettled: true, requestId };
    }
    const entry = requestId ? pending.get(requestId) : null;
    if (!entry) return { handled: false, requestId };
    // 已经由网络错误、非法响应或前一次 handler failure 排好的统一 deadline 不能被重复延后。
    if (entry.reason !== "timeout") {
      return { handled: true, alreadyScheduled: true, requestId };
    }
    entry.reason = "handler_error";
    entry.errorMessage = error instanceof Error ? error.message : String(error || "");
    entry.delayMs = Math.max(entry.startedAt + policy.initializeDelayMs - now(), 0);
    entry.startedAt = now();
    schedule(entry);
    return { handled: true, requestId };
  }

  function finalizeRequest(requestId) {
    return clearPending(String(requestId || ""));
  }

  function dispose() {
    for (const entry of pending.values()) {
      if (entry.timer != null) clearTimer(entry.timer);
    }
    pending.clear();
    fallbackCompleted.clear();
    successCompleted.clear();
    failedDeliveries.clear();
  }

  return {
    beforeInvoke,
    finalizeRequest,
    handlerFailed,
    observeOutgoing,
    dispose,
    pendingCount: () => pending.size,
    pendingState: (requestId) => {
      const entry = pending.get(String(requestId || ""));
      return entry
        ? {
            deliveryFailures: entry.deliveryFailures || 0,
            deliveryState: entry.deliveryState,
            reason: entry.reason,
          }
        : null;
    },
    failedDeliveryState: (requestId) => failedDeliveries.get(String(requestId || "")) || null,
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
  createStatsigAbortError,
  createStatsigIpcFallbackCoordinator,
  extractAbortSignalFromFetchArgs,
  isConsumableStatsigInitializeFetchResponse,
  isConsumableStatsigInitializeJson,
  parseTruthyEnv,
  preferNativeStatsigInitialize,
  resolveStatsigNetworkPolicy,
  validateStatsigInitializeNetResponse,
  waitForStatsigInitializeDelay,
  withStatsigAbortSignal,
};
