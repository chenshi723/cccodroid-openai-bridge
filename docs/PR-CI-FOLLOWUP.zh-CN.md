市场机审已确认通过，补一下当前状态，避免上条“等待批准”造成误解。

### 已核实的官方 CI

[40617306752 / attempt 2](https://github.com/greyoak111/cccodroid-components/actions/runs/40617306752) 的 **check、audit 都是 success**。原始日志为 `openai-bridge：0 错 2 警告`；termux-docker 自检 `rc=0`，JSON/SSE=3/3、effort=OK。

报告自动回贴失败是 fork workflow 的 `addComment` 权限不足，不是审计或 selftest 失败。

完整 hosted Summary 没有作为 artifact 提供，未把本地报告冒充原报告。我在同一归档上按相同规则复现了两类警告：

1. **20 个脚本 shebang 不在应用前缀下**，例如 npm 自带的 `/usr/bin/env node` 和 Bash 脚本；由 termux-exec 兼容，受管理入口实际通过 Node/Bash 启动。官方及本机 selftest、生命周期均通过。
2. **旧底座 Node 26.4.0-2 与仓库 Node 26.12.1 版本漂移**；构建仍按底座固定版本，不会覆盖或升级用户的 Node。

没有为消除提示修改第三方 shebang、降级安全检查或扩大运行入口。临时本地复现只补齐了安装清单未列出的实际符号链接，并跳过 Release 大小对比；生产审计器没有修改。

### 当前工具包已补测

设备已升级 `devkit-2026.10.28`（base `3768afcf79a7…`）、Node 26.12.1 / Python 3.14.8。重新跑完整测试和双层依赖审计，全部通过；也针对当前 base 重新打包并在隔离目录完成 selftest、配置、假上游请求、重复安装、状态、卸载及显式 purge。未操作现用桥、真实密钥或收费 API，没有生成 `verified.json`。

### 签名安装仍需要一个可信构件

我下载了官方 `components.json` 和 `.sig`，用与 App 内置一致的 Ed25519 公钥验签成功。索引生成时间 `2026-10-28T04:44:54.409Z`，28 个组件里**没有 openai-bridge**，对应官方 Release 也不存在。因此当前不能从官方签名索引安装，不是 App 里填一下配置就能继续。

可以请你提供一个**用 App 已信任公钥可验证的预发布签名索引/包**，或明确允许先后调整为“合并并出签名包后立即补真机记录”吗？如果走后者，请维护者明确确认例外及顺序，我不会自行把未完成项勾成已完成，也不会擅自转 Ready/请求合并。目前仍保持 Draft。

你提出的两处 Hook 生命周期修改已实现并推送为 **1.0.3-r3**（源码提交 `ed0e633`，组件配方提交 `cd7d67d`），并补了隔离回归：SessionStart 只匹配 `startup|resume`，`--hook` 仅在 `ANTHROPIC_BASE_URL` 指向本桥时异步拉起看护；manifest 记录组件入口，入口消失时不自启并记录清理提示；包体约 107 MiB 已写进描述。

源码完整测试、外部 audit 和有效 bundle audit 均通过；市场配方格式检查和 8 个底座依赖 dry 解析也通过。PR 仍保持 Draft，尚未请求合并。

拿到构件后，按官方签名安装 → 用户自己私下配置 → App 仅发预先确认的测试消息 → 彻底卸载及核对 Hook/文件的流程补证据。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
