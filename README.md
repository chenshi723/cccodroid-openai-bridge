# cccodroid OpenAI API bridge — preview

把用户自己有权使用的 **OpenAI Chat Completions API** 适配为本机 Anthropic Messages 接口，供 cccodroid 的自定义供应商连接使用。

**这是用户在 Android 真机上开发并验证的兼容方案，不是 OpenAI、Anthropic 或 cccodroid 的官方组件。** 不提供模型、API Key 或额度；不转发 Claude 订阅账户、不读取其凭据、不修改 Claude Code 本体、不绕过模型安全限制。

## 当前状态

- 基于 MIT 许可的 `@musistudio/claude-code-router` **1.0.73**，固定依赖和完整性锁文件。
- 含思考强度映射、上游取消、JSON/SSE 嗅探、工具图片处理、用量保留、原子补丁、单例启动及看护。
- 本仓库是组件源仓库。通过 `recipe/sync.sh` 将配方和可审查源文件同步到 cccodroid 组件市场；不在仓库提交二进制或 node_modules。
- **尚未被组件市场收录。** 维护者已接受协议适配范围；[PR #53](https://github.com/greyoak111/cccodroid-components/pull/53) 仍保持 Draft，等待 CI 审计及签名安装 → App 聊通 → 干净卸载验证。
- **1.0.3 修复 Hook 生命周期：** SessionStart 仅匹配 `startup|resume`，并只在 `ANTHROPIC_BASE_URL` 指向本桥时异步拉起看护；App 移除组件后私有副本会拒绝自启并记录清理提示。
- **1.0.2 安全整改仍包含：** 静态插件换为 10.1.2、tmp 换为 0.2.7，另移除 249 个受影响内嵌模块并加载锁定修复版；双层审计检查见 [SECURITY.md](SECURITY.md)。这不表示原版 CCR 或所有代码都无漏洞。

## 运行方式

```text
用户的 cccodroid / Claude Code
  → http://127.0.0.1:端口/v1/messages（本机随机密钥）
  → 独立 HOME 中的 CCR + 兼容补丁
  → 用户配置的 Chat Completions API（用户自己的远端 API Key）
```

远端收到消息、工具结果和图片，按其隐私及收费规则处理。请只配置你有权使用且信任的 API。服务不暴露公网，也不应拿来共享、包装或转售账户。

## 组件使用（仅在维护者收录并发布后）

组件管理器会按 npm lockfile 校验并预装 CCR 依赖，不在第一次配置时下载代码。

1. 安装 `openai-bridge` 后运行 `openai-bridge --selftest`，只测试回环假上游，不需要账号、不消耗模型额度。
2. **用户自己**在终端运行 `openai-bridge configure`，输入完整 Chat Completions URL、自有 API Key 和模型名；密钥不回显。不支持 Responses API。
3. 确认新增 SessionStart Hook。运行 `openai-bridge start` 启动，`openai-bridge status` 查看不含密钥的状态。
4. 在 App 设置的「自定义接口」手动填入配置完成时显示的本机地址、模型以及私有连接文件中的本地密钥。不要把远端 Key 当成本地 Key，不要把连接文件发给 AI 或公开。

组件归档解开约 **107 MiB**；首次配置还会在专用目录复制约 **98 MiB** 私有运行副本。
5. 组件不会自动改写 App 的供应商列表，也不自动切换正在用的供应商。**此提案没有实现专用图形配置卡片**；若上游希望在 App 内直接填 OpenAI URL/Key/模型，可在确认范围后另开主应用 PR。

运行目录默认是当前 HOME 下 `.local/share/ccr-bridge-kit`，与组件管理器拥有的 `$PREFIX/lib/openai-bridge` 分开。补丁只修改私有运行副本，组件安装目录保持原样。已有手工桥、原 `.claude-code-router`、现有 Hooks 和 Claude 账户凭据不被覆盖。

### 停止、卸载和更新

```sh
openai-bridge stop --yes
openai-bridge uninstall --yes
```

先确认没有需要保留的请求。stop 保留 Hook，新会话会重启；uninstall 停本安装的看护和桥并移除自有 Hook，但保留私有密钥和日志，用户自己决定是否删除。

**在 App 卸载组件前先运行上述 uninstall。** 市场组件卸载只删除包内文件，不会自动结束私有副本或移除 Hook。重复配置保留现有配置，不偷偷迁移、覆盖或自动升级旧运行实例；旧版运行副本不会因组件更新自动获得安全修复。

若是可丢弃的验证安装，或已经另行备份并确认永久删除整个专用目录，可执行 `openai-bridge uninstall --yes --purge`。这会连同私有依赖、密钥、配置、日志一起删除，不是默认行为；操作真实数据前必须单独得到用户同意。其他 Claude 设置及其备份不删除。

## 独立源码安装

需要 Node 22+、npm、Bash 4+、curl、flock、setsid、timeout、readlink、tee 和 Linux `/proc`。无需 root/Shizuku。把源码放在 Android 应用私有目录或 Linux 可执行目录，不能在共享存储安装依赖。

用户在自己的终端运行 `bash install.sh` 按提示配置。独立安装器按锁文件执行 `npm ci --ignore-scripts`，首次需要访问 npm；组件版本使用包内预装依赖，不另行联网安装。两种方式都不会读取 Claude 登录凭据或自动切换 App 设置。

不要向任何 AI 索要、展示真实 Key。配置示例只有保留域名和占位字符串。

## 测试

```sh
npm ci --ignore-scripts --omit=dev --no-audit --no-fund
node tests/test-installer.cjs
node tests/test-install-e2e.cjs
node tests/test-install-e2e.cjs --bundled
node tests/test-response.cjs
node tests/test-security.cjs
python3 tests/test-integration.py
node runtime/selftest.cjs
npm audit --omit=dev --audit-level=moderate
node tests/audit-bundle.cjs
```

测试使用临时目录、假配置、随机回环端口，不读用户 Key，不向真实模型发请求，不触碰正在工作的桥。`npm audit --omit=dev` 是另行的安全检查，不是通过条件的替代品；已知报告不能隐藏。

本地验证记录和限制见 [TESTING.md](TESTING.md)。尚未完成签名市场包的正式安装/卸载验证，不向市场 `verified.json` 伪造记录。

## 向组件市场同步

先在本仓库改代码、测试，然后运行 `bash recipe/sync.sh <组件仓库绝对路径>`，在市场仓库执行 `node tools/check-recipes.mjs`、依赖解析和构建审计。任何配方/脚本/skill 修改都要增加 revision（当前 1.0.3-r3）。提案尚未发布。

## 许可与贡献

桥接本地脚本采用 MIT，CCR 的 MIT 许可见 [LICENSE-CCR.txt](LICENSE-CCR.txt)，npm 依赖各自保留许可。市场仓库的配方/文档贡献按其 Apache-2.0 规范提交；来自本仓库的 MIT 源文件保留许可。

Original Android integration and device testing: [@chenshi723](https://github.com/chenshi723). The protocol engine is the separate open-source Claude Code Router project; this repository does not claim to have invented the OpenAI API or CCR.
