# cccodroid OpenAI API bridge — preview

把用户自己有权使用的 **OpenAI Chat Completions API** 适配为本机 Anthropic Messages 接口，供 cccodroid 的自定义供应商连接使用。

**这是用户在 Android 真机上开发并验证的兼容方案，不是 OpenAI、Anthropic 或 cccodroid 的官方组件。** 不提供模型、API Key 或额度；不转发 Claude 订阅账户、不读取其凭据、不修改 Claude Code 本体、不绕过模型安全限制。

## 当前状态

> **1.0.5-r8 配套生命周期修复。** 当前 App 的 HMAC 通道不能由旧 Hook 解码识别。本实现改为配置时显式注册不含密钥的本地端点，配套 App 在包装 URL 和启动 CLI 前调用固定组件入口并等待就绪，桥提供有限恢复和身份验证卸载。是否已经发布以 App / 组件各自正式发行记录为准；先发布兼容 App，再发布组件并由用户确认配置或迁移。用户另行授权的本地手工桥适配已报告“退出并重开 App 后仍可使用”；它不是本版本的正式签名安装，也没有验证真正 APK 升级。源码合入不能代替最终签名配套包的八项验收，单独更新组件不能修复旧 App。详见 [交付门槛](docs/DELIVERY-ACCEPTANCE.zh-CN.md)。

- 基于 MIT 许可的 `@musistudio/claude-code-router` **1.0.73**，固定依赖和完整性锁文件。
- 含思考强度映射、上游取消、JSON/SSE 嗅探、工具图片处理、用量保留、原子补丁、单例启动及看护。
- 本仓库是组件源仓库。通过 `recipe/sync.sh` 将配方和可审查源文件同步到 cccodroid 组件市场；不在仓库提交二进制或 node_modules。
- **已上架，尚未真机验证。** [PR #53](https://github.com/greyoak111/cccodroid-components/pull/53) 已于 2026-10-30 合并，官方 CI 已打包签名并发布 **1.0.4-r5**（签名索引指向该修订）。签名索引安装 → App 聊通 → 干净卸载及单独的 `verified.json` 仍待补做，App 里暂标「未经真机验证」。
- **旧本地候选 1.0.5-r6（未发布，已被新协议阻塞）：** 仅修复可解码包装的 Hook 匹配，不支持当前不透明通道。r7 不再依靠新包装格式；保留的旧解码路径只用于旧客户端兼容，不代表新版 App 支持。
- **历史冷启动边界：** r6 在旧可解码协议的网关/CLI隔离测试中能自动启动，但每轮先两次502再靠CLI重试恢复；不是当前安装版或“首请求前就绪”的通过记录。v1 配套实现改用 App preflight 等待就绪，完整结果仍须按证据层级验收。
- **1.0.4 修复 Hook 生命周期：** SessionStart 仅匹配 `startup|resume`；在启动 Node、检查依赖、写日志或等锁前严格匹配本桥地址及端口边界。匹配时只投递后台看护，不等补丁或就绪；入口删除后，已有看护也会退出，不再重启 CCR。
- **安全整改：** 保留静态插件 10.1.2、tmp 0.2.7 及 249 个受影响内嵌模块的指纹替换；1.0.5 候选另外锁定并 override glob **14.0.3** / minimatch **11.0.3**，处理提交前新发现的中危通告，同步调整实际 bundle 替换和安全回归。双层审计及边界见 [SECURITY.md](SECURITY.md)，不表示原版 CCR 或所有代码都无漏洞。

交付收敛记录见 [八项验收矩阵](docs/DELIVERY-ACCEPTANCE.zh-CN.md) 和 [发布/迁移交接](docs/RELEASE-HANDOFF.zh-CN.md)。其中“本地通过”不等于“正式交付”；真实 App 更新、签名配套安装和原生界面验收未完成。

## 运行方式

```text
用户的 cccodroid / Claude Code
  → http://127.0.0.1:端口/v1/messages（本机随机密钥）
  → 独立 HOME 中的 CCR + 兼容补丁
  → 用户配置的 Chat Completions API（用户自己的远端 API Key）
```

远端收到消息、工具结果和图片，按其隐私及收费规则处理。请只配置你有权使用且信任的 API。服务不暴露公网，也不应拿来共享、包装或转售账户。

## 组件使用

组件管理器会按 npm lockfile 校验并预装 CCR 依赖，不在第一次配置时下载代码。

配套 App 提供图形配置：

1. 在扩展页安装组件后，点击原桥卡片“卸载”左侧的“配置”。只填 **API 地址、API Key、模型名称**，用户私下输入真实密钥，不提供给 AI。
2. 根地址或 `/v1` 会明确补全到 `/v1/chat/completions`；其他私有路径须填写完整的 `/chat/completions`，不猜厂商、不自动拉远端模型清单，不支持 Responses API。
3. 保存前确认后续数据发送目的地；保存只进行本机配置和健康就绪检查，**不调用远端模型、不消耗模型推理额度，也不切换当前会话**。本地就绪与远端推理状态分开显示。
4. App 自动添加本桥专用接口，不要求手工生成、查找或复制第二把本地密钥。只有点击成功页“新建会话使用”，才为新会话选择此接口；不会改变其他会话或全局默认。
5. 修改时不回显旧 Key，留空保留；更换服务地址来源必须重输。图形配置只管理完整兼容的组件专用实例，不能自动覆盖旧手工桥或不兼容私有运行副本。

旧 App / 终端仍可用：用户自己运行 `openai-bridge configure`，输入完整 Chat Completions URL、自有 API Key、模型名并确认新增自己的 SessionStart Hook；`openai-bridge start` 等待本地就绪，`openai-bridge status` 查看不含密钥的状态。没有图形配置支持的 App 仍须在自定义接口中手工填写本机地址、模型和私有连接文件里的本地密钥。不要把远端 Key 当成本地 Key，不要把连接文件发给 AI 或公开。

`openai-bridge --selftest` 只测试回环假上游，不需要账号或真实密钥、不消耗模型额度。

组件 tar 约 **105 MiB**；首次配置会在专用目录再复制一份私有运行副本，需额外空间。

运行目录默认是当前 HOME 下 `.local/share/ccr-bridge-kit`，与组件管理器拥有的 `$PREFIX/lib/openai-bridge` 分开。补丁只修改私有运行副本，组件安装目录保持原样。已有手工桥、原 `.claude-code-router`、现有 Hooks 和 Claude 账户凭据不被覆盖。

### 停止、卸载和更新

```sh
openai-bridge stop --yes
openai-bridge uninstall --yes
```

先确认没有需要保留的请求。stop 保留 Hook，新会话会重启；uninstall 停本安装的看护和桥并移除自有 Hook，但保留私有密钥和日志，用户自己决定是否删除。

**支持 v1 契约的配套 App** 会在组件管理器卸载时先取消在途启动，把注册端点/实例传给固定卸载入口核对，再停用本实例、移除自身 Hook/注册，最后删除组件文件；合法实例停用失败则保留组件供排错。坏注册、未知 schema 或不健康安装记录不能卡住卸载：App 不执行其中提供的路径，只清固定残留注册并继续原有受管文件清理；不能从损坏数据验证进程身份时不承诺已停服，也不猜测删除私有目录。默认保留私有配置，卸载中不能取消。**旧 App 仍须先运行上述 uninstall**：旧版仅删除包文件，不会主动清理 Hook 或停止已有 CCR。残留 Hook/看护发现入口消失后不再启动新 CCR；若包已移除，可在私有安装目录执行 `bash uninstall.sh --yes` 清理。重复配置不偷偷迁移、覆盖或自动升级旧运行实例；旧副本不会因组件更新自动获得安全修复。

若是可丢弃的验证安装，或已经另行备份并确认永久删除整个专用目录，可执行 `openai-bridge uninstall --yes --purge`。这会连同私有依赖、密钥、配置、日志一起删除，不是默认行为；操作真实数据前必须单独得到用户同意。其他 Claude 设置及其备份不删除。

## 独立源码安装

需要 Node 22+、npm、Bash 4+、curl、flock、setsid、timeout、readlink、tee、base64 和 Linux `/proc`。无需 root/Shizuku。把源码放在 Android 应用私有目录或 Linux 可执行目录，不能在共享存储安装依赖。

用户在自己的终端运行 `bash install.sh` 按提示配置。独立安装器按锁文件执行 `npm ci --ignore-scripts`，首次需要访问 npm；组件版本使用包内预装依赖，不另行联网安装。两种方式都不会读取 Claude 登录凭据或自动切换 App 设置。

不要向任何 AI 索要、展示真实 Key。配置示例只有保留域名和占位字符串。

## 测试

```sh
npm ci --ignore-scripts --omit=dev --no-audit --no-fund
node tests/test-registration.cjs
node tests/test-installer.cjs
node tests/test-hooks.cjs
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

先在本仓库改代码、测试，然后运行 `bash recipe/sync.sh <组件仓库绝对路径>`，在市场仓库执行 `node tools/check-recipes.mjs`、依赖解析和构建审计。任何配方/脚本/skill 修改都要增加 revision（1.0.5-r8 含本轮审查修正；已发布版本以市场正式索引为准）。配方文案的最终版本以市场仓库 `greyoak111/cccodroid-components` 为准，本仓库 `recipe/` 与其保持一致，避免下次同步覆盖。

## 许可与贡献

桥接本地脚本采用 MIT，CCR 的 MIT 许可见 [LICENSE-CCR.txt](LICENSE-CCR.txt)，npm 依赖各自保留许可。市场仓库的配方/文档贡献按其 Apache-2.0 规范提交；来自本仓库的 MIT 源文件保留许可。

Original Android integration and device testing: [@chenshi723](https://github.com/chenshi723). The protocol engine is the separate open-source Claude Code Router project; this repository does not claim to have invented the OpenAI API or CCR.
