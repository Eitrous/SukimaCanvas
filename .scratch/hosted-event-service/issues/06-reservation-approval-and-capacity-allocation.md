# 06 — Reservation 申请、审批与容量约束

**What to build:** 让 Organizer Owner/Admin 创建和提交 Reservation，并让 Platform Operator 在不超出服务器承诺的前提下审批，为获批活动分配确定容量和不可枚举的 Event Public ID。

**Blocked by:** 05 — Organizer 成员邀请与角色权限

**Status:** ready-for-agent

- [ ] Owner/Admin 可以维护 Reservation 草稿的活动名称、计划时间、1–50 个请求席位、可见性和必要展示信息。
- [ ] 只有合法且完整的草稿可以进入 SUBMITTED；提交后未经 Change Request 不可直接改写影响审批的字段。
- [ ] Operator 可以批准或拒绝已提交 Reservation，并在控制台看到目标时间窗的 Capacity Allocation 影响。
- [ ] 容量窗口覆盖计划开始前 15 分钟到计划结束后 15 分钟；任意重叠窗口最多批准 20 个 Board Session 和 1,000 个 Participant Seat。
- [ ] 审批与 Capacity Allocation 在并发请求下保持原子，不发生超卖或部分批准。
- [ ] 批准生成不可枚举的 Event Public ID；内部 Reservation/Board Session 标识不出现在公共 URL。
- [ ] 非法状态、冲突容量和越权审批给出确定性结果，并写入 Change Audit。
- [ ] Node 集成测试覆盖边界值与并发容量竞争；Playwright 覆盖 Organizer 提交和 Operator 审批流程。

