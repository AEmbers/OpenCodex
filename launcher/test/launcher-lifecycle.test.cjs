"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const LAUNCHER_MAIN = path.resolve(__dirname, "..", "main.cjs");

function launcherSourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("explicit launcher activation restores the window with one non-stealing focus", async () => {
  const source = fs.readFileSync(LAUNCHER_MAIN, "utf-8");
  const lifecycle = launcherSourceSection(
    source,
    "function presentLauncherWindow()",
    "\nfunction createTrayImage()"
  );
  const calls = [];
  const timers = [];
  const window = {
    focus: () => calls.push("focus"),
    isDestroyed: () => false,
    isMinimized: () => true,
    moveTop: () => calls.push("moveTop"),
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
  };
  const context = vm.createContext({
    app: {
      focus: (options) => calls.push(["app.focus", options]),
    },
    createWindow: () => calls.push("createWindow"),
    mainWindow: window,
    process: { platform: "darwin" },
    setTimeout: (...args) => {
      timers.push(args);
      return { unref() {} };
    },
    showLauncherDockIcon: async () => calls.push("dock"),
    startStatusPolling: () => calls.push("polling"),
  });
  vm.runInContext(`${lifecycle}\nthis.showLauncherWindow = showLauncherWindow;`, context);

  await context.showLauncherWindow();

  assert.deepEqual(calls, ["dock", "polling", "restore", "show", "focus"]);
  assert.equal(timers.length, 0);
  assert.equal(source.includes("app.focus({ steal: true })"), false);
  assert.equal(source.includes("scheduleLauncherWindowPresent"), false);
  assert.doesNotMatch(source, /setTimeout\(presentLauncherWindow/);
});

test("normal startup and background state do not activate the launcher again", () => {
  const source = fs.readFileSync(LAUNCHER_MAIN, "utf-8");
  const startup = launcherSourceSection(
    source,
    "app.whenReady().then(async () => {",
    'app.on("activate"'
  );
  const background = launcherSourceSection(
    source,
    'app.on("window-all-closed"',
    'app.on("before-quit"'
  );

  assert.match(startup, /createWindow\(\)/);
  assert.doesNotMatch(startup, /showLauncherWindow|presentLauncherWindow/);
  assert.doesNotMatch(background, /showLauncherWindow|presentLauncherWindow/);
  assert.match(source, /app\.on\("second-instance"[\s\S]*showLauncherWindow\(\)/);
});
