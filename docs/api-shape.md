# wham/usage 接口实测结构（2026-10-14）

请求：

```
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <tokens.access_token>
chatgpt-account-id: <tokens.account_id>
User-Agent: codex-cli
```

凭证来自 `~/.codex/auth.json`（Codex 登录产物），结构：

```
auth_mode: "chatgpt"
tokens.id_token / tokens.access_token / tokens.refresh_token / tokens.account_id
last_refresh: ISO 时间字符串
```

实测响应（HTTP 200，plan=plus）关键字段：

```
plan_type: "plus"
rate_limit.allowed: true
rate_limit.limit_reached: false
rate_limit.primary_window:              # 5 小时窗
  used_percent: 11                      # 已用百分比（整数）
  limit_window_seconds: 18000           # = 5h
  reset_after_seconds: 2141
  reset_at: 1791962141                  # unix 秒
rate_limit.secondary_window:            # 周窗
  used_percent: 2
  limit_window_seconds: 604800          # = 7d
  reset_after_seconds: 588941
  reset_at: 1792548941
rate_limit_reset_credits:               # 重置卡
  available_count: 3
  applicable_available_count: 0
credits.has_credits / unlimited / balance ...
```

## 重置卡端点（2026-10-14 补充）

### GET /wham/rate-limit-reset-credits（已实测）

```
credits[]:
  id: "RateLimitResetCredit_<hex>"
  reset_type: "codex_rate_limits"
  is_supported_by_plan: true
  status: "available" | "redeemed" | ...
  granted_at / expires_at: ISO 时间
  redeem_started_at / redeemed_at: null | ISO 时间
  title: "Full reset (Weekly + 5 hr)"
  description: "..."
```

### POST /wham/rate-limit-reset-credits/consume（逆向自官方扩展）

来源：`openai.chatgpt-26.1007` 扩展 webview bundle（`webview/assets/app-initial-*.js` 中 `agr()`）：

```js
safePost('/wham/rate-limit-reset-credits/consume', {
  requestBody: { credit_id, redeem_request_id }
})
```

- `redeem_request_id`：客户端生成的幂等键（本扩展用 `crypto.randomUUID()`）。
- 核销效果：5h 窗 + 周窗同时重置，每周重置日改变。
- 官方 bundle 中出现 `already_redeemed` 错误码 → consume 失败需兜底。
- 相关端点（未使用）：`GET /wham/rate-limit-reset-credits/history` 核销历史。

容错约定（解析层实现依据）：

- `rate_limit` 或窗口字段缺失/类型不符 → 该窗口记 N/A，不抛异常。
- `reset_at` 缺失时用 `now + reset_after_seconds` 兜底。
- HTTP 401/403 → 凭证失效；其他非 200 → http 错误；fetch 抛错/超时 → 网络错误。
- 非公开接口，字段可能变动：所有取值必经宽松校验。
