# 02 — Account 注册、邮箱验证与登录

**What to build:** 让中国大陆首发地区的成年访问者创建 Account、验证邮箱并安全登录 Hosted Event Service，从而获得可跨设备使用的可信 Participant 身份。

**Blocked by:** 01 — Hosted Runtime Shell 与源码披露

**Status:** ready-for-agent

- [ ] 注册要求用户确认已满 18 周岁，并对规范化邮箱执行确定性的唯一性检查。
- [ ] 密码只以合适的密码散列保存；HTTP 响应、日志和邮件均不泄露密码、散列或验证凭据。
- [ ] 注册产生一次性邮箱验证流程；无效、已使用或过期凭据被确定性拒绝，且不能使进程崩溃。
- [ ] 只有邮箱已验证且未禁用的 Account 可以登录；失败响应不泄露邮箱是否已注册。
- [ ] 登录创建持久服务端 Session，浏览器 cookie 使用 `Secure`、`HttpOnly` 和 `SameSite=Lax` 的生产安全属性。
- [ ] 注册、验证、登录和登出页面提供自然的 `zh-CN` 与 `en` 文案，所有可见字符串走既定本地化机制。
- [ ] 注册与登录入口同时按 Account/IP 限速，并通过可配置 CAPTCHA 合同抵抗自动化滥用。
- [ ] Node 集成测试覆盖成功和 hostile 输入；Playwright 覆盖从注册到验证、登录和登出的完整浏览器流程。

