# 部署与运维手册 · Cloudflare Pages 新通道

> 新通道：`https://auto.aininja365.xyz/`（Pages，Direct Upload）
> 旧通道：`https://aininja365.xyz/autotc/`（nginx + systemd，**一行未动**）
> 本文所有命令在仓库根目录（本目录）执行。

## 1. 架构（先看清代价再操作）

```
浏览器 ──► auto.aininja365.xyz (Pages, 静态资源)
                 │
                 │  /autotc/api/*  ──► functions/autotc/api/[[path]].js  ──► https://aininja365.xyz/autotc/api/*
                 │                        （同域反代，方案 A）              │
                 │                                                        └─► nginx :3015 server.js ──► commission.sqlite3
                 │
                 └─  /api/mxipos-session ──► functions/api/mxipos-session.js ──► Cloudflare KV
                                                                                  ▲
手机书签/油猴脚本 (mxipos.com) ──上报 token───────────────────────────────────────┘
                                                                                  │
GitHub Actions (每 15 分钟轮询 KV) ──读 KV──────────────────────────────────────────┘
     └─ 会话 timestamp 变化 ──► 拉单 → 算提成 → 台账 → data.js ──► wrangler pages deploy
```

**必须如实理解的边界**：方案 A 是过渡形态，不是双活。看板的实时数字来自反代到旧主机的 `/api/*`，
**旧平板死机时新通道只剩静态壳，数据区报错**。真正摆脱旧主机是方案 B（Worker + D1），不在一期。
汇报与验收时不得宣称「新通道已摆脱旧平板」。

## 2. 凭据清单（一次配好，之后只轮换口令）

### 2.1 Cloudflare API Token

面板 → My Profile → API Tokens → Create Custom Token。

| 权限 | 用途 |
|---|---|
| `Account · Cloudflare Pages · Edit` | 建 Pages 项目、`wrangler pages deploy` |
| `Zone · DNS · Edit` | 新增 `auto.aininja365.xyz` 记录 |
| `Account · Workers KV Storage · Edit` | 建 namespace、Actions 读/写会话与已处理标记 |

同时记下 **Account ID**（面板右侧栏）。**不要**给 Global API Key。

> 旧 token `cfat_qmdc…` 已实测失效（`9109 Invalid access token`），必须新发。

### 2.2 GitHub Secrets（仓库 Settings → Secrets and variables → Actions）

| 名称 | 内容 | 备注 |
|---|---|---|
| `CF_API_TOKEN` | 2.1 的 token | |
| `CF_ACCOUNT_ID` | 账号 ID | |
| `CF_KV_NAMESPACE_ID` | KV namespace id | `wrangler kv namespace create MXIPOS_SESSION` 输出里的 `id` |
| `MXIPOS_SESSION_KEY` | 新的 6 位数字口令 | 部署期注入 `public/autotc.user.js`，**仓库里只有占位符** |
| `CUSTOM_RULES_B64` | `custom_rules.json` 的 base64 | 规则清单（约 11.7 KB），属经营配置，不进 git |

生成 base64（在旧主机上执行，避免中途落盘到 Windows）：

```bash
base64 -w0 ~/commission_tool/custom_rules.json
```

### 2.3 Cloudflare Pages Secret（接收端读口令）

`MXIPOS_SESSION_KEY` 同时要在 Pages 侧可见：

```bash
npx wrangler@4 pages secret put MXIPOS_SESSION_KEY --project-name=autotc-pages
```

（`wrangler.toml` 里不写这个值——它会进 git。）

## 3. 一次性建站步骤

```bash
# 1) 建 KV 并回填 wrangler.toml 的 id
npx wrangler@4 kv namespace create MXIPOS_SESSION
#    → 把输出的 id 填到 wrangler.toml 的 REPLACE_WITH_KV_NAMESPACE_ID

# 2) 建 Pages 项目（Direct Upload，不要接 Git 集成）
npx wrangler@4 pages project create autotc-pages --production-branch=main

# 3) 首次部署（public/data.js 用线上快照，让站点先能访问）
npx wrangler@4 pages deploy public --project-name=autotc-pages --branch=main --commit-dirty=true

# 4) 绑自定义域
#    CF 面板 → Workers & Pages → autotc-pages → Custom domains → 添加 auto.aininja365.xyz
#    该子域当前 NXDOMAIN，属新增记录；不要碰 apex 及其现有记录（护栏 6）
```

## 4. 为什么锁定 Direct Upload

`data.js` 是 3.9 MB 的生成物，被护栏 5 禁止入 git。Git 集成模式下 Pages 从仓库构建，
产物里不会有 `data.js`；Direct Upload 由 workflow 在 runner 上生成后直接推送，两条路线互斥。
**不要**为了"方便"改成 Git 集成。

## 5. 日常运维

| 场景 | 操作 |
|---|---|
| 手机 token 过期 | 手机上登录 MXIPOS → 点台账书签 → KV 更新 → 15 分钟内 Actions 自动拉到。**注意**：文档记录的 token 上限 24h47m 并非硬线——2026-10-31 实测一个签发 28h 的会话仍能成功拉单，该上限可能是按最近一次成功调用滑动计算。真实判据看 Actions 日志里是否出现 `TK04`，不要仅凭会话年龄就催人重登 |
| 手动强制拉一次 | Actions → `fetch-orders` → Run workflow → `force=true` |
| 补历史月份 | 同上，`backfill_months` 填 2~24 |
| 换上报口令 | 改 GitHub Secret `MXIPOS_SESSION_KEY` + `wrangler pages secret put`，重跑一次部署 |
| 看是否需要拉单 | Actions 日志里「门禁结论」一行会写明 `run` 与原因 |
| 定时任务被停用 | 检查 `heartbeat` workflow 是否还在跑（每月 1 日提交一行） |

## 6. 已知限制（写在这里，免得以后误判）

1. **旧平板死机时新通道数据区不可用**——方案 A 的固有代价，见第 1 节。
2. **Actions 侧台账是独立的一份**，从首次运行开始累积，不含 2026-10 之前的历史月份。
   `data.js` 是按月导出（`export_datajs.js --month`），当期数字与旧通道一致；
   要补历史月份用 `backfill_months` 逐月回灌。
3. **Actions cron 不准时**：官方最小间隔 5 分钟，高负载下可延迟数十分钟。
   实际 SLA 按「上报后最坏 1 小时内生效」理解，不要承诺"1 分钟"。
4. **15 分钟轮询是为响应速度而非成本**：仓库为 public，Actions 分钟数免费；
   若将来转 private，2000 分钟/月会被 96 次/天的轮询吃光，必须把轮询降到 6 小时或改 PAT 直触发。
5. **公开仓库的暴露面**：`data.js` / `custom_rules.json` / 会话文件均被 `.gitignore` 排除，
   泄露面是代码逻辑与规则结构，不含逐笔销售额。首次推送前务必再跑一次凭据扫描（见第 8 节）。
6. **口径未修**：`generate_data.py` 的 `checkoutTime=row[16]` / `remark=row[22]` 列错位是已知缺陷，
   迁移不负责修。若顺手修了必须单独说明。
7. **自定义域的静态资源被 zone 缓存策略压到 4 小时**：`aininja365.xyz` 这个 zone 的
   Browser Cache TTL 会把 `Cache-Control` 统一改写为 `max-age=14400`，覆盖 Pages 的 `_headers`
   （`pages.dev` 域名下 `_headers` 是完全生效的，可对比验证）。旧通道同样如此，属既有配置，
   按护栏 6 不去改 zone 设置。因此发布前用 `pipeline/scripts/stamp_assets.py` 刷新 `?v=` 版本号，
   HTML 本身是 `no-store`，换 query 即可立刻拿到新数据。**修改 `app.js` / `styles.css` 后
   必须走一次发布**，否则用户最多 4 小时看到旧文件。

## 7. 回滚

新通道出问题直接删项目或解绑域名即可，旧通道不受任何影响——这正是双轨并行的目的。
**任何时候都不要为了"修新通道"去改 nginx / Tunnel / systemd 单元。**

## 8. 推送前自检（护栏 3 / 5 / P5-9）

```bash
# 1) 确认敏感文件没被跟踪
git ls-files | grep -Ei 'data\.js$|custom_rules|session.*json|credentials|\.dev\.vars' && echo "!! 有敏感文件被跟踪" || echo "OK"

# 2) 全文扫描凭据特征（旧口令字面值故意不在文档里写死，用变量传入）
OLD_KEY='<把已废弃的 6 位口令填在这里>'
grep -rIn --exclude-dir=.git --exclude-dir=node_modules -e "$OLD_KEY" -e 'COMMISSION_ADMIN_PASSWORD=' -e 'Bearer [A-Za-z0-9]\{30,\}' . && echo "!! 命中" || echo "OK"

# 3) 确认产物不含浏览器链路
grep -rIln --exclude-dir=.git -E 'puppeteer|puppeteer-extra|chrome-launcher|Runtime\.enable|slider' . || echo "OK: 无浏览器链路"
```
