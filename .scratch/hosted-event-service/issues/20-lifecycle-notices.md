# 20 — 活动生命周期邮件通知

**What to build:** 通过可恢复的后台工作向正确的 Account 发送验证、恢复和活动生命周期邮件，让 Organizer 与已经进入过 Event 的 Participant 及时获知重要状态变化。

**Blocked by:** 03 — Account 恢复与 Session 安全控制；08 — Reservation 变更与耐久活动调度；15 — 归档失败恢复与幂等重试

**Status:** ready-for-agent

- [ ] 邮箱验证和密码恢复邮件只发送给对应 Account，使用一次性限时凭据且不在日志中记录正文或 secret。
- [ ] Organizer Member 按角色和权限收到 Reservation 审批、变更、取消、即将开始、归档成功或失败等必要通知。
- [ ] Participant 只收到自己已经建立 Membership 的 Event 的取消、关闭或其他必要状态通知；未知 Access Code 持有者不会被猜测或触达。
- [ ] 每个逻辑通知有稳定幂等键，重试、重复任务和进程重启不会重复发送同一通知。
- [ ] 邮件内容提供自然的 `zh-CN` 与 `en` 版本，敏感链接限时、最小权限且不携带原始 Access Code 或 Entry Grant。
- [ ] 邮件供应商暂时不可用时，任务进入可观察重试状态，不阻塞 Event 关闭、Socket.IO 或其他用户请求。
- [ ] Node 集成测试使用可控邮件 Adapter 检查收件人隔离、幂等、重启恢复和本地化；Playwright 验证触发状态在控制台中的可见性。

