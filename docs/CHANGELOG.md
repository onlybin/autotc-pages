# 变更记录

## 2026-10-31 · 新通道首次建立（Pages 迁移）

### 基线

远端 `192.168.1.74:/home/abc/commission_tool/` 线上快照，51 个文件全部按 `stat -c%s` 校验字节一致。

### 前端改动（`public/`，均记录版本号）

| 文件 | 行 | 改动 | 原因 |
|---|---|---|---|
| `index.html` | 19 | 移除「规则管理」侧栏入口（`manual.html`） | 决策 2-A：后台不上 Pages |
| `index.html` | 38 | 移除「后台管理」按钮（`manual.html`） | 同上 |
| `index.html` | 266-268 | 保留 `manual.js` 引用，加注释说明 | `manual.js` 是纯函数库（240 行、零网络），`app.js` 全篇依赖其 `escapeHtml`；去掉会白屏。后台页 `manual.html`/`manual_page.js` 不部署，与此文件无关 |
| `install.html` | 78 | `/autotc/autotc.user.js` → `/autotc.user.js` | Pages 根是 `/`，原绝对路径会 404 |
| `install.html` | 94 | `/autotc/bookmark.html?k=<旧口令>` → `/bookmark.html` + 输入提示 | 去掉**公网明文口令**；旧口令作废 |
| `bookmark.html` | 68 | `/autotc/session.html` → `/session.html` | 同上 |
| `bookmark.html` | 73 | API 常量 → `https://auto.aininja365.xyz/api/mxipos-session` | 换新域名，见决策 4-A |
| `bookmark.html` | 101 | 兜底提示里的路径改由 `U` 常量推导 | 书签运行在 mxipos.com，`location.origin` 会指错站点 |
| `session.html` | 55 | `/autotc/api/mxipos-session` → `/api/mxipos-session` | 相对路径会命中 catch-all 反代被转发去旧主机，新 KV 收不到 |
| `autotc.user.js` | 3-4 | `@namespace` 换新域，`@version` 1.0.0 → 2.0.0 | 便于 Tampermonkey 识别升级 |
| `autotc.user.js` | 16 | `KEY = "<旧口令>"` → `KEY = "__SESSION_KEY__"` | 护栏 3：凭据不入库。部署期由 GitHub Secret 注入 |
| `autotc.user.js` | 17 | API 常量 → `https://auto.aininja365.xyz/api/mxipos-session` | 换新域名 |

`app.js` / `leaderboard.js` / `leaderboard.css` / `styles.css` / `manual.js` / `data.js` **零改动**——
方案 A 下 `apiBase = "/autotc/api"` 是相对路径，同域反代天然命中。

### 新增

| 文件 | 作用 |
|---|---|
| `functions/autotc/api/[[path]].js` | 方案 A 同域反代 |
| `functions/api/mxipos-session.js` | 手机 token 接收端（KV + CORS + 口令） |
| `pipeline/scripts/pull_orders.py` | Actions 拉单入口（去 fcntl、去硬路径） |
| `pipeline/scripts/ci_session.py` | KV 门禁 / 取会话 / 标记已处理 |
| `.github/workflows/fetch-orders.yml` | 拉单 + 计算 + 发布 |
| `.github/workflows/heartbeat.yml` | 防 60 天停用 |
| `.github/workflows/p0-gate.yml` | P0 门禁实验（海外 IP 能否过 WAF） |
| `wrangler.toml` / `public/_headers` / `.dev.vars.example` | Pages 配置 |
| `docs/DEPLOY.md` / `docs/DEPRECATED.md` | 运维手册 / 弃用登记 |

### 依赖清理

- `package.json` 删除 `puppeteer-extra`、`puppeteer-extra-plugin-stealth`
- `check` 脚本不再引用 `fetch_orders_and_update.mjs`（浏览器链路）
- 现为零运行时依赖（数据库走 Node 内置 `node:sqlite`）

### 验证记录

| 项 | 结果 |
|---|---|
| 快照字节校验 | 51/51 完全一致 |
| Functions 单元测试（Node 原生 Request/Response） | 35/35 通过 |
| 台账往返（线上 `data.js` → SQLite → 导出） | 3,136 行订单**逐字节一致**；`rules` / `metrics` / `period` 全等；总字节差 2 B，来自 `generatedAt` 与 `source.orders` 两个元数据字段 |
| 提成口径 | `totalCommission=264`、`commissionRows=99`、`people=2`、`unmatchedRows=386` 与线上一致 |
