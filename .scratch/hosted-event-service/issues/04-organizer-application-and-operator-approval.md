# 04 — Organizer Application 与平台审批

**What to build:** 让已验证 Account 提交 Organizer Application，并让 Platform Operator 在独立控制台审核、批准或拒绝申请；批准后申请人成为新 Organizer 的 Owner。

**Blocked by:** 02 — Account 注册、邮箱验证与登录

**Status:** ready-for-agent

- [ ] 已验证 Account 可以提交包含必要主体信息的 Organizer Application，并查看当前申请状态。
- [ ] 重复提交、非法状态转换和超限输入被确定性处理，不会创建互相冲突的有效申请。
- [ ] 只有 Platform Operator 可以查看待审队列并批准或拒绝申请；普通 Account 无法调用相同能力。
- [ ] 批准操作原子创建 Organizer 并授予申请人 Organizer Owner；并发审批不会重复创建 Organizer 或角色。
- [ ] 拒绝结果向申请人显示清晰状态，但不会暴露仅供运营使用的敏感备注。
- [ ] 提交、审批、拒绝和操作者身份写入 Change Audit。
- [ ] Node 集成测试覆盖角色隔离、并发审批和非法状态；Playwright 覆盖申请人与 Operator 的跨控制台流程。

