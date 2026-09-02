# 13 — Event 管理、举报、封禁与锁定

**What to build:** 让 Organizer 为具体 Event 分配 Moderator，并让有权人员在实时画板和独立控制台处理举报、警告、踢出、Event Ban、解除封禁和破坏性 Clear，而不扩大为跨 Organizer 黑名单。

**Blocked by:** 05 — Organizer 成员邀请与角色权限；12 — 完整笔画审计、派生关系与崩溃恢复

**Status:** ready-for-agent

- [ ] Owner/Admin 可以为单个 Event 分配或撤销 Event Moderator；该角色不能管理 Organizer 成员、Reservation、凭据、归档或其他 Event。
- [ ] 被分配 Moderator 可在 Preparation Window 进入并执行事件内治理，权限撤销后现有实时连接及时刷新。
- [ ] Participant 可以举报当前 Event 中另一名在线 Participant；自我举报、跨 Event 目标和畸形 socket 标识被确定性拒绝。
- [ ] Moderator 可以填写原因并执行警告、踢出、限于该 Event 的 Ban 或解除 Ban；Ban 立即驱逐目标并覆盖 Access Code、Membership 和 Entry Grant 重入。
- [ ] Moderator 看到的是 Event-scoped Participant Identifier 与冻结展示名，不暴露邮箱或全局 Account 标识。
- [ ] 只有 Owner/Admin 可以 Clear；所有警告、踢出、Ban、解封、锁定和 Clear 均记录实际操作者与原因。
- [ ] Node/Socket 集成测试覆盖角色矩阵、实时权限刷新和 Ban 重入；Playwright 覆盖举报与 Moderator 处置主流程。

