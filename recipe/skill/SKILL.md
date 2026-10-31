---
name: openai-bridge
description: 用户要把自己有权使用的 OpenAI Chat Completions API 接入 cccodroid，或检查本机 OpenAI 协议桥的配置、启动和停止时使用；预览组件，不提供模型或额度。
---

# OpenAI API 本地协议桥（预览）

先自检（只用临时目录和随机回环端口，不读用户密钥、不发收费推理请求）：

```sh
openai-bridge --selftest
openai-bridge status
```

**预览组件：** 还没在真机上走完签名安装、App 聊通和完整卸载，App 里标「未经真机验证」。只用受管理入口 `openai-bridge`，不要直接运行原版 `ccr`、不要暴露到公网、不要单独升级 CCR（安全补丁按指纹对 1.0.73 打，换版本会拒绝启动）。依赖修复范围见源仓库 `SECURITY.md`。

**1.0.5-r7 本地配套候选尚未发布：** 新版 App 用不透明 HMAC 通道，旧 Hook 无法识别。此候选在用户配置后只注册非密钥的本机端点/实例，由支持 v1 契约的 App 在包装 URL、启动 CLI 前调用固定组件 `ensure` 并等待健康；不是修改当前 App 就能立即生效的补丁。正式签名配套包、八项交付门槛和原生界面验收仍须完成，不能据源码测试填写 verified.json。

## 运行链路

```text
openai-bridge → 本组件的 component.cjs / installer.cjs（$PREFIX/lib/openai-bridge）
  → 底座 Node、Bash、flock、setsid、timeout（$PREFIX/bin）
  → 专用私有安装目录中的 CCR 1.0.73 副本 + 兼容补丁
  → 127.0.0.1:用户选定端口 的 Anthropic Messages 服务
  → 用户配置且有权使用的 Chat Completions HTTPS API
```

- CCR 和锁定修复依赖由组件 CI 按 npm lockfile 打入包，首次配置不下载运行代码。运行副本、密钥与日志放在当前 HOME 下 `.local/share/ccr-bridge-kit`，不改本组件或底座文件。补丁删除旧静态插件和其他受影响内嵌模块，使用 glob 14.0.3 / minimatch 11.0.3 等固定修复依赖；缺依赖、版本或指纹不符会拒绝启动。
- SessionStart Hook 只匹配 `startup|resume`。仅当会话的 `ANTHROPIC_BASE_URL` 直接指向本桥 `http://127.0.0.1:<port>` 或其下方路径，或经 App 本机 streamfix 包装且解码后严格指向本桥时投递后台看护。只解开一层合法回环包装；其他端口/主机、错误编码、嵌套包装、未设端点、compact/clear 不触发启动。即使是定时任务，是否运行也取决于该会话端点，不按任务类别一概跳过。Hook 不等补丁、服务锁或就绪；异步错误看私有日志，手动 start 会检查就绪，不会静默切模型。
- manifest 记录组件包入口，App 移除后残留 Hook 只写清理日志并退出；已有看护也会退出、不再重启 CCR。不强杀已运行请求，不自动删数据；若入口已删除，请在私有安装目录运行 `bash uninstall.sh --yes` 清理。
- 本地 `/health` 正常只说明桥在运行，不代表远端可用。上游失败不会通过反复重启本地服务修好。
- 服务只监听回环地址。它是用户自有 API 的协议适配，不共享、转售或转发 Claude 订阅账户，不读取 Claude 登录凭据、不改 Claude Code 本体、不绕过模型安全限制。

## 配置

**先向用户说明并确认：** 请求、工具结果和图片会发给他们填写的服务，远端可能收费；配置会新增自己的 SessionStart Hook；不会自动切换当前供应商。用户现有手工桥继续保留，不要自动停掉或覆盖。

用户须自己在终端配置（`configure` 有交互提示，AI 不要直接调用它等输入）：

```sh
openai-bridge configure
```

用户填写完整 Chat Completions URL（例如 `https://api.example.com/v1/chat/completions`）、自己有权使用的 API Key 和模型名。不是 Responses API，也不是仅填服务域名。**不要索要、读取、打印、转述 API Key 或密码，不要读取真实配置或 connection.json。**

已获用户授权后，AI 可非交互启动、查看状态（输出不含密钥）：

```sh
openai-bridge start
openai-bridge status
```

配置完成时会打印本机端点、模型名和本地连接信息的私有文件位置。用户自己到 cccodroid「设置 → 接口与型号 → 自定义接口」填写本机端点及本地桥密钥；不要把远端 API Key 当成本地密钥。该组件没有新增图形配置表单，也不会偷偷改动或切换 App 的供应商配置。

## 停止与卸载

停止或卸载前**必须先得到用户确认**，可能打断现有请求：

```sh
openai-bridge stop --yes
openai-bridge uninstall --yes
```

- stop 保留 Hook，新会话会重启。
- uninstall 先写停用标记，再停止服务、移除本实例非密钥注册和自有 Hook；私有配置、日志保留，不自动删用户数据。残留脚本不能自行恢复已停用实例。
- **仅在用户明确同意永久删除整个专用目录（含密钥和日志）或使用可丢弃的假配置测试时**，执行 `openai-bridge uninstall --yes --purge`。先确认备份需求，不能把普通卸载授权当成清除真实数据的授权。
- 支持 v1 契约的配套 App 在组件管理器卸载前会先停用本注册实例、移除自身 Hook/注册，失败则保留组件；不带 purge。旧 App 仍须先运行此卸载入口，只删组件文件不会清理私有副本或停止已有 CCR。
- 再安装不会自动覆盖旧运行副本，也不会自动给它打安全补丁。源文件/依赖更新后的迁移应另行确认、测试，不能声称自动升级。

## 常见坑

- `status` 健康不等于真实推理成功。向远端发送测试前先询问用户，说明内容和费用。
- 旧可解码包装的 Hook 测试曾出现两次502后重试成功，不能当新版交付证据。配套候选 App 用显式注册/ensure 等待就绪，其他客户端 Hook 仍只是异步；当前安装版 App 尚未获得此源码改动。
- 看护默认连续启动/修补最多3次，健康连续5分钟才自动清预算；持续失败写故障标记并退出，不无限重启。排查后只有获用户明确确认才能运行 `openai-bridge start --reset-recovery --yes`，不要自动重置或借循环 start 绕过预算。
- 组件包解开约 105 MiB；首次配置还会额外复制一份私有运行副本，请预留空间。
- 约每 5 秒探活，重启受失败次数、宽限和探活耗时影响，不保证 5 秒恢复。补丁变化需重启加载，不能未经确认影响别的会话。
- 图片以 image_url 发送；本地图片计数每张 4096 只是估算，不是远端精确计费。实际计费用量以远端返回为准。
- 文件必须在应用私有可执行目录，不在共享存储安装。依赖已随组件打包，不要再跑 npm update。
- 分享日志、发布文件、创建 PR 或删除私有数据前询问用户，并先脱敏。不要把密钥或历史会话发到公共仓库。
