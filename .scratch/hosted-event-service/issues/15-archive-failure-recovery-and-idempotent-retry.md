# 15 — 归档失败恢复与幂等重试

**What to build:** 让关闭过程中发生的数据库、快照或对象存储故障保持为可观察、可恢复的 ARCHIVE_FAILED，而不是伪装成功；Operator 能安全重试，进程重启也不会丢失工作。

**Blocked by:** 14 — 关闭 Board Session 并生成 Private Archive

**Status:** ready-for-agent

- [ ] 任何无法验证最终序号或无法持久保存 Private Archive 的关闭工作进入 ARCHIVE_FAILED，并保留完整失败原因和重试上下文。
- [ ] ARCHIVE_FAILED 不开放写入、不发布成果，也不把 Reservation 或 Board Session 显示为已成功归档。
- [ ] Platform Operator 控制台列出失败工作并允许授权重试；Organizer 只能看到适当的失败状态，不能操作其他 Organizer 的任务。
- [ ] 自动恢复和人工重试均幂等，不产生冲突 Archive、重复状态推进或不同最终序号的“成功”副本。
- [ ] 进程在关闭任意阶段崩溃并重启后，耐久任务可以继续或安全重做，最终结果与一次正常执行一致。
- [ ] 故障和恢复产生可观测指标与 Change Audit，敏感对象凭据和内部错误不会暴露给普通用户。
- [ ] 集成测试通过故障注入覆盖数据库、快照、对象存储和重启边界，并证明失败不会被误报为成功。

