---
name: openai-bridge
description: 用户要把自己有权使用的 OpenAI Chat Completions API 接入 cccodroid，或检查本机 OpenAI 协议桥的配置、启动和停止时使用；这是待安全评审的预览组件，不提供模型或额度。
---

# OpenAI API 本地协议桥（预览）

先自检（只用临时目录和随机回环端口，不读用户密钥、不发收费推理请求）：

```sh
openai-bridge --selftest
openai-bridge status
```

**预览限制：** 维护者已接受本地协议适配范围；发布仍待 CI 审计和签名安装、App 聊通及卸载验证。1.0.2 将外部及受影响内嵌依赖换为锁定修复版本，范围见源仓库 `SECURITY.md`；不代表原版 CCR 或所有代码无漏洞。只用受管理入口，不直接运行原版 `ccr`，不暴露公网，不直接升级 CCR 后沿用旧补丁。

## 运行链路

```text
openai-bridge → 本组件的 component.cjs / installer.cjs（$PREFIX/lib/openai-bridge）
  → 底座 Node、Bash、flock、setsid、timeout（$PREFIX/bin）
  → 专用私有安装目录中的 CCR 1.0.73 副本 + 兼容补丁
  → 127.0.0.1:用户选定端口 的 Anthropic Messages 服务
  → 用户配置且有权使用的 Chat Completions HTTPS API
```

- CCR 和锁定修复依赖由组件 CI 按 npm lockfile 打入包，首次配置不下载运行代码。运行副本、密钥与日志放在当前 HOME 下 `.local/share/ccr-bridge-kit`，不改本组件或底座文件。补丁删除旧静态插件和其他受影响内嵌模块，缺依赖或指纹不符会拒绝启动。
- 每次会话开始的 Hook 只检查/启动这个本地服务。独立运行 HOME 避免覆盖已有的 `.claude-code-router`。缺少程序、未配置或端口冲突会明确失败，不会静默切换其他模型。
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

配置完成时会打印本机端点、模型名和本地连接信息的私有文件位置。用户自己到 cccodroid「设置 → 模型服务 → 自定义接口」填写本机端点及本地桥密钥；不要把远端 API Key 当成本地密钥。该组件没有新增图形配置表单，也不会偷偷改动或切换 App 的供应商配置。

## 停止与卸载

停止或卸载前**必须先得到用户确认**，可能打断现有请求：

```sh
openai-bridge stop --yes
openai-bridge uninstall --yes
```

- stop 保留 Hook，新会话会重启。
- uninstall 停服务并只移除自有 Hook；私有配置、日志保留，不自动删用户数据。
- **仅在用户明确同意永久删除整个专用目录（含密钥和日志）或使用可丢弃的假配置测试时**，执行 `openai-bridge uninstall --yes --purge`。先确认备份需求，不能把普通卸载授权当成清除真实数据的授权。
- 在 App 里卸载组件前先运行此卸载入口，避免遗留看护和自动启动 Hook。只在 App 移除组件文件不会自动清理私有运行副本。
- 再安装不会自动覆盖旧运行副本，也不会自动给它打安全补丁。源文件/依赖更新后的迁移应另行确认、测试，不能声称自动升级。

## 常见坑

- `status` 健康不等于真实推理成功。向远端发送测试前先询问用户，说明内容和费用。
- 约每 5 秒探活，重启受失败次数、宽限和探活耗时影响，不保证 5 秒恢复。补丁变化需重启加载，不能未经确认影响别的会话。
- 图片以 image_url 发送；本地图片计数每张 4096 只是估算，不是远端精确计费。实际计费用量以远端返回为准。
- 文件必须在应用私有可执行目录，不在共享存储安装。依赖已随组件打包，不要再跑 npm update。
- 分享日志、发布文件、创建 PR 或删除私有数据前询问用户，并先脱敏。不要把密钥或历史会话发到公共仓库。
