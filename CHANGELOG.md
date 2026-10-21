# Changelog

## 2.1.1

### Fixed

- Release AppHost resources when browser relays close or are replaced, preventing stale AppView RPC exports and `no such export ID` failures.
- Keep WebSocket authentication valid across renderer replacement, reload, reconnect, and same-origin child frames.
- Remove private Chromium SxS dependencies from copied Windows runners while preserving publisher-signed dependencies.
- Cap hidden app-server MCP startup waits so a slow REPL server cannot block first-screen status checks for up to 120 seconds.
- Stabilize Windows path, file-mode, line-ending, PWA discovery, and source-marker tests.

### Changed

- Align smart scheduling defaults and diagnostics-page assertions with the current runtime contract.
