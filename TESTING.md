# Verification record — preview proposal

## Environment

- Device: Xiaomi M367FC / Xiaomi Pad 9 Pro Max, Android 17 (SDK 37), aarch64; XRing O3, Mali.
- Runs natively as the normal cccodroid application UID; no root, Shizuku, chroot, proot or emulator used.
- Node.js 26, Python 3.14. Component base: `devkit-2026.10.22.3` (`ae9d10a14013…`).
- Tests do not stop/restart the user's existing bridge, load real credentials, replay conversations or call a real inference endpoint. Installer tests intentionally access the npm registry only in the standalone-install variant.

## Completed checks

| Check | Result |
|---|---|
| Installer units | 15 passed, including hook merge/removal, private permissions, URL validation, independent dependency copies and rejecting unsafe symlinks |
| Standalone install end-to-end | Passed npm-ci install → patch → startup → local fake inference → idempotent repeat → status → uninstall; unrelated settings preserved |
| Component install end-to-end | Passed bundled offline-copy path through the component CLI, with the same lifecycle checks; source dependency bytes/inode/mtime unchanged |
| Request/response/atomic patch regressions | 73 passed, including effort, cancellation, malformed payloads, JSON/SSE sniffing, tool images and local token estimates |
| Full HTTP integration | 9 passed using real CCR with a loopback fake upstream |
| Health probe | Healthy/error/invalid JSON/oversized/timeout/invalid-port and invalid-URL checks passed |
| Packaged selftest prototype | JSON non-stream, JSON→SSE and incorrectly-labelled SSE passed; effort preserved; upstream loopback-only |
| Market `check-recipes.mjs` | Passed across the repository |
| Market `ci-build.mjs --only openai-bridge --dry` | Dependency resolution passed for all 8 bases in `bases.json`; no packages published |
| Local devkit package build | Passed against the pinned and SHA-256-verified current base; approximately 26.5 MiB compressed, 97.6 MiB payload / 104.6 MiB tar |
| Actual archive staged selftest and lifecycle | Final archive extracted into a new private work directory (not installed into the live PREFIX); packaged CLI selftest and full bundled install/start/request/repeat/status/uninstall checks passed |

No additional Termux packages are required beyond the current base. The component bundles 180 npm packages under its own `usr/lib/openai-bridge` namespace, so it does not overwrite Cloudflare's or other components' private npm modules. First configuration makes a separate private runtime copy (approximately another 98 MiB), rather than modifying the package manager's files.

## Outstanding / not claimed

- **`npm audit --omit=dev` does not pass**: 6 reported vulnerabilities (2 high, 1 moderate, 3 low). See `SECURITY.md`. Functional tests and loopback binding do not resolve these advisories.
- The initial PR must remain **Draft** pending market-scope and security review. The market's policy mentions reverse proxies; the proposal must disclose that this bridge forwards user requests and let the maintainer decide, not claim a policy exception.
- The market's hosted audit report and termux-docker CI selftest have not been reviewed yet.
- Signed-index installation and removal through the actual App component manager have not been completed. No `verified.json` record is added.
- No new in-app graphical OpenAI configuration card is implemented. Configuration uses a user-operated terminal prompt and the existing custom Anthropic-compatible provider form.
- Older runtime installs are preserved, not automatically migrated. App-only component removal does not automatically stop a separate private runtime or remove its Hook; the explicit uninstall step is documented.
- No current real-provider visual/inference success is claimed on the basis of these fake-upstream tests; no private screenshots or conversations were sent for this contribution.
