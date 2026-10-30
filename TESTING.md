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

## Hook lifecycle follow-up — 1.0.3-r3

Historical 1.0.3-r3 was pushed for the maintainer feedback; the strengthened 1.0.4-r4 follow-up below supersedes its endpoint and watchdog boundaries.

- `SessionStart` is now `matcher: startup|resume`, uses `start-bridge.sh --hook` with a 20-second hook timeout, exits for non-matching `ANTHROPIC_BASE_URL`, and only asynchronously starts the watchdog instead of waiting through the 65-second readiness deadline.
- The private manifest records the component entry. If that entry is absent after App component removal, the leftover Hook logs a cleanup hint and exits without starting CCR.
- The package description states the approximately 107 MiB tar payload; the scoped lifecycle tests cover legacy-Hook migration, foreign-provider skip, removed-entry auto-start blocking and explicit purge.

The implementation has passed 17 installer unit checks, both standalone/bundled lifecycle modes, health checks and the full 1.0.3 test suite in the isolated source workspace. It is a Draft follow-up only; no current bridge was restarted and no real credentials or provider request were used.

## Hook boundary and release handoff — 2026-10-30, 1.0.4-r4

The maintainer confirmed on October 29 that the official order is **merge → CI package/sign → signed-index install, in-App chat and complete uninstall → separate verified.json**. No pre-release signed index is requested; timing and merge belong to the maintainer. The prior follow-up incorrectly repeated that request after it had been answered; current PR text corrects it.

- Strict base-URL/port matching occurs before Node, HOME changes, log writes, dependency checks or locks. Exact loopback authority and paths beneath it are accepted; prefix ports/userinfo/foreign hosts are not. Matching Hooks only dispatch the single-instance watchdog, leaving patch/lock/readiness work to the background.
- Hook/manual/direct-watchdog entry checks validate this installation's manifest and the external component-package entry. An already-running watchdog checks every iteration and again after patch verification; it exits on removal without killing the active CCR. Private uninstall.sh remains usable after component removal.
- Corrected the accidental @protobufjs/float version metadata change from 1.0.3 back to its unchanged resolved/integrity artifact version 1.0.2; no dependency artifact is upgraded by that correction.
- Clean npm ci followed by npm test passed: **17 installer unit checks, 9 new isolated Hook checks, 76 response/atomic regressions, 9 real-CCR HTTP tests**, both standalone/bundled lifecycles, health checks and selftest 3/3. External npm audit reports **0 vulnerabilities**; effective bundle audit checks **84 remaining embedded packages, 0 medium/high/critical advisory matches**.
- New Hook checks cover no-Node foreign/empty URL skips, strict port/userinfo/host boundaries, delayed patch cold-start return, /v1 paths and concurrent singletons, busy service locks, port collision without killing the unrelated server, missing entry/bad manifest, entry removal during patching and existing watchdog removal without restart.
- Lifecycle tests copy the component source into their own temporary directory; they do not rename the real repository or installed component entry. They install without --start, prove foreign cold Hooks start no process, then start the real patched CCR through a matching Hook and perform mock inference, idempotence, stop/uninstall/purge.
- Recipe validation and the local PR branch's 8 supported-base dry resolutions passed. A separate build targets the actual 2026.10.28 base 3768afcf79a7… using the published base lock. No shared bases.json changes were made.
- The **exact final archive** was unpacked into a fresh work directory: packaged selftest 3/3 and the bundled cold-Hook lifecycle/purge passed. It has **7,343 files, 182 npm packages**, no additional Termux packages; tar **111,968,768 bytes / 106.78 MiB**, gzip **28,266,668 bytes / 26.96 MiB**. Gzip SHA-256: 62a4ac7510b9b6ccbbc8bf7f133651c8c5af3f0f63211bc637681cd96bec01e7. Tar SHA-256: 6652392e6a744273a0c84f34735e0242888f964ab62e90b6e6e38c9b604d3bfc.

All of the above is isolated local verification, not the post-merge official-index/App test or a new hosted market check. No real user configuration, live bridge, paid inference, provider switching or verified.json record is involved.

## Not completed or claimed

- Official signed-index installation/removal through the App component manager and a current in-App chat have not been completed. A locally extracted package is **not** a signed-index install. No `verified.json` record is added.
- The market's hosted checks/selftest have passed; the two warning categories were reproduced locally as described above. A downloaded complete hosted Summary is still unavailable; a local reproduction is not presented as that original report.
- No new in-App graphical OpenAI configuration card or main-App lifecycle integration is implemented; those were explicitly deferred by the maintainer. Configuration remains a user-operated terminal prompt and the existing custom provider form.
- Existing runtime installs are preserved, not automatically migrated; they do **not** automatically receive these patches. App-only removal does not delete the private runtime data or Hook; new r4 Hooks/watchdogs stop rearming when the package entry is gone, but an active CCR is not forcibly killed. Explicit uninstall is documented, with separately authorized purge for complete deletion.
- No current real-provider inference/visual success is claimed from the fake-upstream tests. No private screenshots, conversations or keys were sent, and no paid upstream request was made for this revision.
