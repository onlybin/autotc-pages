# D 类文件登记册 · 浏览器链路弃用清单

> 生成时间：2026-10-31
> 处置原则（护栏 2）：**远端一个文件都没删**。本册只做「标记 + 登记」，不执行 `rm`。
> 弃用目标是「运行路径 100% 不含浏览器」，不是「文件消失」——回滚时旧通道还要用到它们。

## 0. 结论先行

| 项 | 状态 |
|---|---|
| 远端 `/home/abc/commission_tool/` 内 D 类文件 | **原样保留**，未移动、未删除 |
| `commission-keepalive.timer` | 10-31 实测仍 enabled+active，**需 `systemctl --user disable`（不删）**，见下 |
| 本仓库 | 不含任何 D 类文件；`legacy_browser/` 已在 `.gitignore` 中排除 |
| Pages 部署产物 `public/` | 不含任何 `puppeteer` / `chrome` / `cdp` / `slider` / `cookie` 脚本 |

为什么仓库里不留副本：本仓库按决策 3-B 为 **public**，把一堆死掉的滑块/Cookie 脚本连同它们
可能残留的硬编码路径公开，收益为零、风险非零。唯一权威副本仍在旧主机，回滚直接用它。

## 1. 本地暂存区（不入 git）

取回用于核对的副本位于本机 `cloudflare/legacy_browser/`，仅作证据留档，已加入 `.gitignore`。
对应远端路径前缀 `/home/abc/commission_tool/`。

| 文件 | 远端字节 | 弃用原因 |
|---|---|---|
| `fetch_orders_and_update.mjs` | 25,915 | 旧拉单主脚本（浏览器驱动）。另有 3 个 .bak：19,469 / 24,841 / 25,885 |
| `auto_fetch_orders.mjs` | 15,842 | 旧拉单 |
| `keepalive_session.mjs` | 7,619 | 浏览器保活。**已证伪**：无法续 token（+ .bak 7,589） |
| `login_once.js` | 5,181 | 自动登录尝试 |
| `login_once2.js` | 5,699 | 自动登录尝试 |
| `login_once3.js` | 7,395 | 自动登录尝试 |
| `login_fix.js` | 5,337 | 自动登录修补 |
| `slider_login.js` | 5,693 | 滑块验证码，**已确认无法绕过** |
| `probe_slider.js` | 2,867 | 滑块探测 |
| `probe_slider.mjs` | 7,213 | 滑块探测 |
| `rdp_login_window.js` | 3,560 | RDP 登录窗 |
| `main_profile_test.js` | 1,148 | Chrome profile 测试 |
| `cdp_diag.js` | 2,786 | CDP 取 Cookie 诊断 |
| `cdp_extract.mjs` | 1,166 | CDP 取 Cookie |
| `debug_download.mjs` | 1,706 | 下载调试 |
| `debug_download2.mjs` | 2,507 | 下载调试 |
| `debug_download3.mjs` | 4,224 | 下载调试 |
| `get_mxipos_cookies.mjs` | 1,864 | Cookie 提取 |
| `check_chrome_cookies.mjs` | 1,235 | Cookie 检查 |
| `extract_cookies.mjs` | 2,479 | Cookie 提取 |
| `param_probe.js` | 687 | 参数探测 |
| `param_probe2.js` | 914 | 参数探测 |
| `NUL` | 142 | Windows 误创建的空文件 |

合计 23 个文件（不含 .bak 与目录）。

## 2. 依赖与配置类

| 对象 | 现状 | 处置 |
|---|---|---|
| `package.json` 的 `puppeteer-extra`（^3.3.6） | 远端存在 | **本仓库 `pipeline/package.json` 已不包含**；远端未动 |
| `package.json` 的 `puppeteer-extra-plugin-stealth`（^2.11.2） | 远端存在 | 同上 |
| `package.json` 的 `check` 脚本 | 引用了 `fetch_orders_and_update.mjs` | 本仓库重写，不再引用任何 `.mjs` 浏览器脚本 |
| `~/.config/systemd/user/commission-keepalive.service`（592 B） | **enabled + active**（10-31 10:52 实测） | 待执行 `systemctl --user disable --now commission-keepalive.timer`，**不删单元文件** |
| `~/.config/systemd/user/commission-keepalive.timer`（224 B） | 同上 | 同上 |
| 远端 `commission_tool/systemd/` 模板目录 | `ExecStart` 仍指向 `.mjs`，与线上不一致 | 仅加声明，本仓库不收录 |
| `~/.local/share/commission_tool/mxipos_chrome_profile/` + 2 个备份 | 目录 | **需用户确认后**才可清理，本任务不动 |
| `mxipos_session.json`（3,371 B） | Chrome Cookie 数组 | 与被 `mxipos_http_fetch.py` 使用的 `mxipos_api_session.json`（273 B）**同名易混**，弃用后删。新通道**不沿用这个名字** |

## 3. 命名歧义（务必区分）

| 文件名 | 大小 | 内容 | 用途 |
|---|---|---|---|
| `mxipos_api_session.json` | 273 B | **API 会话对象** `{loginId,mchntCd,token,timestamp,...}` | 拉单真正使用的就是它 |
| `mxipos_session.json` | 3,371 B | **Chrome Cookie 数组** | 浏览器链路遗留，弃用后可删 |
| `mxipos_session.key` | 6 B | 旧上报口令 | **已作废**，新通道用新口令 |

## 4. 运行路径确认（弃用的实质判据）

| 链路 | 是否含浏览器 | 证据 |
|---|---|---|
| 旧主机 `commission-fetch.service` | 否 | `ExecStart` 指向 `scripts/mxipos_http_fetch.py`（2026-10-29 上线） |
| 旧主机 `commission-api.service` | 否 | `ExecStart=/usr/bin/node server.js` |
| 新通道 Actions 流水线 | 否 | `pull_orders.py` 只依赖 `mxipos_order_api.py` + `mxipos_export_orders.py`，纯 HTTP 签名 |
| 新通道 Pages 产物 | 否 | 只含静态资源 + `manual.js`（纯函数，零网络） |

签名机制佐证：`sign = md5("20180726fuiou95138|" + 毫秒时间戳 + "|20180726fuiou95138")`，
纯参数签名，不依赖 Cookie，所以整条链路不需要任何浏览器。
