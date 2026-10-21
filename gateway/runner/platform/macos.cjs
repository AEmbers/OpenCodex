const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const asar = require("@electron/asar");
const { execFileSync } = require("child_process");
const {
  RUNNER_APP_NAME,
  RUNNER_BUNDLE_IDENTIFIER,
  RUNNER_EXECUTABLE_NAME,
} = require("../shared/constants.cjs");
const {
  fileFingerprint,
  isDirectory,
  realpathSafe,
  readJsonIfPresent,
  withPhysicalAsarAccess,
  writeJson,
} = require("../shared/fs-utils.cjs");
const { logLine } = require("../shared/logging.cjs");
const { writeGatewayAsar } = require("../shared/runner-asar.cjs");
const { pathIsInside, refreshMacIntegrity } = require("./macos-integrity.cjs");
const { runner: runnerPoints } = require("../../runtime/modification/point-refs.cjs");

function escapePlistString(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function runnerInfoPlist(runnerAsarPath) {
  // 新版官方 Electron 会校验 ASAR header；必须读取本次生成的 runner，不能沿用官方包或旧缓存的哈希。
  const header = withPhysicalAsarAccess(() => asar.getRawHeader(runnerAsarPath).headerString);
  const headerHash = crypto.createHash("sha256").update(header).digest("hex");
  /**
   * runner 是后台 gateway 进程，不应该在 Dock 里出现第二个图标。
   * LSUIElement 会让当前官方 Electron runtime 在 ChromeMain 阶段 SIGTRAP；
   * LSBackgroundOnly 可以让进程成为真正的后台进程，同时仍能创建隐藏 webContents 承接官方 IPC。
   */
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${escapePlistString(RUNNER_EXECUTABLE_NAME)}</string>
  <key>CFBundleIdentifier</key>
  <string>${escapePlistString(RUNNER_BUNDLE_IDENTIFIER)}</string>
  <key>CFBundleName</key>
  <string>OpenCodex Gateway</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>AtomApplication</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>ElectronAsarIntegrity</key>
  <dict>
    <key>Resources/app.asar</key>
    <dict>
      <key>algorithm</key>
      <string>SHA256</string>
      <key>hash</key>
      <string>${headerHash}</string>
    </dict>
  </dict>
</dict>
</plist>
`;
}

function officialFrameworksFingerprint(layout) {
  const entries = [];
  try {
    for (const entry of fs.readdirSync(layout.frameworksDir, { withFileTypes: true })) {
      entries.push({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        stat: fileFingerprint(path.join(layout.frameworksDir, entry.name)),
      });
    }
  } catch {}
  return {
    // 旧缓存可能包含 cpSync 改写出的官方绝对链接，升级后必须强制重建一次。
    copyVersion: 3,
    source: realpathSafe(layout.frameworksDir),
    appRoot: realpathSafe(layout.appRoot),
    executable: fileFingerprint(layout.executablePath),
    asar: fileFingerprint(layout.asarPath),
    entries,
  };
}

function sameFrameworksFingerprint(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function hasExternalSymlinks(dirPath, rootDir = dirPath) {
  const lexicalRoot = path.resolve(rootDir);
  let realRoot = lexicalRoot;
  try {
    realRoot = fs.realpathSync(rootDir);
  } catch {
    return true;
  }

  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(fullPath);
        const lexicalTarget = path.resolve(path.dirname(fullPath), target);
        if (!pathIsInside(lexicalRoot, lexicalTarget)) return true;
        try {
          // 符号链接链的最终目标也必须留在 runner 缓存内，防止相对链接绕过 lexical 检查。
          if (!pathIsInside(realRoot, fs.realpathSync(fullPath))) return true;
        } catch {
          return true;
        }
      } else if (entry.isDirectory() && hasExternalSymlinks(fullPath, rootDir)) {
        return true;
      }
    }
  } catch {
    // 无法完整检查缓存时按失效处理并重新复制，避免沿未知链接写入官方安装目录。
    return true;
  }
  return false;
}

function runCodesign(codesign, args) {
  codesign("/usr/bin/codesign", args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function signChangedFrameworkCopies({ changedFrameworks, runnerFrameworksDir, codesign, logger }) {
  if (!changedFrameworks.length) return;
  const rootRealPath = fs.realpathSync(runnerFrameworksDir);

  for (const binaryPath of changedFrameworks) {
    const helpersDir = path.join(path.dirname(binaryPath), "Helpers");
    if (isDirectory(helpersDir)) {
      for (const entry of fs.readdirSync(helpersDir, { withFileTypes: true })) {
        if (!entry.name.endsWith(".app")) continue;
        const helperPath = path.join(helpersDir, entry.name);
        const helperRealPath = fs.realpathSync(helperPath);
        if (!pathIsInside(rootRealPath, helperRealPath)) {
          throw new Error(`Runner helper escapes its cache directory: ${entry.name}`);
        }
        /**
         * Helper 必须与修改后的 Framework 使用同一临时签名。保留标识和 entitlement，
         * 但清除 Hardened Runtime 标志，避免原官方 Team ID 与本机 Framework 冲突。
         */
        runCodesign(codesign, [
          "--force",
          "--sign",
          "-",
          "--options",
          "0",
          "--preserve-metadata=identifier,entitlements",
          helperRealPath,
        ]);
      }
    }

    // 主 Framework 二进制最后签名，使其覆盖刚刚写入的完整性摘要。
    runCodesign(codesign, [
      "--force",
      "--sign",
      "-",
      "--preserve-metadata=identifier,entitlements,flags",
      binaryPath,
    ]);
    logLine(logger, `signed macOS Framework copy: ${binaryPath}`);
  }
}

function ensureFrameworksCopy({ layout, runnerFrameworksDir, markerPath, logger }) {
  const nextFingerprint = officialFrameworksFingerprint(layout);
  const previous = readJsonIfPresent(markerPath);
  if (
    previous &&
    sameFrameworksFingerprint(previous.fingerprint, nextFingerprint) &&
    isDirectory(runnerFrameworksDir) &&
    !hasExternalSymlinks(runnerFrameworksDir, runnerFrameworksDir)
  ) {
    logLine(logger, `official Electron Frameworks cache hit: ${runnerFrameworksDir}`);
    return { copied: false };
  }

  /**
   * 不能把 Contents/Frameworks 做成指向 /Applications 的符号链接：官方 helper 进程会按 runner
   * 内部路径回溯加载 framework，macOS sandbox 会拒绝跨 bundle symlink。这里复制到运行态 cache。
   *
   * fs.cpSync 默认会把相对符号链接解析成官方安装目录的绝对链接；verbatimSymlinks 保留
   * Framework 内部的 Versions/Current 结构，保证 runner 始终引用自己的隔离副本。
   */
  fs.rmSync(markerPath, { force: true });
  fs.rmSync(runnerFrameworksDir, { recursive: true, force: true });
  fs.cpSync(layout.frameworksDir, runnerFrameworksDir, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });
  writeJson(markerPath, {
    fingerprint: nextFingerprint,
    copiedAt: new Date().toISOString(),
  });
  logLine(logger, `official Electron Frameworks copied: ${layout.frameworksDir} -> ${runnerFrameworksDir}`);
  return { copied: true };
}

function signRunnerExecutable(executablePath, codesign) {
  /**
   * 官方主二进制复制到 runner 后原签名会失效；最后重签入口壳，
   * 让 Info.plist、app.asar 和已刷新的 Framework 一起封存到本地临时签名中。
   */
  runCodesign(codesign, ["--force", "--sign", "-", executablePath]);
}

async function createMacRunner({
  layout,
  runtimeDir,
  logger,
  runCompatibility = (_point, operation) => operation(),
  codesign = execFileSync,
}) {
  const workDir = path.join(runtimeDir, "official-electron-runner");
  const runnerAppPath = path.join(workDir, RUNNER_APP_NAME);
  const contentsDir = path.join(runnerAppPath, "Contents");
  const runnerMacosDir = path.join(contentsDir, "MacOS");
  const runnerResourcesDir = path.join(contentsDir, "Resources");
  const runnerFrameworksDir = path.join(contentsDir, "Frameworks");
  const frameworksMarkerPath = path.join(workDir, "frameworks-manifest.json");
  const runnerExecutablePath = path.join(runnerMacosDir, RUNNER_EXECUTABLE_NAME);

  // 官方升级后 framework/ABI 可能变化，Frameworks 由 fingerprint 控制；入口和 app.asar 每次重写。
  fs.rmSync(runnerMacosDir, { recursive: true, force: true });
  fs.rmSync(runnerResourcesDir, { recursive: true, force: true });
  fs.mkdirSync(runnerMacosDir, { recursive: true });
  fs.mkdirSync(runnerResourcesDir, { recursive: true });

  fs.copyFileSync(layout.executablePath, runnerExecutablePath);
  fs.chmodSync(runnerExecutablePath, 0o755);
  ensureFrameworksCopy({ layout, runnerFrameworksDir, markerPath: frameworksMarkerPath, logger });
  let changedFrameworks = [];
  try {
    // ASAR 完成后才能生成包含最终哈希的 plist；Framework 摘要和签名必须放在这两步之后。
    const runnerAsarPath = await runCompatibility(
      runnerPoints.gatewayAsar,
      () => writeGatewayAsar({ runnerResourcesDir, workDir })
    );
    runCompatibility(
      runnerPoints.macosBackgroundBundle,
      () => {
        fs.writeFileSync(path.join(contentsDir, "Info.plist"), runnerInfoPlist(runnerAsarPath), "utf8");
        fs.writeFileSync(path.join(contentsDir, "PkgInfo"), "APPL????", "utf8");
        changedFrameworks = refreshMacIntegrity(runnerFrameworksDir, runnerAsarPath);
      }
    );
    runCompatibility(
      runnerPoints.macosEntrySignature,
      () => {
        signChangedFrameworkCopies({
          changedFrameworks,
          runnerFrameworksDir,
          codesign,
          logger,
        });
        signRunnerExecutable(runnerExecutablePath, codesign);
      }
    );
  } catch (error) {
    // 摘要写入后签名若失败，下次必须从官方副本重建，不能误用半成品缓存。
    fs.rmSync(frameworksMarkerPath, { force: true });
    throw error;
  }

  logLine(logger, `prepared official Electron runner: app=${runnerAppPath}`);
  logLine(logger, `official Electron source: app=${layout.appRoot} asar=${layout.asarPath}`);

  return {
    compatibilityPoints: [
      runnerPoints.macosBackgroundBundle.id,
      runnerPoints.macosEntrySignature.id,
      runnerPoints.gatewayAsar.id,
    ],
    executablePath: runnerExecutablePath,
    runnerAppPath,
    officialAppPath: layout.appRoot,
    officialAsarPath: layout.asarPath,
  };
}

module.exports = {
  createMacRunner,
};
