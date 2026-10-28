谢谢确认收录范围。我按两项要求继续做了一版 **1.0.2-r2**，暂时仍保持 Draft，不提前喊合并。

### 1. 安全整改和本机验证

- `@fastify/static` 锁定/override 到 **10.1.2**、`tmp` 到 **0.2.7**，外部 `npm audit --omit=dev --audit-level=moderate` 现在 **0 vulnerabilities**。
- 不只覆盖外部 npm 包：已按 SHA-256 指纹删除 CCR 1.0.73 内嵌的旧静态插件及目录列表实现，改用修复版。
- 进一步扫描发现 npm audit 看不到的其他内嵌公告，因此另外移除 **249 个内嵌 CommonJS 模块**，换成锁定的 Fastify/Undici/ajv/fast-uri/find-my-way/brace-expansion/minimatch/glob/shell-quote 修复版本。缺依赖、版本不符、指纹变化或语法错误会在写文件/启动之前失败。
- 实际私有运行 bundle 剩余 84 个可识别内嵌包，npm 公告匹配的中危/高危/严重数 **0**；新增源仓库 CI 的外部及有效 bundle 双层阻断门禁。
- 安全回归用临时假文件复现旧版 `allowedPath` 绕过，修复后拒绝非规范路径、编码分隔符、目录越界；验证实际 bundle 加载的是修复依赖，不只检查版本字符串。tmp 越界负例也通过。
- 本机最终测试：16 项安装单测、76 项协议/原子补丁回归、9 项真实 CCR + 回环假上游 HTTP 测试、健康测试，两条安装生命周期均通过。最终本地构建归档也单独解包，selftest **3/3** 及完整安装→请求→重复安装→状态→卸载→purge 通过。
- 默认卸载继续保留用户数据；新增明确的 `uninstall --yes --purge`，用于已获单独删除授权/可丢弃测试安装，彻底删除私有依赖、配置、密钥、日志及目录，同时保留无关 Hook 与设置。并未在现用桥或真实密钥上执行。

完整版本、修补边界及记录已写进源仓库 `SECURITY.md`、`TESTING.md`。原始 npm 程序和 `.orig` 备份仍是上游原件，不能绕过受管理入口直接运行；也不把 point-in-time 公告归零说成所有代码均无漏洞。

### 2. CI 状态及仍待官方发布链路验证

- 源仓库 GitHub Actions [40617296043](https://github.com/chenshi723/cccodroid-openai-bridge/actions/runs/40617296043) 已 **success**：Ubuntu/Node 22 全套测试、外部依赖门禁、有效内嵌依赖门禁全部通过。
- 市场本次 PR check [40617306752](https://github.com/greyoak111/cccodroid-components/actions/runs/40617306752) 为 **action_required**，尚无执行 job，仍需维护者批准；不将源码 CI 代替市场审计。

我没有把上述本地归档测试写成“官方签名索引已安装”，也没有填 `verified.json`。App 自定义接口聊通、官方签名索引安装/卸载和市场 hosted CI 报告还会如实补齐；不会用假上游冒充真实模型验证，不上传私人配置或对话。

想请你确认：**这个未合并 Draft 应通过哪条可信预发布签名索引做真机安装验证？** 如果正式签名索引只在合并后的构建发布，能否提供测试签名索引/触发可信构建，或确认这两步的先后安排？我不会自行替换 App 信任根或把自签名包当成官方签名包。也请协助确认首次贡献 PR 的 CI 是否需要维护者批准。

拿到官方可验证构件后，再由用户自己私下配置 API 并确认测试内容/费用，补 App 聊通和完整卸载记录；完成前保持 Draft。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
