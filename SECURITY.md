# Security and scope

This is a local, opt-in protocol adapter for an API that the end user is authorized to use. It is not an account-sharing service or a public gateway. It does not read Claude subscription credentials, modify the Claude Code binary, remove model safety controls, or provide any API quota. The component maintainer [accepted this scope](https://github.com/greyoak111/cccodroid-components/pull/53#issuecomment-6419449939); the PR remains Draft pending release-path verification.

- Listen only on `127.0.0.1`. Never expose the listener through port forwarding or a public reverse proxy.
- Requests, including tool results and images, are sent to the Chat Completions endpoint configured by the user. Users must review that service's privacy policy, authorization and billing rules.
- Users enter their own API keys privately. Do not request, print, commit or publish them. Local connection keys and upstream API keys are different secrets.
- Runtime state and credentials belong in a dedicated private HOME, not in the source repository or shared Android storage. Files containing credentials use mode 600.
- Do not enable debug logging with real conversations unless necessary. Upstream errors and diagnostic logs may contain sensitive data.
- Health checks test the local process only, not upstream availability or successful model inference.

## Dependency remediation in 1.0.2

CCR remains pinned to **1.0.73** to preserve its tested protocol transformation. Updating an npm dependency alone does not repair CCR's bundled implementations. This revision addresses both layers:

1. `@fastify/static` is locked/overridden to **10.1.2**; `tmp` is overridden to **0.2.7**. This covers the static path/guard/listing advisories, including GHSA-pr96-94w5-mx2h, GHSA-x428-ghpx-8j92, GHSA-83w8-p2f5-377r and GHSA-8pvw-jcv7-9cmj, and tmp GHSA-52f5-9888-hmc6 / GHSA-ph9p-34f9-6g65.
2. `patch-ccr.js` checks the SHA-256 fingerprint of CCR's embedded static code, removes both the old directory-listing and plugin implementations, and selects the fixed external plugin.
3. An additional inspection found advisories hidden from `npm audit` in other embedded packages. The patch fingerprints and replaces **249 CommonJS modules** with external loads of these exact locked versions:

   | Package | Version |
   |---|---|
   | fastify | 5.12.7 |
   | ajv | 8.20.0 |
   | fast-uri | 3.1.9 |
   | find-my-way | 9.10.0 |
   | undici | 7.30.1 |
   | @isaacs/brace-expansion | 5.0.1 |
   | minimatch | 10.2.6 |
   | glob | 11.1.0 |
   | shell-quote | 1.12.0 |

   The bundled editor/tmp implementation is absent; tmp belongs to the external interactive-editor dependency chain. Its external copy is still upgraded rather than relying on non-use.
4. Missing/wrong dependency versions, changed fingerprints or syntax errors fail before any bundle replacement. Installation aborts before Hook changes; every supported start and watchdog restart verifies the patch before launching CCR. The replacement remains atomic and idempotent.
5. CI now gates on `npm audit --omit=dev --audit-level=moderate`, functional security regressions and `node tests/audit-bundle.cjs`. The latter examines a patched temporary copy and sends **only public npm package names and versions** to npm's advisory API; it fails closed on API errors or medium/high/critical findings.

Local checks on 2026-10-28: external npm audit **0 vulnerabilities**; the effective private bundle contains **84 remaining embedded packages**, with **0 medium/high/critical advisory matches**. These are point-in-time checks, not proof of absence of all vulnerabilities. The tests reproduce the old static guard bypass on temporary fake files and confirm rejection after repair, including encoded separators, traversal and non-canonical paths. Tests also confirm tmp rejects escape options.

The component manager's immutable CCR source and private `.orig` backup still contain upstream's old bundle. **Do not run the bundled `ccr` CLI directly**: only `openai-bridge` and the managed start scripts apply these remediations. We do not claim that the original npm release or every file in the download is fixed. No debug UI or public server is needed by this component. New upstream versions require re-auditing and new fingerprints; do not force-upgrade CCR underneath these patches.

## Release and cleanup boundaries

The official signed-index/App install → configuration → in-app chat → complete uninstall and the market's hosted audit review remain separate requirements. Passing isolated tests does not satisfy them. No `verified.json` entry is generated from a local archive.

`uninstall --yes` stops this runtime and removes only its own Hook, preserving private data. For a **fully disposable test install**, `uninstall --yes --purge` additionally deletes the entire managed directory, including dependency copies, credentials, logs and local backups. Obtain explicit user approval and any needed backup before purging real data. It rejects symbolic-link/unsafe targets and never deletes the separate Claude settings file or its backup.

Report security problems privately using the repository's security reporting feature when available. Do not include API keys, account credentials, conversation histories or unredacted logs in a public issue.
