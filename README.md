# Codex Usage Statusbar

在 VSCode 底部状态栏实时显示 Codex 配额：5 小时窗口剩余百分比、每周配额剩余百分比、最近重置点倒计时。

- 数据来源：`https://chatgpt.com/backend-api/wham/usage`（字段结构见 `docs/api-shape.md`）
- 凭证：只读复用 `~/.codex/auth.json`（Codex 登录产物），token 不出本机
- 断网降级：保留上次数据并标 `*`；凭证失效提示重新登录
- 点击状态栏或命令面板执行 `Codex Usage: 刷新配额` 手动刷新

## 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `codexUsage.refreshInterval` | 60 | 自动刷新间隔（秒），30–600，窗口失焦暂停 |
| `codexUsage.displayFormat` | `5h {5h} 周 {week} 重置 {reset}` | 占位符：`{5h}` `{week}` `{reset}` `{credits}`（重置卡） |

## 开发

```bash
npm install
npm run compile   # tsc 类型检查 + esbuild 打包到 dist/
npm run package   # 生成 .vsix
```
