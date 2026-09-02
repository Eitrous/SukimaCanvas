# 08 — Reservation 变更与耐久活动调度

**What to build:** 让 Organizer 对已提交或获批 Reservation 提交变更/取消请求，并让 Event 生命周期由可恢复的持久后台工作推进，而不是依赖进程内 timer。

**Blocked by:** 06 — Reservation 申请、审批与容量约束

**Status:** ready-for-agent

- [ ] Owner/Admin 可以针对改期、延期、容量或取消提交 Reservation Change Request，并查看审批状态。
- [ ] 影响容量的变更只有 Operator 审批后才更新 Reservation 与 Capacity Allocation，更新过程重新执行全部重叠容量约束。
- [ ] 取消未来 Event 会阻止新入场并释放尚未消耗的未来容量；已形成的审计记录不会被删除。
- [ ] 耐久任务将 Board Session 按权威时间从 SCHEDULED 推进到 OPEN、CLOSING 和后续关闭工作，不以进程内 timer 为事实来源。
- [ ] 服务重启后，到期或中断的生命周期任务会恢复执行；重复执行不会产生重复转换或相互矛盾的状态。
- [ ] 非法状态转换、并发审批和过期任务被确定性处理并记录可观察失败。
- [ ] Node 集成测试用可控时钟覆盖变更、取消、边界时间和重启恢复；控制台展示与实际权威状态一致。
