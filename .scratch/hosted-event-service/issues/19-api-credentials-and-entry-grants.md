# 19 — API Credential 与单次 Entry Grant

**What to build:** 让 Organizer 后端安全地把已登录 Participant 从自有网站跳转到目标 Event，而不把 API 密钥或长期访问凭据交给浏览器。

**Blocked by:** 05 — Organizer 成员邀请与角色权限；09 — Access Code 入场与 Event Membership

**Status:** ready-for-agent

- [ ] Organizer Owner 可以创建、轮换、查看元数据和撤销 API Credential；完整 secret 只在创建或轮换时显示一次，之后不能恢复。
- [ ] Credential 只可访问所属 Organizer 已授权的集成 Interface，越权 Event、Reservation、Participant 和其他 Organizer 请求被拒绝。
- [ ] Organizer 后端可以用 Credential 与 External Participant Reference 请求 10 分钟有效的 Entry Grant；Reference 不得携带或冒充 Account 身份。
- [ ] Participant 必须先完成 Hosted Account 登录，Entry Grant 才能兑换为对应 Event 的准入；Event Ban、Event Lock、生命周期和容量规则仍然优先。
- [ ] Entry Grant 只经 URL fragment 传递，由浏览器通过 HTTPS `POST` 单次兑换，成功、失败或过期后立即清除 fragment。
- [ ] Grant 过期、重复兑换、撤销 Credential、错误 Organizer scope 和畸形输入均确定性失败，且不出现在普通访问日志、referrer 或 query/path 中。
- [ ] Node 集成测试覆盖 Credential 生命周期、scope、单次语义和 hostile 输入；Playwright 覆盖从 Organizer 网站跳转、登录、兑换到 Event 的流程。

