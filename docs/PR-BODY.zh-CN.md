## 组件 / Component

- id: `openai-bridge`（`1.0.2-r2`，预览）
- 源仓库 / Source: https://github.com/chenshi723/cccodroid-openai-bridge
- 协议转换：固定 `@musistudio/claude-code-router` **1.0.73**，MIT；本次另锁定安全修复依赖，并移除私有运行副本中的旧内嵌实现。
- 配方/文档按市场 Apache-2.0 规范提交；桥接脚本 MIT，保留依赖许可证和原作者信息。

## 范围及当前状态

把用户自己有权使用的 **OpenAI Chat Completions API** 适配成本机 Anthropic Messages 接口。消息、工具结果和图片会发给用户自己配置的远端，可能收费；不读取 Claude 订阅凭据、不改 Claude Code、不共享/转售账户、不对外提供服务、不绕过模型安全限制。

**维护者已明确接受收录范围；本 PR 仍保持 Draft，尚未请求合并。** 按维护者回复处理安全及真机验证，主应用配置卡片、生命周期/更新集成留待后续 issue。

## 2026-10-28 安全整改

- `@fastify/static` 固定/override 为 **10.1.2**，`tmp` override 为 **0.2.7**，锁文件重新生成。`npm audit --omit=dev --audit-level=moderate`：**0 vulnerabilities**。
- 不只改外部依赖：对 CCR 内嵌静态插件及目录列表代码做 SHA-256 指纹校验后整段移除，改加载修复版插件。
- 继续检查发现普通 npm audit 看不到的内嵌 Fastify/Undici/ajv/fast-uri/find-my-way/brace-expansion/minimatch/glob/shell-quote 公告；另 **249 个内嵌 CommonJS 模块**同样按指纹移除，加载锁文件固定的修复版本。`SECURITY.md` 列出所有版本和边界。
- 缺依赖、版本不符、bundle 指纹变化或语法错误时，先失败而不覆盖运行程序。仅修补独立私有运行副本，不改底座/组件管理器所有文件或用户现用手工桥。
- 原始 npm 程序及 `.orig` 备份仍是上游原文件，**不能直接运行原版 `ccr`**；支持的组件入口、启动脚本和看护会先验证并应用补丁。
- 源仓库 CI 由非阻断 audit 改成阻断中危及以上；新增有效私有 bundle 审计门禁。84 个剩余内嵌包的公开版本检查：**0 中危/高危/严重匹配**。这里只向 npm 提交公开包名/版本，不上传用户信息。
- 新增安全负例/正例：旧 bundle 在临时假文件上确实能绕过 `allowedPath`；修复后拒绝非规范路径、编码分隔符、路径及目录列表越界。tmp 拒绝 prefix/postfix/dir 越界。

## 功能、卸载与大小

- 保留 effort 映射、取消上游、JSON/SSE 嗅探、工具图片转换、本地图片估算和日志级别修复。
- 配置使用终端私下输入，现有 App「自定义接口」连接本机；不索要、读取或打印用户密钥，不自动切换供应商。
- 默认 `openai-bridge uninstall --yes` 停服务并移除自有 Hook，保留数据；额外显式 `--purge` 才彻底删除专用目录及私有依赖、密钥、日志。真实数据 purge 前单独确认和备份，不能把普通卸载授权当删除授权。
- 旧运行副本不自动升级；主应用只卸包不会自动清私有副本，后续集成另谈。
- 本地构建约 **26.96 MiB gzip / 106.78 MiB tar**（28,264,960 / 111,963,648 字节）；**182 个 npm 包**随组件提供，位于私有命名空间，底座之外额外 Termux 包 **0**。首次配置另复制私有运行副本。
- 源仓库 `recipe/sync.sh` 同步，revision 已从 1 增为 2。

## 已完成的本机检查

设备：Xiaomi M367FC（Xiaomi Pad 9 Pro Max），Android 17 / SDK 37，aarch64，XRing O3 / Mali；普通应用 UID 原生运行，Node 26.4.0、Python 3.14，无 root/Shizuku/chroot/proot。构建基线 `devkit-2026.10.22.3`。

- 16 项安装器单测；独立 npm 安装与组件预装依赖两条完整生命周期（含显式 purge），其他 Hook 与源依赖字节/inode/mtime 保持不变。
- 76 项请求/响应/原子补丁回归，9 项真实 CCR + 回环假上游 HTTP 测试，健康探测正反例和超时测试。
- 真 bundle 的安全模块加载身份、静态路径安全及 tmp 越界回归。
- 外部 audit=0；有效运行 bundle 84 个内嵌包，中危及以上匹配=0。
- `check-recipes.mjs` 通过，8 个底座 `--dry` 解析通过，本地 devkit 包构建通过。
- 最终组件归档另解包到隔离目录，自检及完整配置 → 请求 → 重复安装 → 状态 → 保留数据卸载 → 彻底清理通过，不改 live PREFIX。
- 自检：`CCR=1.0.73 static=10.1.2 JSON/SSE=3/3 effort=OK upstream=loopback-only`。

这些是**隔离本地验证**，不冒充官方签名索引安装或 App 端到端验证。完整记录见源仓库 `TESTING.md`。

## 仍待完成 / Merge blockers

1. **官方签名索引安装 → 配置 → App 自定义接口聊通 → 卸载干净。** 当前未完成，不写 `verified.json`。需要维护者确认 Draft 未合并时的可信预发布签名索引/安装方式，或先后验证顺序；不自行替换官方信任根，也不把本地包当签名包。
2. **市场的 hosted CI 审计及 termux-docker selftest。** 尚待可运行的官方 PR CI，源仓库测试不代替市场审计。
3. 真实 API 推理需用户自己私下配置并确认内容/费用；本轮没有收费请求，没有上传用户截图、对话、日志或凭据，没有中断现用桥。

## Checklist

- [x] `node tools/check-recipes.mjs`
- [x] 8 个底座依赖解析及本地构建
- [x] 外部及有效内嵌依赖安全门禁通过
- [x] 运行链路、实际转发行为和卸载边界已写进 skill
- [x] 首次配置不下载运行代码，不改组件管理器所有文件
- [x] 安全、停止、清数据、花费和公开发布边界明确
- [x] `needs` 不需要 root/Shizuku/GPU/显示
- [x] 维护者已确认本地用户自有 API 协议适配属于允许范围
- [ ] 已核查市场本次 hosted CI 审计报告
- [ ] 官方签名索引 → App 聊通 → 完整卸载真机验证

AI 辅助整理代码、文档和测试；设备验证在贡献者自己的设备上执行。CCR 引擎及 OpenAI API 不属于本贡献原创。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
