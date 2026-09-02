# 17 — 异步 PNG Image Export

**What to build:** 让 Organizer 从已成功归档的 Board Session 请求普通 PNG Image Export，并在后台生成不含作者和内部元数据的可下载图片。

**Blocked by:** 15 — 归档失败恢复与幂等重试

**Status:** ready-for-agent

- [ ] Owner/Admin 可以提交导出请求并看到排队、处理、成功或失败状态；Participant 和公开访问者不能创建导出任务。
- [ ] Export Job 使用成功的 Private Archive 作为输入，不读取仍可编辑的实时 Board Session，也不暴露原始 SVG 下载。
- [ ] 输出为白色背景、内容边界加留白的普通 PNG，最长边不超过 8192 像素；过大或无法渲染的任务确定性失败。
- [ ] PNG 不包含 Item Attribution、Participant Identifier、Change Audit、对象键、邮箱或其他内部 metadata。
- [ ] 成功结果保存在对象存储，下载链接需要授权且只在 24 小时内有效；撤销或删除成果后链接立即失效。
- [ ] 后台任务在重启后恢复，重复执行不会产生互相矛盾的结果或无限重复任务。
- [ ] Node 集成测试检查任务生命周期、像素输出边界、metadata 清理和授权；Playwright 覆盖 Organizer 请求和下载流程。

