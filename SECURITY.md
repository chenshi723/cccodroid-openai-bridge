# Security and scope

This is a local, opt-in protocol adapter for an API that the end user is authorized to use. It is not an account-sharing service or a public gateway. It does not read Claude subscription credentials, modify the Claude Code binary, remove model safety controls, or provide any API quota.

- Listen only on `127.0.0.1`. Never expose the listener through port forwarding or a public reverse proxy.
- Requests, including tool results and images, are sent to the Chat Completions endpoint configured by the user. Users must review that service's privacy policy, authorization and billing rules.
- Users enter their own API keys privately. Do not request, print, commit or publish them. Local connection keys and upstream API keys are different secrets.
- Runtime state and credentials belong in a dedicated private HOME, not in the source repository or shared Android storage. Files containing credentials use mode 600.
- Do not enable debug logging with real conversations unless necessary. Upstream errors and diagnostic logs may contain sensitive data.
- Health checks test the local process only, not upstream availability or successful model inference.

## Known dependency limitation

The compatibility patches target **`@musistudio/claude-code-router` 1.0.73**. A current `npm audit --omit=dev` reports **6 dependency advisories (2 high, 1 moderate, 3 low)**, including `@fastify/static` path/route handling and `tmp` temporary-file handling through the interactive-editor dependency chain. This project has not established that the bundled CCR server is unaffected. Restricting the listener to loopback is not a complete security fix.

The CCR CLI contains bundled dependency code. Overriding only external npm dependencies does not prove the bundled implementation is patched. `npm audit fix --force` proposes a breaking CCR upgrade, which invalidates the exact code anchors used here. Do not hide the audit report or claim that the bridge is vulnerability-free.

**The initial cccodroid component proposal must remain a draft pending maintainer review of both these advisories and the market's protocol-adapter scope.** Production distribution should wait for a supported and re-tested runtime or a reviewed remediation of the bundled dependencies.

Report security problems privately using the repository's security reporting feature when available. Do not include API keys, account credentials, conversation histories or unredacted logs in a public issue.
