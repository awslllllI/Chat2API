# 2026-10-28 Kimi 网页 refresh 自动续命

## Git 历史结论

`Refresh token - Kimi no longer supports refresh token API` **不是后来改掉的**，而是首提交 `c55dae2`（2026-02-26）就写死 `return null`。同期 builtin 仍保留 `tokenCheckEndpoint: /api/auth/token/refresh` 与「支持 refresh_token」文案，属于拷贝 Kimi-Free-API 时代的半截状态，本仓库从未接上网页换票。

## 实测

- `POST https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken` + `{"refresh_token"}` **仍存活**（无效票返回 `unauthenticated` / Session expired）。
- 旧 `GET www.kimi.com/api/auth/token/refresh` 仍存在，但更适合探测；换票以 auth gateway 为准（与 2026-10 manabar / DurinDoor 网页会话一致）。

## 改动

- 新增 `kimi-auth.ts`：normalize / JWT 临期判断 / RefreshToken 调用
- 代理 `acquireToken`：有 `refresh_token` 则临期换票并写回账号；聊天 401 强制换票重试一次
- OAuth：抓 localStorage `refresh_token` + `access_token`；登录完成前尽量先换一票
- UI/文档：双字段凭据与说明

## 使用

已有「仅 access JWT」账号需补 `refresh_token` 或重新 OAuth 登录后才能自动续命。
