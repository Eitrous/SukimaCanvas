# 16 — Published Canvas 与公开作者策略

**What to build:** 让 Organizer 从 Private Archive 派生可撤回、净化后的只读 Published Canvas，并按受众和 Participant 匿名选择决定是否展示 Event-scoped Participant Identifier。

**Blocked by:** 15 — 归档失败恢复与幂等重试

**Status:** ready-for-agent

- [ ] Owner/Admin 可以选择不发布或创建 Published Canvas，发布永远从成功的 Private Archive 派生，不直接暴露权威原始 SVG。
- [ ] Publication Audience 支持 Organizer-only、Event Membership-only 和持有不可枚举链接三种模式，并在每次读取时执行权限检查。
- [ ] Published Canvas 只读且不被搜索引擎索引，不包含邮箱、内部 Account/Board Session 标识、Change Audit、私有对象键或可复用入场凭据。
- [ ] 只有 Organizer 开启公开归属且 Participant 在关闭前未选择匿名时，相关 Board Item 才显示 Event-scoped Participant Identifier。
- [ ] Participant 的匿名选择作用于其全部既有和未来 Board Item；Published Canvas 中不留下可反向关联匿名 Participant 的隐藏 metadata。
- [ ] Owner/Admin 撤回发布后，全部受众和旧分享链接立即失效；重新发布不意外复用已撤回的公开能力。
- [ ] 隐私集成测试检查净化产物；Playwright 覆盖三种受众、公开归属、匿名和撤回流程。
