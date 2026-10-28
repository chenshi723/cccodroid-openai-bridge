# Verification record — preview proposal

## Environment and isolation

- Device: Xiaomi M367FC / Xiaomi Pad 9 Pro Max, Android 17 (SDK 37), aarch64; XRing O3, Mali.
- Runs natively as the normal cccodroid application UID; no root, Shizuku, chroot, proot or emulator used.
- Node.js 26.4.0, Python 3.14. Component base: `devkit-2026.10.22.3` (`ae9d10a14013…`).
- Tests do not stop/restart the user's existing bridge, load real credentials, replay conversations or call a real inference endpoint. Installer tests access npm only in the standalone-install variant; advisory gates send public dependency names/versions to npm.

## Security follow-up — 2026-10-28, 1.0.2-r2

The maintainer accepted the protocol-adapter scope in PR #53, and requested dependency repairs plus signed-index/App chat/uninstall verification. This revision keeps the PR Draft and distinguishes the completed local tests from that release-path requirement.

| Check | Result |
|---|---|
| External npm audit | `npm audit --omit=dev --audit-level=moderate`: **0 vulnerabilities** |
| Effective private bundle audit | `node tests/audit-bundle.cjs`: 84 remaining embedded package/version entries, **0 medium/high/critical matches** |
| Static security negative control | Unpatched CCR reproduces `allowedPath` bypass using only temporary fake files |
| Repaired bundle security | Old static implementation plus 249 affected embedded CommonJS modules removed; real bundle loads the exact locked external Fastify/static/Undici implementations |
| Static security regressions | Non-canonical path, encoded-separator route guard and listing traversal rejected; normal public file still works |
| tmp security regressions | 0.2.7 rejects prefix/postfix/dir escapes; normal temp file works |
| Installer units | 16 passed, including Hook preservation, target/symlink checks, private copies and purge refusal on unsafe targets |
| Standalone lifecycle | npm-ci install → patch → startup → fake inference → repeat install → status → preserve-data uninstall → explicit purge; unrelated settings and source dependencies unchanged |
| Component lifecycle | Bundled offline-copy path passes the same lifecycle, including complete private-directory deletion only with `--purge` |
| Request/response/atomic regressions | 76 passed, including unchanged original backup, no-write on unknown static fingerprint or old dependency, cancellation, images and effort |
| Full HTTP integration | 9 passed with real patched CCR and a loopback fake upstream |
| Health probe | Healthy/error/invalid JSON/oversized/timeout/invalid-port and invalid-URL checks passed |
| Packaged selftest | JSON non-stream, JSON→SSE, incorrectly labelled SSE; `CCR=1.0.73 static=10.1.2 JSON/SSE=3/3 effort=OK upstream=loopback-only` |
| Recipe format and resolution | `check-recipes.mjs` passed; `ci-build.mjs --only openai-bridge --dry` resolves all 8 bases |
| Local devkit package build | 0 additional Termux packages; 182 npm packages / 7343 files; 26.96 MiB gzip / 106.78 MiB tar (28,264,960 / 111,963,648 bytes) |
| Final archive staged lifecycle | Built archive extracted into a fresh private work directory, packaged selftest 3/3 and configure → fake inference → repeat → status → preserve-data uninstall → purge passed; source dependency bytes/inode/mtime unchanged |

The source CI now **fails** on medium/high/critical external or effective-bundle advisories; the previous non-gating audit has been removed. Security checks are point-in-time advisory matching, not a claim that all code is free of vulnerabilities. The original immutable npm bundle and `.orig` backup remain upstream source, not supported execution entry points. See `SECURITY.md`.

## Market CI and current-base follow-up — 2026-10-28

- Market workflow [40617306752, attempt 2](https://github.com/greyoak111/cccodroid-components/actions/runs/40617306752) completed **success** for component commit `7db3822`. `check` and `audit` passed. Hosted raw logs report **0 errors / 2 warnings**, and termux-docker selftest returned **rc=0**, JSON/SSE=3/3, effort=OK.
- The report-comment step failed with `Resource not accessible by integration (addComment)` because the fork workflow has no PR-comment write permission. That step is non-blocking; the final audit/selftest conclusion passed. This is not an unapproved workflow anymore.
- The detailed hosted Summary was not retrieved as a downloadable artifact. A local reproduction of the same warning rules on the identical archive reports: **20 executable scripts with foreign shebangs**, supported by termux-exec, and **Node base/repository drift `26.4.0-2 → 26.12.1`**, while construction uses the pinned base version. This is explicitly a local reproduction, not a transcription of the hosted Summary. No hardcoded `/tmp`, residual Termux paths, missing local interpreters, base-file clobbers or ELF payloads were found in this check.
- For that reproduction, the base file list was taken from the installed 2026.10.28 manifest and actual symbolic links, rather than downloading the full 682 MB older base archive. A first manifest-only pass falsely reported `sh` missing because the file manifest omits symbolic links; including the actual links resolves that local-list artifact. Release-size/shared-package comparison was disabled in a temporary copy only; production audit rules were not changed. This reproduction is not a complete old-base audit.
- The device now uses `devkit-2026.10.28`, base SHA-256 `3768afcf79a7cfb3b8db27d9d1d2951aaaade4caa79d5a1179cf495ebd14c67d`, Node **26.12.1**, Python **3.14.8**. The published base lock agrees with the installed identity. The full `npm test`, external audit and effective-bundle audit all passed again in this environment; 16 installer units, 76 response/atomic regressions and 9 HTTP tests remain green.
- A fresh component build targeting that current base has 7343 files / 182 npm packages and no additional Termux packages. Gzip: **28,264,960 bytes**, SHA-256 `7775c9367a5d9c0360c3a4944797993f6eb95243842e325ff8502d3d56c6b5fb`; payload tar: **111,963,648 bytes**, SHA-256 `df6240db0f34bc252401c585579e5b770fabcf521374362046636066f61c71ba`. Its immutable payload is byte-identical to the prior build; its metadata identifies the new compatible base. Extracted selftest and bundled lifecycle, including preserve-data uninstall followed by explicit disposable-directory purge, passed again.
- The official market index generated at `2026-10-28T04:44:54.409Z` was downloaded and **verified with the same Ed25519 public key embedded in the installed App**. It contains 28 components, but **no `openai-bridge`**; there is no official `openai-bridge` Release either. Consequently a signed-index installation cannot yet be attempted. No unsigned override, alternate trust root, live provider switch or real inference request was used.

## Not completed or claimed

- Official signed-index installation/removal through the App component manager and a current in-App chat have not been completed. A locally extracted package is **not** a signed-index install. No `verified.json` record is added.
- The market's hosted checks/selftest have passed; the two warning categories were reproduced locally as described above. A downloaded complete hosted Summary is still unavailable; a local reproduction is not presented as that original report.
- No new in-App graphical OpenAI configuration card or main-App lifecycle integration is implemented; those were explicitly deferred by the maintainer. Configuration remains a user-operated terminal prompt and the existing custom provider form.
- Existing runtime installs are preserved, not automatically migrated; they do **not** automatically receive these patches. App-only component removal does not stop a private runtime or remove its Hook. Explicit uninstall is documented, with separately authorized purge for complete deletion.
- No current real-provider inference/visual success is claimed from the fake-upstream tests. No private screenshots, conversations or keys were sent, and no paid upstream request was made for this revision.
