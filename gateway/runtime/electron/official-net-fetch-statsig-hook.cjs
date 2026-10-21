const {
  registerOfficialElectronModuleOverride,
} = require("./official-electron-module-hook.cjs");
const { diagnosticLog } = require("../core/diagnostics.cjs");
const {
  buildStatsigInitializeResponse,
  buildStatsigLocalBody,
  classifyStatsigRequestUrl,
  createStatsigAbortError,
  extractAbortSignalFromFetchArgs,
  preferNativeStatsigInitialize,
  resolveStatsigNetworkPolicy,
  validateStatsigInitializeNetResponse,
  waitForStatsigInitializeDelay,
  withStatsigAbortSignal,
} = require("./statsig-network-resilience.cjs");

// Electron main 的 net.fetch 是官方隐藏 renderer 所有 Statsig/遥测请求的最终出口。
// initialize 正常联网时必须保留真实响应；只有网络拒绝、超时或显式离线模式才使用合成配置。
// 遥测和 SDK 异常上报仍精确匹配后本地吞掉，其余 URL 与官方 net.fetch 完全一致。

function extractUrlFromNetFetchArgs(args) {
  const first = args && args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    if (typeof first.url === "string") return first.url;
    if (typeof first.href === "string") return first.href;
    try {
      return first.toString();
    } catch {
      return "";
    }
  }
  return "";
}

// 构造官方 httpFetch 能消费的响应；优先用全局 Response，缺失时退回最小鸭子类型形状。
function buildStatsigNetResponse(bodyJson, url, ResponseCtor) {
  if (ResponseCtor) {
    return new ResponseCtor(bodyJson, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const buffer = Buffer.from(bodyJson, "utf-8");
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
    json: async () => JSON.parse(bodyJson),
    text: async () => bodyJson,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function installOfficialNetFetchStatsigHook(electronModule, options = {}) {
  const onIntercept = typeof options.onIntercept === "function" ? options.onIntercept : null;
  const registerElectronOverride =
    typeof options.registerElectronOverride === "function"
      ? options.registerElectronOverride
      : registerOfficialElectronModuleOverride;
  // 测试可显式传入覆盖注册器，生产环境仍通过共享的 Electron require hook 注入 net 包装。
  const policy = resolveStatsigNetworkPolicy(process.env, {
    initializeDelayMs: options.initializeDelayMs,
    initializeTimeoutMs: options.initializeTimeoutMs,
    offlineFallback: options.offlineFallback,
  });
  const nativeNet = electronModule && electronModule.net;
  if (!nativeNet || typeof nativeNet.fetch !== "function") {
    return { installed: false, reason: "net.fetch unavailable" };
  }
  const nativeFetch = nativeNet.fetch.bind(nativeNet);
  const ResponseCtor = typeof Response === "function" ? Response : null;
  const hookedNet = Object.assign(Object.create(Object.getPrototypeOf(nativeNet)), nativeNet, {
    fetch(...args) {
      const url = extractUrlFromNetFetchArgs(args);
      const kind = classifyStatsigRequestUrl(url);
      if (!kind) return nativeFetch(...args);
      const externalSignal = extractAbortSignalFromFetchArgs(args);
      const startedAt = Date.now();
      const recordFallback = (reason) => {
        if (onIntercept) onIntercept(url, { kind, reason });
        diagnosticLog("statsig-net-fetch", "net_fetch_served_local", {
          kind,
          reason,
          url: String(url).split("?")[0],
        });
      };
      const deliverLocal = (reason = kind) => {
        recordFallback(reason);
        return buildStatsigNetResponse(buildStatsigLocalBody(kind), url, ResponseCtor);
      };

      if (kind !== "initialize") return Promise.resolve(deliverLocal());
      if (externalSignal?.aborted) return Promise.reject(createStatsigAbortError(externalSignal));
      if (policy.offlineFallback) {
        return waitForStatsigInitializeDelay(startedAt, policy.initializeDelayMs, {
          signal: externalSignal,
        }).then(() => deliverLocal("offline"));
      }

      const timeoutController = new AbortController();
      const nativeArgs = withStatsigAbortSignal(args, timeoutController.signal);
      let nativePromise;
      try {
        nativePromise = Promise.resolve(nativeFetch(...nativeArgs)).then(
          validateStatsigInitializeNetResponse
        );
      } catch (error) {
        nativePromise = Promise.reject(error);
      }
      return preferNativeStatsigInitialize({
        nativePromise,
        startedAt,
        delayMs: policy.initializeDelayMs,
        timeoutMs: policy.initializeTimeoutMs,
        fallbackFactory: (reason) => deliverLocal(reason),
        externalSignal,
        abortNative: (reason) => timeoutController.abort(reason),
      }).then((result) => result.response);
    },
  });
  registerElectronOverride(electronModule, "net", hookedNet);
  // 返回覆写后的 net 便于单测直接断言；线上官方代码通过 require("electron") 拿到同一包装对象。
  return { installed: true, net: hookedNet };
}

module.exports = {
  installOfficialNetFetchStatsigHook,
  __test: {
    buildStatsigInitializeNetResponse: buildStatsigInitializeResponse,
    classifyStatsigRequestUrl,
    resolveStatsigNetworkPolicy,
  },
};
