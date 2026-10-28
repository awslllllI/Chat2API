# Kimi

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | kimi |
| 官网 | https://www.kimi.com |
| API Base | https://www.kimi.com |
| 认证 | access JWT + `refresh_token`（推荐） |
| 凭据字段 | `token`（可选）、`refresh_token`（推荐） |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| Kimi-K2.6 | kimi-k2.6 |

## 适配状态

已适配：Connect JSON 对话接口、流式/非流式、多轮会话、账号级批量清理、联网搜索和思考参数。

自动续命：代理在 access JWT 临期或上游 401 时，用 `refresh_token` 调用  
`POST https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken`，并将新的 access / refresh 写回账号。

## 教程（推荐）

1. 登录 `www.kimi.com`。
2. 打开 DevTools → Application → Local Storage → `https://www.kimi.com`。
3. 复制 `refresh_token`（若是数组，用 `.` 拼成一串）。
4. （可选）同时复制 `access_token`。
5. 在供应商管理中添加 Kimi 账号：至少填 `refresh_token`。
6. 或使用应用内 OAuth：登录后会优先抓取 localStorage 的 `refresh_token` + `access_token`。

仅粘贴 `kimi-auth` / 短命 access JWT 仍可用，但约 15 分钟后会 401，需重新登录。

## 说明

- 网页 OAuth（应用内登录）与手动提取在「只拿到 access」时寿命相同；差别在于现在会尽量一并抓 `refresh_token`。
- Kimi Code（`auth.kimi.com/api/oauth/token` + coding client_id）是另一条产品线，本适配器走的是**网页会话**换票接口。
