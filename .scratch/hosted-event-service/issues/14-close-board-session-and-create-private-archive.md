# 14 — 关闭 Board Session 并生成 Private Archive

**What to build:** 在计划结束或授权关闭时形成明确写入边界，排空已经接纳的绘图变更，校验最终序号，并把不可变 Private Board Archive 保存到 S3-compatible object storage。

**Blocked by:** 08 — Reservation 变更与耐久活动调度；12 — 完整笔画审计、派生关系与崩溃恢复

**Status:** ready-for-agent

- [ ] Board Session 进入 CLOSING 后立即拒绝新的持久写入，但允许已接纳队列完成并向客户端得到确定结果。
- [ ] 关闭流程等待账本和 SVG 投影达到同一最终权威序号，校验失败时不标记归档成功。
- [ ] 成功关闭生成不可变 Private Archive，保存画布、Item Attribution 和必要审计边界；对象键不作为公共访问凭据。
- [ ] 空 Board Session 同样产生合法 Archive 与生命周期记录。
- [ ] Archive 成功后 Board Session 不可重新编辑或重开；继续创作必须创建新的 Board Session。
- [ ] 已连接 Participant 收到只读完成状态，之后无法通过旧页面、socket 或 mutation 重获写权限。
- [ ] Node/Socket 集成测试覆盖关闭竞争、队列排空、空画布和对象存储成果；Playwright 覆盖关闭后的只读完成界面。

