const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const asar = require("@electron/asar");
const { realpathSafe } = require("../shared/fs-utils.cjs");
const { logJsonLine } = require("../shared/logging.cjs");

function asarHeaderSha256(asarPath) {
  const rawHeader = asar.getRawHeader(asarPath);
  return crypto.createHash("sha256").update(rawHeader.headerString).digest("hex");
}

function loadResedit() {
  try {
    return require("resedit");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    throw new Error(`Windows runner 需要 resedit 来修正 ElectronAsar integrity resource：${message}`);
  }
}

function assertWindowsRunnerPatchTarget({ runnerRootDir, runnerExecutablePath, sourceExecutablePath }) {
  const relative = path.relative(runnerRootDir, runnerExecutablePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`拒绝 patch runner 根目录外的可执行文件：${runnerExecutablePath}`);
  }
  const sourceRealPath = realpathSafe(sourceExecutablePath).toLowerCase();
  const runnerRealPath = realpathSafe(runnerExecutablePath).toLowerCase();
  if (sourceRealPath === runnerRealPath) {
    throw new Error(`拒绝 patch 官方 Codex/ChatGPT Desktop 安装目录里的可执行文件：${runnerExecutablePath}`);
  }
}

function isElectronAsarIntegrityEntry(entry) {
  return String(entry.type).toUpperCase() === "INTEGRITY" && String(entry.id).toUpperCase() === "ELECTRONASAR";
}

function stripWindowsSxSNumericDependencies(manifestText) {
  /**
   * MSIX 里的 Chromium 主程序会把内部 chrome_elf 版本声明成 side-by-side 程序集。
   * 复制到用户目录后该程序集不再由包清单注册，Windows 会把 exe 判为并行配置错误。
   * chrome_elf.dll 仍被 exe 直接导入，因此只移除无 publicKeyToken 的纯数字程序集依赖。
   */
  return String(manifestText || "").replace(/<dependency\b[^>]*>[\s\S]*?<\/dependency>/gi, (dependency) => {
    const identity = dependency.match(/<assemblyIdentity\b[^>]*\bname\s*=\s*(["'])(.*?)\1[^>]*>/i);
    if (!identity) return dependency;
    const assemblyName = identity[2].trim();
    const isNumericAssembly = /^\d+(?:\.\d+)+$/.test(assemblyName);
    const hasPublisherToken = /\bpublicKeyToken\s*=/i.test(dependency);
    return isNumericAssembly && !hasPublisherToken ? "" : dependency;
  });
}

function patchWindowsRunnerAsarIntegrity({ runnerRootDir, runnerExecutablePath, sourceExecutablePath, runnerAsarPath, logger }) {
  if (process.platform !== "win32") return;
  assertWindowsRunnerPatchTarget({ runnerRootDir, runnerExecutablePath, sourceExecutablePath });
  const { NtExecutable, NtExecutableResource } = loadResedit();
  const headerHash = asarHeaderSha256(runnerAsarPath);
  const resourceValue = JSON.stringify([
    {
      file: "resources\\app.asar",
      alg: "sha256",
      value: headerHash,
    },
  ]);

  /**
   * Electron 的 Windows ASAR integrity 存在 PE resource 里，而不是 app.asar 自身。
   * 这里只修改 OpenCodex 运行态里的 exe 副本；官方安装目录始终只读，避免影响 Codex/ChatGPT Desktop。
   */
  const exeData = fs.readFileSync(runnerExecutablePath);
  const exe = NtExecutable.from(exeData, { ignoreCert: true });
  const resources = NtExecutableResource.from(exe);
  const existingEntries = resources.entries.filter(isElectronAsarIntegrityEntry);
  const lang = existingEntries.length > 0 ? existingEntries[0].lang : 1033;
  /**
   * Electron Packager 写入的是全大写 INTEGRITY/ELECTRONASAR。resedit 内部按字符串严格匹配，
   * 如果只写 camel-case，会和官方原有 resource 并存，Electron 仍可能先读旧 hash。
   */
  resources.entries = resources.entries.filter((entry) => !isElectronAsarIntegrityEntry(entry));
  resources.replaceResourceEntryFromString("INTEGRITY", "ELECTRONASAR", lang, resourceValue);

  // 修复 Windows MSIX 复制件对 Chromium 私有 SxS 程序集的错误依赖，避免 spawn UNKNOWN / 并行配置错误。
  let sxSManifestPatched = false;
  for (const entry of resources.entries.filter((item) => Number(item.type) === 24 && Number(item.id) === 1)) {
    const manifestText = Buffer.from(entry.bin).toString("utf8");
    const repairedManifest = stripWindowsSxSNumericDependencies(manifestText);
    if (repairedManifest === manifestText) continue;
    resources.replaceResourceEntryFromString(24, 1, entry.lang, repairedManifest);
    sxSManifestPatched = true;
  }

  resources.outputResource(exe);
  fs.writeFileSync(runnerExecutablePath, Buffer.from(exe.generate()));
  logJsonLine(logger, "patched Windows ElectronAsar integrity:", {
    executablePath: runnerExecutablePath,
    asarPath: runnerAsarPath,
    headerSha256: headerHash,
    lang,
    sxSManifestPatched,
  });
}

module.exports = {
  patchWindowsRunnerAsarIntegrity,
  stripWindowsSxSNumericDependencies,
};
