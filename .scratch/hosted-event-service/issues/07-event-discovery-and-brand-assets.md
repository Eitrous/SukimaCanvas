# 07 — Event 发现页与 Brand Asset

**What to build:** 让访问者从 Hosted 首页发现公开 Event，或通过不可枚举直达链接访问未列出 Event；Organizer 可以安全配置活动展示信息和有限类型的 Brand Asset。

**Blocked by:** 06 — Reservation 申请、审批与容量约束

**Status:** ready-for-agent

- [ ] 首页只列出允许公开发现且处于可展示生命周期的 Event，不暴露未列出或取消的活动。
- [ ] 未列出 Event 不出现在列表和索引中，但持有 Event Public ID 的访问者可以打开活动页。
- [ ] Access Code 验证前，活动页只显示名称、Organizer 展示名、封面、时间和适当状态，不泄露容量、Participant 或管理员信息。
- [ ] Organizer Owner/Admin 可以切换公开/未列出可见性并管理活动展示信息，越权用户不能修改。
- [ ] Brand Asset 仅接受真实解码成功的 PNG、JPEG 或 WebP，单文件不超过 5 MiB；SVG、伪造 MIME、损坏图片和超限输入被拒绝。
- [ ] 对象存储中的 Brand Asset 通过受控读取路径提供，不把内部对象键或任意上传内容变成可执行页面。
- [ ] Node 集成测试覆盖发现规则和 hostile 文件；Playwright 覆盖公开列表、未列出直达和品牌展示。

