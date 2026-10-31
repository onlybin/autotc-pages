# 外烟提成统计系统 · Cloudflare Pages 通道

便利店外烟提成统计与看板。本仓库承载**新通道 `https://auto.aininja365.xyz/`**，
与既有通道 `https://aininja365.xyz/autotc/` **双轨并行**——旧通道继续跑，新通道独立上线，
任一条挂了另一条不受影响。

> 迁移背景、事实基线与验收标准的完整说明见 `docs/` 与原始提示词文档。

## 结构

```
public/            Pages 部署产物（A 类静态资源，含生成物 data.js）
functions/         Pages Functions
  autotc/api/[[path]].js    /autotc/api/* 同域反代到旧通道（方案 A）
  api/mxipos-session.js     手机 token 接收端（Cloudflare KV）
pipeline/          拉单 + 计算链路（无浏览器，Node + Python）
  scripts/pull_orders.py    Actions 入口：导出 → 生成 → 台账 → data.js
  scripts/ci_session.py     KV 门禁：只在会话变化时才真拉单
  lib/                      台账与规则（node:sqlite）
backend/           server.js + manual.html + manual_page.js
                   旧通道后台（服务端与后台前端），一期**不部署**，仅作反代契约与二期参考
docs/              DEPLOY.md（运维手册）/ DEPRECATED.md（弃用登记）/ CHANGELOG.md
```

## 三条硬约束

1. **旧通道零改动**：nginx、Tunnel、systemd 单元、旧主机文件，一行都不碰。新通道纯新增。
2. **凭据不入库**：`data.js`、`custom_rules.json`、会话文件、口令一律走 `.gitignore` + Secrets。
3. **运行路径不含浏览器**：签名是纯参数签名（`md5(secret|ms|secret)`），不需要 Cookie，
   因此整条链路不需要 Chrome / puppeteer / 滑块。旧脚本原样留在旧主机，见 `docs/DEPRECATED.md`。

## 一期能力边界（如实表述）

- ✅ 排行榜首页（`/`）+ 订单详情页（`/orders`）
- ✅ Actions 定时拉单 + 算提成 + 生成 `data.js` + 发布
- ✅ 手机 token 上报切到新域名（KV）
- ⚠️ 看板实时数字**反代旧主机**，旧平板死机时数据区不可用——方案 A 是过渡形态
- ❌ 后台管理页 `manual.html` 一期不上新通道，仍在旧通道维护

详见 `docs/DEPLOY.md` 第 6 节「已知限制」。
