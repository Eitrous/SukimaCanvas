# 05 — Organizer 成员邀请与角色权限

**What to build:** 让 Organizer Owner 邀请其他 Account 加入组织，并以最小权限管理 Owner/Admin 成员关系，为后续 Reservation、成果和集成管理提供可靠授权边界。

**Blocked by:** 03 — Account 恢复与 Session 安全控制；04 — Organizer Application 与平台审批

**Status:** ready-for-agent

- [ ] Organizer Owner 可以向指定 Account 发出 7 天有效的 Organizer Invitation，邀请只有目标 Account 能接受。
- [ ] 未接受、已过期、已撤销或已使用的邀请不能建立成员关系，并给出不泄露其他组织信息的失败响应。
- [ ] Owner 可以授予或撤销 Organizer Admin；Admin 不能执行仅限 Owner 的成员和集成凭据管理。
- [ ] 系统阻止移除最后一名 Owner，避免产生无人可管理的 Organizer。
- [ ] 移除成员后，该 Account 的 Organizer Console 权限和相关 Session 授权立即失效，但不篡改其历史操作归属。
- [ ] 邀请、接受、角色变更和移除均写入 Change Audit，记录实际操作者。
- [ ] Node 集成测试覆盖完整角色矩阵、邀请过期和并发接受；Playwright 覆盖邀请与成员管理主流程。

