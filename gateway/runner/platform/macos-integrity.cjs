const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const asar = require("@electron/asar");
const { withPhysicalAsarAccess } = require("../shared/fs-utils.cjs");

// Electron 41+ 在 Framework 数据段中写入固定哨兵和 v1 完整性摘要槽。
const INTEGRITY_DIGEST_SENTINEL = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");
const INTEGRITY_DIGEST_OFFSET = INTEGRITY_DIGEST_SENTINEL.length + 2;
const INTEGRITY_DIGEST_LENGTH = 32;
const INTEGRITY_SLOT_LENGTH = INTEGRITY_DIGEST_OFFSET + INTEGRITY_DIGEST_LENGTH;

function pathIsInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function realPathInside(rootPath, candidatePath, label) {
  const realPath = fs.realpathSync(candidatePath);
  if (!pathIsInside(rootPath, realPath)) {
    throw new Error(`Runner ${label} escapes its cache directory: ${candidatePath}`);
  }
  return realPath;
}

function runnerAsarDictionaryDigest(runnerAsarPath) {
  const header = withPhysicalAsarAccess(() => asar.getRawHeader(runnerAsarPath).headerString);
  const headerHash = crypto.createHash("sha256").update(header).digest("hex");
  // 对应 Electron integrity_digest.mm：排序后的相对路径、算法和 header hash 依次参与 SHA-256。
  return crypto
    .createHash("sha256")
    .update(`Resources/app.asarSHA256${headerHash}`)
    .digest();
}

function frameworkBinaryPaths(frameworksDir) {
  const rootRealPath = fs.realpathSync(frameworksDir);
  const binaries = new Map();

  for (const entry of fs.readdirSync(frameworksDir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".framework")) continue;
    const frameworkName = entry.name.slice(0, -".framework".length);
    const frameworkDir = path.join(frameworksDir, entry.name);
    const frameworkRealPath = realPathInside(rootRealPath, frameworkDir, `framework ${entry.name}`);
    if (!fs.statSync(frameworkRealPath).isDirectory()) continue;

    const candidates = [path.join(frameworkDir, frameworkName)];
    const versionsDir = path.join(frameworkDir, "Versions");
    try {
      for (const versionEntry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        // 只遍历真实版本目录；Versions/Current 由 Framework 根入口符号链接覆盖，避免重复和越过缓存。
        if (!versionEntry.isDirectory()) continue;
        candidates.push(path.join(versionsDir, versionEntry.name, frameworkName));
      }
    } catch (error) {
      if (!(error && error.code === "ENOENT")) throw error;
    }

    for (const candidate of candidates) {
      let stat;
      try {
        stat = fs.statSync(candidate);
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile()) continue;
      const binaryPath = realPathInside(rootRealPath, candidate, `framework binary ${frameworkName}`);
      // Universal 二进制和根级符号链接可能指向同一文件，按真实路径去重后只签名一次。
      binaries.set(binaryPath, binaryPath);
    }
  }

  return [...binaries.keys()];
}

function refreshMacIntegrity(frameworksDir, runnerAsarPath) {
  const digest = runnerAsarDictionaryDigest(runnerAsarPath);
  const updates = [];

  for (const binaryPath of frameworkBinaryPaths(frameworksDir)) {
    const binary = fs.readFileSync(binaryPath);
    const updated = Buffer.from(binary);
    let dirty = false;

    for (
      let offset = binary.indexOf(INTEGRITY_DIGEST_SENTINEL);
      offset !== -1;
      offset = binary.indexOf(INTEGRITY_DIGEST_SENTINEL, offset + INTEGRITY_DIGEST_SENTINEL.length)
    ) {
      if (offset + INTEGRITY_SLOT_LENGTH > binary.length) {
        throw new Error(`Truncated macOS integrity digest slot: ${binaryPath}`);
      }
      const used = binary[offset + INTEGRITY_DIGEST_SENTINEL.length];
      const version = binary[offset + INTEGRITY_DIGEST_SENTINEL.length + 1];
      if (used === 0) continue;
      if (version !== 1) {
        throw new Error(`Unsupported macOS integrity digest version ${version}: ${binaryPath}`);
      }
      const digestOffset = offset + INTEGRITY_DIGEST_OFFSET;
      if (!binary.subarray(digestOffset, digestOffset + INTEGRITY_DIGEST_LENGTH).equals(digest)) {
        digest.copy(updated, digestOffset);
        dirty = true;
      }
    }

    // 先完成全部槽位校验再统一写盘，未知版本或截断槽位不能留下部分修改。
    if (dirty) updates.push({ binaryPath, data: updated });
  }

  for (const update of updates) fs.writeFileSync(update.binaryPath, update.data);
  return updates.map((update) => update.binaryPath);
}

module.exports = {
  INTEGRITY_DIGEST_SENTINEL,
  pathIsInside,
  refreshMacIntegrity,
  runnerAsarDictionaryDigest,
};
