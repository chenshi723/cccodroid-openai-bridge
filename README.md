# cccodroid OpenAI API bridge — preview

把用户自己有权使用的 **OpenAI Chat Completions API** 适配为本机 Anthropic Messages 接口，供 cccodroid 的自定义供应商连接使用。

**这是用户在 Android 真机上开发并验证的兼容方案，不是 OpenAI、Anthropic 或 cccodroid 的官方组件。** 不提供模型、API Key 或额度；不转发 Claude 订阅账户、不读取其凭据、不修改 Claude Code 本体、不绕过模型安全限制。

## 当前状态

### r18 看护失联修复（源码候选，未发布）

- 将已通过健康检查的同一进程实例的运行中宽限独立为 **300 秒**（`CCR_BRIDGE_HEALTH_GRACE`，0–3600），启动/连续崩溃仍用原15秒宽限；不是把单次探活超时改成5分钟。
- 看护的探活增加 `--diagnose`：桥请求超时或网络错误时，再用本进程新建的随机回环端口作独立短令牌往返对照。仅当已经监听的对照也被网络阻断或超时，返回退出码2、固定诊断 `LOOPBACK_UNAVAILABLE`；对照无法创建/资源错误仍按普通故障处理。
- 确认本机传输不可用且桥进程身份仍有效时，只等待和继续探测：不杀桥、不启动副本、不消耗恢复预算、不把 PID 存活当就绪。每轮仍检查停用、组件入口与已有故障锁；真正退出仍进入原有限恢复。
- 探测调度出现长空窗时重新累计健康/失败时长，不把无人观察的时间当连续健康清掉预算，也不因唤醒立刻沿旧失败快照重启。
- 这是默认源码策略，随受管组件更新部署后不需要每次启动传环境变量。不会清除旧版本已经写下的故障锁，也不会修改应用本体或安装信任根。**尚未发布、未做隔夜系统后台验收；不声称已证实历史第一次超时的系统原因。**


> **基于正式 1.0.5-r14 的后续源码候选。** 已回迁 r10–r14 的 Android linker 识别、受管升级/卸载残留重配及 reasoning 参数降级修复；本次增加可选多模型、多个 OpenAI 兼容上游、恢复状态一致性、HOME 别名管理和更新瞬态有限确认，尚未发布。 当前 App 的 HMAC 通道不能由旧 Hook 解码识别。本实现改为配置时显式注册不含密钥的本地端点，配套 App 在包装 URL 和启动 CLI 前调用固定组件入口并等待就绪，桥提供有限恢复和身份验证卸载。是否已经发布以 App / 组件各自正式发行记录为准；先发布兼容 App，再发布组件并由用户确认配置或迁移。用户另行授权的本地手工桥适配已报告“退出并重开 App 后仍可使用”；它不是本版本的正式签名安装，也没有验证真正 APK 升级。源码合入不能代替最终签名配套包的八项验收，单独更新组件不能修复旧 App。详见 [交付门槛](docs/DELIVERY-ACCEPTANCE.zh-CN.md)。

- 基于 MIT 许可的 `@musistudio/claude-code-router` **1.0.73**，固定依赖和完整性锁文件。
- 含思考强度映射、上游取消、JSON/SSE 嗅探、工具图片处理、Gemini 3 工具调用签名回传、用量保留、原子补丁、单例启动及看护。
- 本仓库是组件源仓库。通过 `recipe/sync.sh` 将配方和可审查源文件同步到 cccodroid 组件市场；不在仓库提交二进制或 node_modules。
- **正式市场基线已到 1.0.5-r14。** 本候选以市场已发布源码为兼容基线；本次仅在独立源码树和隔离假服务验证，未更新现用组件/运行实例，也不把历史 r5/r9 或本地测试当成新候选的签名发布及原生界面验收。
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

1. 在扩展页安装组件后，点击原桥卡片“卸载”左侧的“配置”。填写共用的 **API 地址、API Key**，可添加多个模型、编辑各自窗口和默认项；用户私下输入真实密钥，不提供给 AI。
2. 根地址或 `/v1` 会明确补全到 `/v1/chat/completions`；其他私有路径须填写完整的 `/chat/completions`，不猜厂商，不支持 Responses API。首次勾选允许读取模型清单后，地址和 Key 填好会自动防抖读取同源 `/models`；可搜索选择，也可手填。仅发送认证读取清单，不发送对话、不调用模型；失败或服务不支持清单时不阻止手填保存。
3. 保存前确认后续数据发送目的地；保存只进行本机配置和健康就绪检查，**不调用远端模型、不消耗模型推理额度，也不切换当前会话**。本地就绪与远端推理状态分开显示。
4. App 自动添加本桥专用接口，不要求手工生成、查找或复制第二把本地密钥。只有点击成功页“新建会话使用”，才为新会话选择此接口；不会改变其他会话或全局默认。
5. 修改时不回显旧 Key，留空保留；更换服务地址来源必须重输。图形配置只管理完整兼容的组件专用实例，不能自动覆盖旧手工桥或不兼容私有运行副本。

### 可选多模型与窗口元数据（schema 1 兼容扩展）

- `gui-configure` stdin 仍接受 `{endpoint, apiKey?, model}`；新增的 **可选** `models` 是 1–100 个唯一模型 ID 字符串的数组，必须包含默认 `model`。ID 去除首尾空白，最长 200 个 UTF-16 单元，不接受空值、逗号、控制字符或去空白后的重复值；不接受 `{id, context_window}` 等对象。整个配置请求上限 128 KiB。未传 `models` 时仍写原单模型格式，不会偷偷保留先前的额外模型。
- 同一来源和 Key 共用一份 CCR Provider；`Providers[0].models` 列出全部配置 ID，`Router.default` 及其他后备路由仍为 `relay,<model>`。App 会话请求可直接发送列表中的精确 ID（含大小写），补丁在思考/长上下文等后备路由前保留此选择；旧 `relay,<id>` 路由仍有效，未知 ID 继续走原 CCR 后备规则。
- `gui-status` / `gui-configure` 的 schema 仍为 **1**，新增返回 `models: string[]`；旧单模型安装可派生 `[model]`，未配置状态为 `[]`。私有 `connection.json` 只在显式传入列表时增添可选 `models`，它须与 CCR Provider 列表完全一致。旧单模型格式与新显式列表均须通过原有实例、源文件/manifest、端口和 Key 校验，不接管不兼容的私有运行副本。
- `gui-models` 的 schema 也仍为 **1**，清单项扩展为 `{id, context_window?}`。窗口只接受上游 `context_window` / `contextWindow` / `max_input_tokens` / `context_length` / `max_context_tokens` 中的 JSON 数字整数 **1024–16777216**（也支持 `top_provider` 对象下这些字段）；按上述字段顺序先查顶层、后查 `top_provider`，取第一个有效值。缺失、字符串、小数、越界值均省略，不把输出 `max_tokens` 当输入容量，也不伪造默认值。清单仍有 1 MiB 响应、128 KiB 结果、500 个唯一 ID、Key 回显过滤和 12 秒超时限制。
- **配置 `models` 只包含 ID。** 每模型窗口由 App 独立存储；没有有效元数据时的 **200000** 默认值由 App 决定，不是组件声称的上游容量。读取清单和保存配置仍互相独立，不会调用真实模型。

### 多个 OpenAI 兼容上游（源码候选）

- 终端 `configure` 会在第一个 API 之后询问是否继续添加；非交互安装也可在私有 `--config` JSON 顶层增加可选 `providers` 数组。顶层 `endpoint`/`apiKey`/`model`/`models` 仍是第一个上游；每个附加项接受 `endpoint`、`apiKey`、`model`、可选 `models` 和可选 `name`。
- 名称默认 `relay`、`relay-2`……，也可给 `name`（小写字母开头、1–32 位小写字母/数字/连字符，保留名 `relay` 只能给第一个上游）。模型 ID 全局唯一时直接暴露；重名时后出现的暴露为 `<provider>/<model>`，避免把请求发错上游。所有上游的可见模型合计仍限 1–100。
- 私有 CCR 配置包含多个 `Providers` 和 `MODEL_ROUTES`（可见 ID → `provider,model`）；`connection.json` 仍保持 schema 1，只含本机地址、本地桥密钥、默认模型和可见模型列表。上游 Key 只存在私有 CCR 配置中（0600）；`openai-bridge status` 只列上游名称、地址和模型 ID，不打印 Key。
- `gui-status` 通过 `capabilities.multiUpstream` 告知配套 App 能力，并返回不含密钥的 `upstreams:[{name,endpoint,hasKey,models:[{id,model?}]}]`。`model` 与可见 `id` 相同时可省略。配套 App 可一次提交完整 `upstreams` 新增、编辑或移除 API，无需卸载；旧单地址表单仍兼容，不会悄悄删掉附加上游。
- `gui-configure` 完整拓扑的每一项只接受 `{name,endpoint,apiKey?,models:[{id,model?}]}`，顶层 `model` 指定全局默认可见 ID，顶层 `models` 必须与展开后的可见 ID 顺序一致。留空 Key 只复用**相同上游名称且同 origin**的已验证 Key；新增名称、改 origin 必须新填，删除主上游时保留剩余上游名称/模型别名。保存仍在共享锁内核对实例、原子提交两份配置，保留恢复故障和本地认证。
- `gui-models` 新增可选 `provider` 指定当前 API，仅查询该 endpoint；留空 Key 按名称和 origin 核对，不会把 A 家 Key 发给 B 家，也不会向其他 API 自动发请求。旧 App 不传 `provider` 时只查主 endpoint。显式 `provider,model` 旧路由保持不变，未知 ID 继续走原 CCR 后备规则。

已安装实例可用以下命令在线管理（先确认没有会话请求运行；私有 JSON 由用户填写，文件权限须为0600）：

```sh
openai-bridge add-provider --config /absolute/private/provider.json --yes
openai-bridge edit-provider --provider relay-2 --config /absolute/private/provider.json --yes
openai-bridge remove-provider --provider relay-2 --yes
```

新增/编辑 JSON 包含 `endpoint`、`apiKey`、`model`、可选 `models`/`name`，不是整个桥配置；编辑时 Key 留空可同名同源保留。命令不会自动更改 App 的接口清单，之后在配套 App 打开配置页保存/同步再新建会话。不能移除最后一个上游，不清恢复锁，不执行外来私有脚本。图形新增/删除入口需要同批配套 App，旧版会继续使用原单 API 表单。

旧 App / 终端仍可用：用户自己运行 `openai-bridge configure`，输入完整 Chat Completions URL、自有 API Key、模型名并确认新增自己的 SessionStart Hook；`openai-bridge start` 等待本地就绪，`openai-bridge status` 查看不含密钥的状态。终端私有 JSON 也接受同样的可选 `models`。没有图形配置支持的 App 仍须在自定义接口中手工填写本机地址、模型和私有连接文件里的本地密钥。不要把远端 Key 当成本地 Key，不要把连接文件发给 AI 或公开。

`openai-bridge --selftest` 只测试回环假上游，不需要账号或真实密钥、不消耗模型额度。

组件 tar 约 **105 MiB**；首次配置会在专用目录再复制一份私有运行副本，需额外空间。

运行目录默认是当前 HOME 下 `.local/share/ccr-bridge-kit`，与组件管理器拥有的 `$PREFIX/lib/openai-bridge` 分开。补丁只修改私有运行副本，组件安装目录保持原样。已有手工桥、原 `.claude-code-router`、现有 Hooks 和 Claude 账户凭据不被覆盖。

### 停止、卸载和更新

```sh
openai-bridge stop --yes
openai-bridge uninstall --yes
```

先确认没有需要保留的请求。stop 保留 Hook，新会话会重启；uninstall 停本安装的看护和桥并移除自有 Hook，但保留私有密钥和日志，用户自己决定是否删除。

**支持 v1 契约的配套 App** 会在组件管理器卸载时先取消在途启动，把注册端点/实例传给固定卸载入口核对，再停用本实例、移除自身 Hook/注册，最后删除组件文件；合法实例停用失败则保留组件供排错。坏注册、未知 schema 或不健康安装记录不能卡住卸载：App 不执行其中提供的路径，只清固定残留注册并继续原有受管文件清理；不能从损坏数据验证进程身份时不承诺已停服，也不猜测删除私有目录。默认保留私有配置，卸载中不能取消。**旧 App 仍须先运行上述 uninstall**：旧版仅删除包文件，不会主动清理 Hook 或停止已有 CCR。残留 Hook/看护发现入口消失后不再启动新 CCR；若包已移除，可在私有安装目录执行 `bash uninstall.sh --yes` 清理。组件更新后，`ensure` 或 GUI 保存会在实例/注册/原文件核对通过后安全停止并原子升级本组件受管运行文件；只读状态/清单不执行旧脚本。此路径不接管外来/手工实例、不读取卸载备份里的旧 Key，也不自动清恢复故障锁。

GUI 的 `localReady` 同时受 `target/disabled` 和 `target/runtime-home/.claude-code-router/recovery.failed` 阻断，不能凭残留健康 HTTP/PID 判断可用。状态和保存保留 `RECOVERY_EXHAUSTED`、`PATCH_VERIFICATION_FAILED`、`COMPONENT_DISABLED` 或 `LOCAL_START_FAILED`；连续保存不会清除故障锁/恢复次数，也不会自动 reset。排查后仍只能由用户显式执行原有 `start --reset-recovery --yes`，没有 GUI 重置按钮。唯一例外是崩溃遗留、内容精确为 `configuring\n` 的配置事务标记：状态查询仍只读阻断，下一次明确保存会在锁内核对身份、停止原实例、完整提交配置后清掉这个临时标记；同内容保存也可完成。其他停用标记和任何恢复故障/次数不清；续配失败保留继承的临时标记供下一次明确保存处理。

市场更新短时移除固定 `component.cjs` 时，已有看护只对入口 `ENOENT` 最多确认 **10 秒**：原 manifest 身份须不变，恢复成规范普通文件才继续，等待期间不 patch/kill/spawn，并释放 `service.lock`、放弃旧事务；返回主循环后非阻塞重取锁，重新核对 manifest、PID/启动时刻与持久预算，别的启动产生的新进程只获得有界就绪宽限。明确 disabled 立即退出，不制造新故障锁；超时仍锁停，不无限等候或复活真卸载。该修复针对已用假服务复现的更新瞬态误判；现场下午停桥日志命中入口不可用分支，但不能据此认定唯一诱因，更不认定是此前首次午夜探活失败的根因。健康失败码带 ISO 时间；看护将其安全有界写入私有 `STATE/health.log`（当前及一份 `.1` 各最多 64 KiB），写入成功不重复输出；日志本身失效时每轮故障最多报告一次固定诊断，只有连续成功探活 300 秒后才重新允许下一轮报告；任何探活失败、PID 消失或入口确认等待都中断计时，不静默丢弃或无界重复追加。不会把响应正文、请求头、对话或密钥写入探活诊断。

HOME 仅在信任根处 realpath 规范，再构造默认目录并传给子进程；显式 `--dir` 及 HOME 下的路径链接核对不放宽。

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
node tests/test-multi-provider.cjs
node tests/test-uninstall-instance.cjs
node tests/test-gui-config.cjs
node tests/test-gui-models.cjs
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

先在本仓库改代码、测试，然后运行 `bash recipe/sync.sh <组件仓库绝对路径>`，在市场仓库执行 `node tools/check-recipes.mjs`、依赖解析和构建审计。任何配方/脚本/skill 修改都要增加 revision（市场基线为 1.0.5-r17，本次候选为 1.0.5-r19；发布前再次核对市场最新 revision）。配方文案的最终版本以市场仓库 `greyoak111/cccodroid-components` 为准，本仓库 `recipe/` 与其保持一致，避免下次同步覆盖。

## 许可与贡献

桥接本地脚本采用 MIT，CCR 的 MIT 许可见 [LICENSE-CCR.txt](LICENSE-CCR.txt)，npm 依赖各自保留许可。市场仓库的配方/文档贡献按其 Apache-2.0 规范提交；来自本仓库的 MIT 源文件保留许可。

Original Android integration and device testing: [@chenshi723](https://github.com/chenshi723). The protocol engine is the separate open-source Claude Code Router project; this repository does not claim to have invented the OpenAI API or CCR.
