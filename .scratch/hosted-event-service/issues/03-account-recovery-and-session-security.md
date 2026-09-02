# 03 — Account 恢复与 Session 安全控制

**What to build:** 让 Account 持有人能够找回密码、修改密码、查看并撤销登录会话，同时让过期、被撤销或可能已泄漏的 Session 及时失效。

**Blocked by:** 02 — Account 注册、邮箱验证与登录

**Status:** ready-for-agent

- [ ] 忘记密码流程使用一次性、限时凭据；申请和兑换响应不泄露 Account 是否存在。
- [ ] 修改或重置密码后，旧 Session 按安全策略撤销，已打开页面在下一次受保护请求或实时重连时失去权限。
- [ ] 用户可以查看自己的活跃 Session、撤销指定 Session，并从当前设备登出。
- [ ] Session 最长存活 30 天且连续闲置 12 小时失效；两个时限均由服务端权威时间执行。
- [ ] 账号禁用和明确的全局撤销能够使所有已有 Session 失效。
- [ ] 所有改变状态的浏览器请求验证 CSRF；畸形、缺失、复用和跨 Session token 被确定性拒绝。
- [ ] Node 集成测试使用可控时钟覆盖绝对/闲置过期、密码重置和撤销；Playwright 覆盖恢复与 Session 管理主流程。

