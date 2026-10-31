# 变更记录

## 2026-10-31 · 排行榜只展示中文姓名

店主指令：排行榜只展示中文姓名。落地为 `leaderboard.js` 的姓名形态过滤
（`LB_NAME_RE = /^[\u4e00-\u9fa5]{2,12}(?:[·•][\u4e00-\u9fa5]{1,12})?$/`），
而不是写死人名——因为数据问题是「手机号被写进 cashier 字段」，按形态过滤能一直生效。

实测效果（`/autotc/api/leaderboard`）：

| 月份 | 接口返回 | 页面展示 | 被过滤 |
|---|---|---|---|
| 2026-06 | 刘超霞, 陈漫莉, 罗森 | 刘超霞, 陈漫莉, 罗森 | 无 |
| 2026-07 | 陈漫莉, 刘超霞 | 陈漫莉, 刘超霞 | 无 |
| 2026-08 | 陈漫莉, 刘超霞, 陈宝如 | 陈漫莉, 刘超霞, 陈宝如 | 无 |
| 2026-09 | 刘超霞, 陈漫莉 | 刘超霞, 陈漫莉 | 无 |
| 2026-10 | 刘超霞, 19557933364 | **刘超霞** | 19557933364 |

配套改动：

- 名次改为按过滤后的顺序重排（服务端 `rank` 是全量口径，过滤后会出现空号）。
- `LB_VISIBLE_NAMES` 留空即"只按中文姓名过滤"；填入名字可额外限定到具体某人。
- 顶部「本月总提成」是门店级指标（`summary.periodTotalCommission`），不随名单变化。

> 说明：这条指令覆盖了原护栏 §4.5「不改收银员展示范围」。护栏的用意是禁止迁移过程中
> 擅自改动展示范围，店主明确指令属合法变更，已按指令执行并在此留痕。

## 2026-10-31 · 页面结构调整（排行榜升为首页）

按店主需求把入口改成「先看排行、再下钻明细」：

| 路径 | 内容 | 说明 |
|---|---|---|
| `/` | **员工提成排行榜** | 由原 `leaderboard.html` 内容承担；`lbDetailBtn` 与 `leaderboard.js` 的跳转全部改指 `/orders` |
| `/orders` | **订单详情**（原看板） | 由原 `index.html` 内容承担；标题改为「订单详情 ORDER DETAIL」；移除 `#leaderboard` 收银员排行区块（已在首页）与对应侧栏锚点 |
| `/leaderboard` | 兜底到首页 | `leaderboard.html` 已删除，Pages 对未知路径返回 `index.html`，旧书签仍可打开排行榜 |

配套改动：

- `public/app.js`：`renderLeaderboard()` 增加元素存在性护栏——区块删除后 `el.leaderboard` 为 `null`，
  原代码会抛 `TypeError` 并中断整个 `render()`，导致订单详情页白屏。
- `public/styles.css`：`.overview-grid` 在有侧栏时是三列，删掉排行榜面板后第三列会留白，
  补 `:not(:has(.leaderboard-panel))` 的两列规则。
- `public/index.html`：「后台管理」按钮由失效的 `manual.html` 改为旧通道绝对地址（新窗口打开）。
- `pipeline/scripts/stamp_assets.py`：页面清单由 `index.html/leaderboard.html` 改为 `index.html/orders.html`。
- `public/_headers`：`/leaderboard.html` 的 no-store 规则改为 `/orders.html`。

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
| `autotc.user.js` | 16 | `KEY = "<旧口令>"` → localStorage 存一次、首次上报时弹框输入 | 护栏 3 + P5-9：任何注入方式都会让 6 位口令重新出现在公网产物里，改为纯客户端持有 |
| `autotc.user.js` | 17 | API 常量 → `https://auto.aininja365.xyz/api/mxipos-session` | 换新域名 |
| `autotc.user.js` | 120 | 成功提示改为「数据约 15 分钟内同步」 | KV 轮询模式下不再是「服务器正在拉单」，避免误导 |

`app.js` / `leaderboard.js` / `leaderboard.css` / `styles.css` / `manual.js` / `data.js` **零改动**——
方案 A 下 `apiBase = "/autotc/api"` 是相对路径，同域反代天然命中。

### 新增

| 文件 | 作用 |
|---|---|
| `functions/autotc/api/[[path]].js` | 方案 A 同域反代 |
| `functions/api/mxipos-session.js` | 手机 token 接收端（KV + CORS + 口令） |
| `pipeline/scripts/pull_orders.py` | Actions 拉单入口（去 fcntl、去硬路径） |
| `pipeline/scripts/ci_session.py` | KV 门禁 / 取会话 / 标记已处理 |
| `pipeline/scripts/stamp_assets.py` | 发布前刷新 `?v=` 版本号，绕过 zone 级 4 小时缓存 |
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

详细逐条结论见 `docs/VERIFY-20261031.md`。要点：

| 项 | 结果 |
|---|---|
| 快照字节校验 | 51/51 完全一致 |
| Functions 单元测试（Node 原生 Request/Response） | 35/35 通过 |
| 台账往返（线上 `data.js` → SQLite → 导出） | 3,136 行订单**逐字节一致**；`rules` / `metrics` / `period` 全等 |
| P0 门禁（Azure runner 172.210.6.17） | HTTP 200，响应含 `data.img` → **WAF 放行，可直连** |
| 全链路首次运行 | 16 步全绿，约 40 秒完成 3,172 单拉取+计算+发布 |
| 两通道接口一致性 | `/report`、`/report?start&end`、`/report/periods`、`/leaderboard` 响应 sha256 完全相同 |
| 数据新鲜度 | 旧 12:00:52 / 新 12:02:55，差 2 分 3 秒 |
| 旧通道回归 | 首页 200 / 12,165 B 不变；`health` `ok:true, stale:false` |
