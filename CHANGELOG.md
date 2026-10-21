# Changelog

## 2.1.3

### Fixed

- Restore the shared IPC argument normalizer used by the official-runtime fetch preparse, preventing `fetchMessageFromIpcArgs is not defined` from blocking persisted atom synchronization and leaving the browser on the GPT startup icon.
- Intercept direct `POST /wham/statsig/bootstrap` fetches in the web shell so the current official renderer can finish its post-login Statsig provider initialization.
- Resolve Windows AppData package redirection when serving hashed official renderer assets, avoiding 404 loops that leave the startup loader permanently visible.

## 2.1.2

### Fixed

- Prefer the real Statsig initialize response when the network is healthy and fall back locally only for aborts handled by OpenCodex, network failures, timeouts, non-2xx responses, or malformed control-plane payloads.
- Keep IPC Statsig requests to one terminal response, cancel timed-out native requests, and retry bounded fallback delivery without leaving the first-screen promise unresolved.
- Treat compatibility points with a safe official fallback as degraded diagnostics instead of marking the running gateway unhealthy.
- Restore immutable caching for verified Vite and WASM content hashes while keeping fixed-name JavaScript and entry HTML revalidated.
- Route same-origin refresh and gateway links in the current tab instead of opening a second browser window.
- Serialize composer draft persistence so delayed acknowledgements cannot restore sent text or overwrite a newer clear.
- Refresh macOS runner integrity slots and signatures fail-closed, reject cache symlink escapes, and never reuse a half-prepared Framework cache.
- Stop repeated macOS launcher focus stealing during startup and background transitions.
- Persist the selected authentication theme before first paint and follow the system theme when no preference exists.
- Scope mobile subscription billing suppression to the exact payment endpoint and error text.
- Support delegated worktree shell-environment layouts without rewriting ambiguous official bundle code.

### Changed

- Make headless Electron arguments opt-in through `OPENCODEX_HEADLESS_ELECTRON`.
- Follow the configured Fork repository for release checks and trusted release links.

## 2.1.1

### Fixed

- Release AppHost resources when browser relays close or are replaced, preventing stale AppView RPC exports and `no such export ID` failures.
- Keep WebSocket authentication valid across renderer replacement, reload, reconnect, and same-origin child frames.
- Remove private Chromium SxS dependencies from copied Windows runners while preserving publisher-signed dependencies.
- Cap hidden app-server MCP startup waits so a slow REPL server cannot block first-screen status checks for up to 120 seconds.
- Stabilize Windows path, file-mode, line-ending, PWA discovery, and source-marker tests.

### Changed

- Align smart scheduling defaults and diagnostics-page assertions with the current runtime contract.
