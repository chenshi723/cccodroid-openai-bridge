## 组件 / Component

- id: `openai-bridge`，**1.0.4-r4**（预览）
- 源仓库：https://github.com/chenshi723/cccodroid-openai-bridge
- 协议引擎：固定 `@musistudio/claude-code-router` **1.0.73**，MIT；安全依赖版本及内嵌模块替换边界见 `SECURITY.md`。
- 配方/文档按市场 Apache-2.0 规范贡献；桥本地脚本 MIT，保留原作者与依赖许可证。

## 范围与发布顺序

适配用户自己有权使用的 **OpenAI Chat Completions API** 为本机 Anthropic Messages 接口。消息、工具结果和图片会发给用户配置的远端，可能收费；不读取 Claude 订阅凭据、不修改 Claude Code、不共享或转售账户、不暴露公网、不绕过模型安全限制。

维护者已接受收录范围，认可前版安全整改，并确认第三方 shebang、底座 Node 版本漂移两类提示不算问题。本轮修订已完成，按维护者要求及贡献者确认转为正式审查；不设置自动合并，也不自行合并。

**已按 2026-10-29 的回复确认流程：合并 → 官方 CI 打包并签名发布 → 真机从签名索引安装、App 实聊、完整卸载 → 另提 `verified.json`。不需要预发布签名索引，合并时间由维护者决定。** 尚未做的真机验证保持未勾选，不把本地包或假上游当成正式 App 验证。

## 合并前 Hook 修改

- Hook 仅匹配 `startup|resume`。`--hook` 在启动 Node、改 HOME、检查依赖、写日志或等锁**之前**校验 `ANTHROPIC_BASE_URL`：只接受本桥的完整 `http://127.0.0.1:<port>` 或其下方路径，不接受相似端口、userinfo 或其他主机。未设/其他接口立即无输出退出。
- 匹配后仅投递单例 watchdog；不在 Hook 里等服务锁、补丁验证或 HTTP 就绪。watchdog 在启动 CCR 前仍验证安全补丁；手动 `start` 保留就绪检查及明确失败状态。Hook timeout 保持 20 秒作为保险，不拿它当正常等待时间。
- manifest 指向**组件包入口**，不指向私有复制品。入口删除或元数据无效时，Hook 不启动、手动 start 报失败，私有日志记录清理提示。
- 已运行 watchdog 每轮及补丁完成后、spawn 前也检查入口；组件删除后退出，不会稍后又重启 CCR。不强杀可能在处理请求的现有 CCR、不自动删用户数据。包已经移除时，仍可在专用私有目录执行 `bash uninstall.sh --yes` 停服务、移除自有 Hook；彻底删除须单独确认 `--purge`。
- 修正了前版锁文件里误写的 `@protobufjs/float` 版本元数据，使其恢复为 tarball 对应的 **1.0.2**；该依赖的 resolved URL、integrity 及实际代码没有变。
- 版本与 revision 提升到 **1.0.4-r4**，由源仓库 `recipe/sync.sh` 同步，不直接改市场副本。

## 功能与依赖安全

- 保留 effort 映射、上游取消、JSON/SSE 嗅探、工具图片转换、本地图片估算和日志级别修复。终端由用户私下配置，App 使用现有自定义接口；不新增图形配置卡、不自动切供应商。
- `@fastify/static` 10.1.2、tmp 0.2.7；对 CCR 内嵌旧静态插件及另外 249 个受影响 CommonJS 模块按 SHA-256 指纹移除、加载锁定修复依赖。未知指纹、缺依赖或语法错误在写文件/启动前失败。
- 外部 `npm audit --omit=dev --audit-level=moderate`：**0 vulnerabilities**；有效私有 bundle 剩余 84 个可识别内嵌包，公开公告中危/高危/严重匹配 **0**。这只是检查时点的结果，不是所有代码无漏洞的承诺。
- 原版 npm bundle 及 `.orig` 备份仍是上游原件，不能绕过受管理入口直接运行 `ccr`。只修补私有运行副本，不改组件管理器、底座或用户现用手工桥的文件。
- 两层安全门禁均为 CI 阻断检查。安全回归在临时假文件上复现原版路径绕过，验证修复后的实际模块身份、路径/编码分隔符拦截和 tmp 越界拒绝。

## 本轮验证

环境：Xiaomi M367FC / Xiaomi Pad 9 Pro Max，Android 17 / SDK 37，aarch64，XRing O3 / Mali；普通应用 UID 原生运行。当前 `devkit-2026.10.28`（base `3768afcf79a7…`）、Node 26.12.1、Python 3.14.8；未用 root/Shizuku/chroot/proot。

- 干净 `npm ci --ignore-scripts --omit=dev` 后完整 `npm test` 通过：17 项安装单测、**新增 9 项隔离 Hook 回归**、76 项转换/原子补丁回归、9 项真实 CCR + 回环假上游 HTTP 测试、健康探测和自检。
- Hook 回归覆盖：无 Node 环境下其他接口/空端点跳过、端口前缀/userinfo/主机误匹配、延迟补丁时冷启动快速返回、`/v1` 路径及并发单例、service.lock 占用、端口冲突不误杀、缺入口/坏 manifest、补丁中删除入口、已运行 watchdog 删除入口后退出且不重启。
- 独立 npm 与组件预装两种完整生命周期均通过。测试先安装但**不启动**，证明非本桥冷 Hook 不起任何进程，再经匹配 Hook 异步拉起真实修复 CCR、发送假请求；重复安装/状态/卸载/显式 purge 均通过。删除入口只操作临时复制的组件源，不再临时重命名仓库真入口。
- `check-recipes.mjs` 通过；本地 PR 分支现有 8 个底座 dry 解析通过，另用当前 2026.10.28 官方 base lock 单独构建并校验。没有擅自改公共 `bases.json`；上游 main 已有新底座。
- 最终归档另解包到新私有工作目录，自检 3/3、真实 CCR 冷 Hook 启动及完整安装/卸载/purge 通过。不是 live PREFIX 安装，不写 `verified.json`。

## 包大小和隔离

当前底座本地构建：**26.96 MiB gzip / 106.78 MiB tar**（28,266,668 / 111,968,768 字节）；7,343 个文件、182 个 npm 包，底座之外额外 Termux 包 **0**。描述中保留约 **107 MiB** 提示。首次配置还复制一份私有运行副本，需要额外空间。npm 依赖全部在组件私有命名空间，不覆盖 Cloudflare 等组件依赖。

默认 uninstall 停进程、移除自有 Hook 并保留数据；`--purge` 才永久删整个专用目录及密钥/日志，须单独授权。旧版私有运行副本不自动迁移或悄悄升级，不能把组件包更新说成现有副本已获修复。

## CI 状态与后续验证

- 旧 1.0.2-r2 的市场 [40617306752 / attempt 2](https://github.com/greyoak111/cccodroid-components/actions/runs/40617306752) check/audit 已通过，selftest rc=0；其结果**不冒充当前修订的新 CI**。新提交由本 PR 再跑；fork 可能需维护者批准。
- 维护者接受的两个警告已本地复现，完整 hosted Summary 未作为 artifact 提供；报告自动回贴失败原因是 fork token 无 addComment 权限，不是 selftest 失败。
- **合并签名发布后补**：正式索引安装 → 用户私下配置 → 预先确认内容/费用的 App 实聊 → 完整卸载及无关设置/文件核对 → 单独 `verified.json`。当前没有完成这条链路。
- 本轮未读真实 API Key、未调用收费模型、未上传私人会话/日志/截图、未切供应商、未中断现用桥。

## Checklist

- [x] 按维护者要求收窄 Hook 范围及避免就绪阻塞
- [x] 入口删除后阻止 Hook 和已有 watchdog 自启/重启
- [x] matcher 和约 107 MiB 描述已补
- [x] 新增冷启动、端点边界和删除竞态测试
- [x] 完整源码测试、双层审计、配方校验及本地归档测试
- [x] 明确合并后官方签名发布再补真机验证的顺序
- [ ] 当前修订市场 hosted CI（不拿旧版通过冒充）
- [ ] 合并后正式签名索引 → App 实聊 → 完整卸载 → verified.json

AI 辅助整理代码、文档及测试；设备测试在贡献者自己的设备执行。CCR 引擎和 OpenAI API 不属于本贡献原创。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
