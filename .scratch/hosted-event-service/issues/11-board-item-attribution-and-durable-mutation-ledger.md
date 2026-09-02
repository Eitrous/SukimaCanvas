# 11 — Board Item 创建归属与耐久 Mutation Ledger

**What to build:** 让每个被服务端接受的新 Board Item 都拥有可信创建者，并在向实时客户端确认前同步进入 PostgreSQL 持久变更账本，使 SVG 成为可重建投影而非唯一历史。

**Blocked by:** 10 — Participant Seat 与实时连接准入

**Status:** ready-for-agent

- [ ] 服务端从权威 Session、Event Membership、Board Session 和活动角色解析操作者，不信任客户端提交的作者或权限字段。
- [ ] 每个持久创建 mutation 记录 Event、Board Session、Account、操作时间、序号和 mutation 内容，并给新 Board Item 写入不可变 `createdBy` 语义。
- [ ] 写入只有在账本持久确认后才向发送者确认并广播；数据库失败时 mutation 被拒绝且不会只存在于其他客户端或 SVG。
- [ ] 实时广播、重放和现有乐观回滚保持一致，重复客户端 mutation 不会创建重复的持久项目。
- [ ] 从 SVG 快照加载时可以用后续账本 mutation 补齐到权威序号，且归属信息不会依赖浏览器提供。
- [ ] 日志、画板公开载荷和普通 Participant UI 不泄露邮箱或内部 Account 标识。
- [ ] Node/Socket 集成测试覆盖所有创建型工具、失败和重复提交；对账本、重放和广播热点运行改动前后基准并记录结果。

