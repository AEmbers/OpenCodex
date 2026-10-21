const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const vm = require("node:vm");

const WEB_SHELL_DIR = path.resolve(__dirname, "..", "..", "web-shell");
const BRIDGE_POLYFILL = path.join(WEB_SHELL_DIR, "internal", "providers", "codex-bridge-polyfill.js");
const SHELL_INDEX = path.join(WEB_SHELL_DIR, "index.html");

// 认证模块在 require 时读取独立配置，避免触碰开发者真实 gateway 配置。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-ws-auth-test-"));
const configPath = path.join(tempDir, "config.yaml");
const passwordHash = crypto.createHash("sha256").update("ws-auth-secret", "utf8").digest("hex");
fs.writeFileSync(configPath, `auth:\n  password: "sha256-v1:${passwordHash}"\n`, "utf8");
process.env.CODEX_WEB_CONFIG_PATH = configPath;

const {
  authResultForRequest,
  handleAuthLogin,
} = require("../runtime/http/auth.cjs");

test.after(() => {
  fs.rmSync(tempDir, { force: true, recursive: true });
});

function sourceFunctionDeclaration(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function makeResponseRecorder() {
  return {
    body: "",
    headers: {},
    status: 0,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = String(body || "");
    },
  };
}

async function issueAccessToken() {
  const req = Readable.from([Buffer.from(JSON.stringify({ passwordHash }), "utf8")]);
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = makeResponseRecorder();
  await handleAuthLogin(req, res);
  assert.equal(res.status, 200);
  return JSON.parse(res.body).token;
}

function authRequest({ authorization = "", cookie = "" } = {}) {
  return {
    headers: {
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function createBridgeAuthHarness({ globalToken = "", storedToken = "", topToken = "" } = {}) {
  const bridge = fs.readFileSync(BRIDGE_POLYFILL, "utf8");
  const functionNames = [
    "normalizeGatewayAuthToken",
    "gatewayAuthTokenFromWindow",
    "storedGatewayAuthToken",
    "gatewayAuthToken",
    "gatewayWebSocketUrl",
    "clearGatewayAuthToken",
  ];
  const declarations = functionNames.map((name) => sourceFunctionDeclaration(bridge, name)).join("\n");
  const storage = new Map();
  if (storedToken) storage.set("codex_web_auth_token", storedToken);
  const sessionStorage = {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    removeItem(key) {
      storage.delete(key);
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
  const top = { __OPEN_CODEX_RUNTIME_AUTH_TOKEN__: topToken };
  const w = {
    __OPEN_CODEX_RUNTIME_AUTH_TOKEN__: globalToken,
    parent: top,
    top,
  };
  const context = vm.createContext({
    cfg: { gatewayWsUrl: "ws://gateway.test/ws" },
    location: { href: "http://gateway.test/", origin: "http://gateway.test" },
    sessionStorage,
    URL,
    w,
  });
  const api = vm.runInContext(
    `const GATEWAY_AUTH_TOKEN_STORAGE_KEY = "codex_web_auth_token";
     ${declarations}
     ({ clearGatewayAuthToken, gatewayAuthToken, gatewayWebSocketUrl });`,
    context
  );
  return { api, storage, w };
}

test("websocket auth accepts a valid cookie when the query token is stale", async () => {
  const token = await issueAccessToken();
  const result = authResultForRequest(
    authRequest({ cookie: `codex_web_auth=${encodeURIComponent(token)}` }),
    new URL("http://127.0.0.1/ws?token=stale-token")
  );

  assert.equal(result.authenticated, true);
  assert.equal(result.token, token);
});

test("websocket auth accepts a query token when the cookie is absent", async () => {
  const token = await issueAccessToken();
  const result = authResultForRequest(
    authRequest(),
    new URL(`http://127.0.0.1/ws?token=${encodeURIComponent(token)}`)
  );

  assert.equal(result.authenticated, true);
  assert.equal(result.token, token);
});

test("bridge restores its websocket token after reload and document replacement", () => {
  const token = "session-token";
  const first = createBridgeAuthHarness({ globalToken: token, storedToken: token });
  assert.equal(first.api.gatewayAuthToken(), token);
  assert.equal(new URL(first.api.gatewayWebSocketUrl()).searchParams.get("token"), token);

  // 新 document/window 没有内存值，但同一标签页的 sessionStorage 仍可恢复认证。
  const reloaded = createBridgeAuthHarness({ storedToken: token });
  assert.equal(reloaded.api.gatewayAuthToken(), token);
  assert.equal(new URL(reloaded.api.gatewayWebSocketUrl()).searchParams.get("token"), token);
});

test("same-origin child frames inherit the top frame auth handoff", () => {
  const harness = createBridgeAuthHarness({ topToken: "top-frame-token" });

  assert.equal(harness.api.gatewayAuthToken(), "top-frame-token");
  assert.equal(new URL(harness.api.gatewayWebSocketUrl()).searchParams.get("token"), "top-frame-token");
});

test("cookie-only websocket reconnect keeps the URL free of an empty auth token", () => {
  const harness = createBridgeAuthHarness();
  const url = new URL(harness.api.gatewayWebSocketUrl());

  assert.equal(url.pathname, "/ws");
  assert.equal(url.searchParams.has("token"), false);
});

test("reconnect recomputes the websocket URL after a new token becomes available", () => {
  const harness = createBridgeAuthHarness();
  assert.equal(new URL(harness.api.gatewayWebSocketUrl()).searchParams.has("token"), false);

  harness.storage.set("codex_web_auth_token", "rotated-token");
  assert.equal(new URL(harness.api.gatewayWebSocketUrl()).searchParams.get("token"), "rotated-token");
});

test("gateway logout removes both in-memory and session-scoped auth handoff", () => {
  const harness = createBridgeAuthHarness({ globalToken: "logout-token", storedToken: "logout-token" });

  harness.api.clearGatewayAuthToken();

  assert.equal(harness.w.__OPEN_CODEX_RUNTIME_AUTH_TOKEN__, "");
  assert.equal(harness.storage.has("codex_web_auth_token"), false);
});

test("login shell persists the runtime token in session-scoped storage", () => {
  const shell = fs.readFileSync(SHELL_INDEX, "utf8");

  assert.match(shell, /const runtimeAuthTokenStorageKey = "codex_web_auth_token"/);
  assert.match(shell, /sessionStorage\.setItem\(runtimeAuthTokenStorageKey, runtimeAuthToken\)/);
  assert.match(shell, /sessionStorage\.removeItem\(runtimeAuthTokenStorageKey\)/);
  assert.match(shell, /storeToken\(body\.token\)/);
});
