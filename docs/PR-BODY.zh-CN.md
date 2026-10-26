## 组件 / Component

- id: `openai-bridge`（`1.0.1-r1`，预览）
- 源仓库 / Source: https://github.com/chenshi723/cccodroid-openai-bridge
- 协议引擎 / Runtime: `@musistudio/claude-code-router` **1.0.73**（固定版本），MIT
- 配方/文档按本仓库 Apache-2.0 规范提交；源仓库中的桥接本地脚本为 MIT，包内保留两份许可证及原作者信息。

## 为什么提交 / What and why

我是 cccodroid 用户，在 Android 真机上做了一套本地兼容方案，让用户自己有权使用的 **OpenAI Chat Completions API** 可以通过本机 Anthropic Messages 接口用于 cccodroid。希望维护者考虑作为可选组件收录，让有需要的用户不用重复手工部署。

**这是 Draft / RFC，不请求当前状态直接合并发布。**

### 请先决定收录范围

我读过市场“不收反代、共享或转售账户”等规则。这个工具确实会把用户请求经本机服务转发给他们配置的远端 API，因此这里如实披露，不主张靠“协议桥”的名称豁免规则。它只用于用户自有且有权使用的 API，不读取 Claude 订阅凭据，不改 Claude Code 程序，不共享、转售或转发订阅账户，不绕过模型安全限制。**如果本地协议适配也在市场禁收的“反代”范围内，请直接拒绝此提案；我会尊重这个边界，不拆分或换名绕过。**

### 功能范围

- 锁定 CCR 1.0.73，npm lockfile 校验完整性；CI `npm ci --ignore-scripts --omit=dev`，不提交 node_modules 或二进制。
- 保留本机验证过的 effort 映射、取消上游、JSON/SSE 嗅探、工具图片转换、本地图片计数估算及日志级别修复。
- 增加 `openai-bridge` 入口，带真实回环假上游 selftest、用户终端配置、状态、启动、停止和卸载。
- 依赖随包提供，首次配置仅复制到用户的专用私有运行目录，不下载代码、不修改组件管理器拥有的文件。
- 独立 HOME + SessionStart 单例看护，不覆盖既有 Hooks、手工桥或全局认证；不读取用户既有密钥文件。
- 用户自己输入 URL/Key/模型，随后在 App 现有“自定义接口”表单填本机连接。**尚未新增 App 内的 OpenAI 图形配置卡片，也未自动切换供应商。** 若范围被接受，希望再协调主应用配置表单、服务生命周期及安全升级的后续方案。

## 合并前阻碍 / Merge blockers

1. **已知依赖漏洞未解决。** `npm audit --omit=dev` 报 **6 项（2 high、1 moderate、3 low）**，包括 `@fastify/static` 的路径/路由处理和 `tmp` 的临时文件处理。CCR CLI 自身有打包代码，不能只覆盖外部 npm 依赖就说修好了。强制升级会破坏补丁锚点，需要重新适配并测试。绑定回环地址不等于已修漏洞。详见源仓库 `SECURITY.md`。
2. **市场范围有待维护者确认**，见上方对实际转发行为的披露。
3. **卸载/更新集成需评审。** 当前私有运行副本有独立管理器，App 移除组件文件不会自动停止副本或删 Hook，文档要求先执行 `openai-bridge uninstall --yes`；重复安装不会偷偷迁移旧副本。
4. 签名索引路径的 App 实际安装/卸载、CI 审计和安全修复后的正式验证尚未完成，不添加 `verified.json` 记录。

## 大小、共用包与安装链路

- 本机 devkit 构建：下载包约 **26.5 MiB**，文件负载约 **97.6 MiB**（tar 约 104.6 MiB）。首次配置还会创建约 98 MiB 私有运行副本。
- 当前底座所需 `nodejs`、Bash、util-linux、coreutils 已具备，额外 Termux 包为 **0**；180 个 npm 包全部位于组件自己的 `usr/lib/openai-bridge`，不覆盖 Cloudflare 等组件的依赖。
- 源码在独立仓库维护，`recipe/sync.sh` 同步配方/脚本，遵守大组件来源要求。
- 对照独立安装版：依赖安装→组件 CI 执行；兼容补丁→只修补私有运行副本；密钥→用户私下输入、600 权限；Hook→合并自有条目；客户端连接→用户在现有自定义供应商表单填写；停止/卸载→独立管理器，只移除自有 Hook、默认保留用户数据。

## 检查 / Checklist

- [x] `node tools/check-recipes.mjs` 通过
- [x] `ci-build.mjs --dry`：`bases.json` 的 **8 个底座全部解析通过**
- [x] 读过组件编写规则；描述如实说明能力及预览风险
- [ ] 已看 CI 审计报告（等待本 PR 的 CI）
- [x] 首次配置不下载运行代码；独立安装方式的 npm 联网与授权已写清
- [x] skill 不让 AI 索要/读取/打印令牌或密码
- [x] 停止、卸载、花费、公开发布前要求用户确认
- [x] `needs` 如实填写：无需 root / Shizuku / GPU / 显示
- [ ] “不涉及反代…”：**暂不勾选**，已披露转发行为，请维护者确认范围；不涉及账户共享/转售、破甲、批量操控账号

## 真机测试 / Device test

设备：Xiaomi M367FC（Xiaomi Pad 9 Pro Max），Android 17 / SDK 37，aarch64，XRing O3 / Mali。正常应用 UID 原生运行，不使用 root、Shizuku、chroot 或 proot。底座 `devkit-2026.10.22.3`，Node 26、Python 3.14。未安装新的测试 APK，未中断现用桥。

通过：

- 15 项安装器单元测试；
- 独立 npm 安装和组件预装依赖两条完整生命周期；
- 73 项转换/响应/原子补丁测试；
- 9 项真实 CCR + 本机假上游 HTTP 集成测试；
- 本地健康探测正反例与超时；
- 最终构建归档解包到隔离工作目录后的 selftest **JSON/SSE=3/3、effort=OK**，以及安装→启动→本机假上游请求→重复安装→状态→卸载流程；
- 检查确认源依赖字节、inode、mtime 未被修改。

未做：正式签名组件索引安装/卸载、主应用图形配置卡片、整改后的真实模型推理。本次没发送真实用户截图、会话、密钥或重放日志，也未向收费上游发送测试请求。安全审计仍失败，不以功能测试通过掩盖它。

AI 辅助整理代码、文档和测试；本地桥接适配与设备验证由贡献者在自己的设备上进行，CCR 引擎及 OpenAI API 不属于本贡献原创。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
