# 22 — 受控 Legacy SVG 历史归档导入

**What to build:** 让 Platform Operator 显式选择并导入旧 WBO SVG 作为私有 Historical Archive，以便保留历史成果，同时不伪造作者、审计或可编辑 Board Session。

**Blocked by:** 15 — 归档失败恢复与幂等重试

**Status:** ready-for-agent

- [ ] 只有 Platform Operator 可以发起单个历史 SVG 导入，并在导入前明确选择来源和目标 Organizer/归档上下文。
- [ ] 导入数据标记为 Historical Archive、作者未知、没有可信 Item Attribution 和 Change Audit，不生成虚假的 Participant 或操作者记录。
- [ ] 结构合法的旧 SVG 转为私有、不可编辑 Archive；Participant、公众和 Organizer 未授权成员不能通过旧 WBO 入口访问。
- [ ] 损坏、超限、包含不支持结构或无法安全解析的 SVG 被确定性拒绝或隔离，不静默修复或覆盖既有归档。
- [ ] 系统不自动扫描历史目录、不批量迁移、不自动创建 Event/Reservation，也不允许把 Historical Archive 重开为 Board Session。
- [ ] 导入操作、来源、结果和失败原因可由 Platform Operator 审计，重复导入不会产生不可区分的冲突成果。
- [ ] Node 集成测试覆盖合法、恶意、重复和失败恢复导入；控制台测试验证私有性、未知作者标记和权限边界。

