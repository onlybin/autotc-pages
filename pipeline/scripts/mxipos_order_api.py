#!/usr/bin/env python3
"""
MXIPOS(掌中宝) SP 平台订单直连查询工具 —— 不需要 MCP JWT 令牌。

逆向来源：sp.mxipos.com 前端 Vue SPA（app~06837ae4 / app~3458ad97 / login~e54da918）
已验证的关键事实：
  * 业务 API 网关是 https://cspht.mxipos.com（不是 sp.mxipos.com，后者只是静态前端）
  * 所有请求用表单 POST，公共参数字段：loginId / token / mchntCd / timestamp / key / sign
  * sign = md5("20180726fuiou95138|" + key + "|20180726fuiou95138")，key = 当前毫秒时间戳
    → 签名校验可离线生成，已实测通过（错误 token 返回业务错误码而非签名错误）
  * 订单分页：POST /order/queryOrderPage.action   （返回 JSON，无需导出 ZIP）
  * 订单详情：POST /order/getOrderDetail.action
  * 订单导出：GET  /export/orderAsyncExport.action
  * 会话续期：POST /public/loginByToken.action     （token 有效时可直接换新 token）
  * 密码登录：POST /public/login.action            （必须带阿里云验证码 nvcVal，纯 HTTP 无法通过）

因此：
  - 只要拿到一个有效 (loginId, token, timestamp)，后续全部订单查询都是纯 HTTP，
    不需要浏览器、不需要下载中心、不需要 ZIP 解析。
  - token 失效（respCode=TK04）时，唯一免 MCP 令牌的恢复方式是：
      a) 在已登录的浏览器里读取 localStorage.userInfo（extract-session 子命令），或
      b) 走密码登录，但必须通过阿里云滑块验证码（nvcVal），无法纯 HTTP 完成，或
      c) 按官方渠道开通 MCP 拿 JWT。

用法：
  # 1) 从浏览器 profile 提取会话（必须在装有 Chrome 且已登录的主机上运行）
  python3 mxipos_order_api.py extract-session --out session.json

  # 2) 用会话查询订单（纯 HTTP，Windows / Linux 均可）
  python3 mxipos_order_api.py query --session session.json \
      --start 2026-10-01 --end 2026-10-22 --shop-id 1816182 --size 20 --out orders.json

  # 3) 仅续期（token 仍有效时）
  python3 mxipos_order_api.py renew --session session.json --out session.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request

API_BASE = "https://cspht.mxipos.com"
SIGN_SECRET = os.environ.get("MXIPOS_SIGN_SECRET", "20180726fuiou95138")
TIMEOUT = 30

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "Origin": "https://sp.mxipos.com",
    "Referer": "https://sp.mxipos.com/",
}


def md5_hex(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def sign_params() -> dict:
    """公共签名参数（服务端校验通过，实测有效）。"""
    key = str(int(time.time() * 1000))
    return {
        "filterVersion": "",
        "key": key,
        "sign": md5_hex("%s|%s|%s" % (SIGN_SECRET, key, SIGN_SECRET)),
        "language": "zh_CN",
        "notCloud": "true",
    }


def http_post_form(path: str, data: dict) -> dict:
    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(API_BASE + path, data=body, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace") if exc.fp else ""
        return {"httpError": exc.code, "raw": raw[:600]}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw[:600]}


def http_get_form(path: str, params: dict) -> dict:
    """GET + query string，返回 JSON。"""
    url = API_BASE + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace") if exc.fp else ""
        return {"httpError": exc.code, "raw": raw[:600]}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw[:600]}


def http_get_bytes(path: str, params: dict) -> tuple[int, bytes, str]:
    """GET 原始字节，用于下载文件。返回 (status, bytes, content_type)。

    分块读取并按 Content-Length 校验：一次性 read() 在连接抖动时会抛
    IncompleteRead（实测下载 320KB 的 ZIP 偶发），分块+校验便于上层重试。
    """
    url = API_BASE + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=180) as resp:
            expected = str(resp.headers.get("Content-Length") or "").strip()
            chunks = []
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                chunks.append(chunk)
            body = b"".join(chunks)
            if expected.isdigit() and len(body) != int(expected):
                raise IOError("下载不完整: %d/%s 字节" % (len(body), expected))
            return resp.status, body, resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        body = exc.read() if exc.fp else b""
        return exc.code, body, ""


def load_session(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        s = json.load(fh)
    missing = [k for k in ("loginId", "mchntCd", "token", "timestamp") if not s.get(k)]
    if missing:
        raise SystemExit("会话文件缺少字段: %s" % ", ".join(missing))
    return s


def session_params(sess: dict) -> dict:
    data = sign_params()
    data.update({
        "loginId": str(sess["loginId"]),
        "token": str(sess["token"]),
        "mchntCd": str(sess["mchntCd"]),
        "timestamp": str(sess["timestamp"]),
        "currencySign": sess.get("currencySign") or "CNY",
        "isCalcPckDis": str(sess.get("isCalcPckDis") or "1"),
    })
    return data


def resp_code(res: dict) -> str:
    return str(res.get("respCode") or res.get("resultCode") or "")


def resp_desc(res: dict) -> str:
    return str(res.get("respDesc") or res.get("resultMsg") or res.get("raw") or res.get("httpError") or "")


# --------------------------------------------------------------------------- #
# 子命令
# --------------------------------------------------------------------------- #
def cmd_query(args) -> int:
    sess = load_session(args.session)
    base = session_params(sess)
    base.update({
        "payTmStartStr": args.start + " 00:00:00",
        "payTmEndStr": args.end + " 23:59:59",
    })
    if args.shop_id:
        base["shopId"] = str(args.shop_id)
    if args.search_type:
        base["searchType"] = args.search_type

    pages = []
    page = args.page
    all_records = []
    total = None
    total_pages = None
    first = None

    while True:
        params = dict(base)
        params.update({"pageNum": str(page), "pageSize": str(args.size)})
        res = http_post_form("/order/queryOrderPage.action", params)
        code = resp_code(res)
        if code != "000000":
            print("查询失败: %s %s" % (code, resp_desc(res)), file=sys.stderr)
            if code == "TK04":
                print("token 已过期。请在已登录的浏览器中重新登录后，用 extract-session 刷新会话，"
                      "或按官方渠道开通 MCP 获取 JWT。", file=sys.stderr)
            elif code == "100006":
                print("非法操作：会话参数与商户不匹配或已失效。", file=sys.stderr)
            return 2

        if first is None:
            first = res
            total = res.get("totalCount") or res.get("total")
            total_pages = res.get("totalPages")
        pages.append(res)

        blob = res.get("data")
        chunk = blob if isinstance(blob, list) else (
            (blob.get("records") or blob.get("list") or []) if isinstance(blob, dict) else [])
        all_records.extend(chunk)

        if not args.all:
            break
        if total_pages and page >= int(total_pages):
            break
        if not total_pages and len(chunk) < args.size:
            break
        page += 1

    # 实测：返回体首条为「汇总」行（shopName=汇总），其余为订单明细
    summary = next((r for r in all_records if r.get("shopName") == "汇总"), None)
    detail = [r for r in all_records if r.get("orderNo") or r.get("paySsn")]

    count = total if total is not None else len(detail)
    print("查询区间: %s ~ %s" % (args.start, args.end))
    print("订单总数: %s（页数 %s，本次抓取 %d 页 / %d 条明细）" % (
        count, total_pages if total_pages else "-", len(pages), len(detail)))
    if summary:
        print("汇总行: 订单优惠=%s 实收=%s 退款=%s 核销=%s" % (
            summary.get("orderDisAmt", "-"), summary.get("payAmt", "-"),
            summary.get("refundAmt", "-"), summary.get("writeOffAmt", "-")))
        api_sum = sum((r.get("payAmt") or 0) for r in detail)
        print("明细实收合计=%s（与汇总行%s）" % (
            api_sum, "一致" if str(api_sum) == str(summary.get("payAmt")) else "存在差异，需核对"))

    for idx, row in enumerate(detail[:args.preview], 1):
        print("  %d) 单号=%s | 时间=%s | 实收=%s | 支付=%s | 收银员=%s" % (
            idx,
            row.get("orderNo") or "-",
            row.get("payTmStr") or row.get("payTm") or "-",
            row.get("payAmt", "-"),
            row.get("payTypeDesc") or row.get("payType") or "-",
            row.get("cashierName") or row.get("payCashierId") or "-",
        ))

    if args.out:
        payload = {
            "range": {"start": args.start, "end": args.end},
            "shopId": args.shop_id or None,
            "totalCount": count,
            "totalPages": total_pages,
            "summary": summary,
            "orders": detail,
            "raw": pages if args.keep_raw else None,
        }
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        print("已写入 %s（%d 条明细）" % (args.out, len(detail)))
    return 0


def cmd_renew(args) -> int:
    sess = load_session(args.session)
    params = sign_params()
    params.update({
        "loginId": str(sess["loginId"]),
        "mchntCd": str(sess["mchntCd"]),
        "token": str(sess["token"]),
        "timestamp": str(sess["timestamp"]),
    })
    res = http_post_form("/public/loginByToken.action", params)
    code = resp_code(res)
    if code != "000000":
        print("续期失败: %s %s" % (code, resp_desc(res)), file=sys.stderr)
        return 2
    data = res.get("data") or {}
    token = data.get("token") or ""
    stamp = data.get("timestamp") or ""
    if not token:
        print("响应中无 token: %s" % json.dumps(res, ensure_ascii=False)[:300], file=sys.stderr)
        return 2
    sess.update({"token": token, "timestamp": stamp or sess["timestamp"]})
    with open(args.out or args.session, "w", encoding="utf-8") as fh:
        json.dump(sess, fh, ensure_ascii=False, indent=2)
    print("续期成功，token 前 8 位: %s..." % token[:8])
    return 0


EXTRACT_JS = r"""
// 在已登录的 Chrome 中读取 localStorage.userInfo，输出 base64 JSON。
const { spawn, execSync } = require('child_process');
const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 9240);
const PROFILE = process.argv[3] || '/tmp/mxipos_extract_profile';
const SOURCE = process.argv[4] || (process.env.HOME + '/.config/google-chrome');

function frame(text) {
  const p = Buffer.from(text), m = crypto.randomBytes(4);
  let h;
  if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  const mk = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) mk[i] = p[i] ^ m[i % 4];
  return Buffer.concat([h, m, mk]);
}
function parse(buf) {
  const out = []; let o = 0;
  while (o + 2 <= buf.length) {
    const a = buf[o], b = buf[o + 1];
    let len = b & 0x7f, hl = 2;
    if (len === 126) { if (o + 4 > buf.length) break; len = buf.readUInt16BE(o + 2); hl = 4; }
    else if (len === 127) { if (o + 10 > buf.length) break; len = Number(buf.readBigUInt64BE(o + 2)); hl = 10; }
    const ml = (b & 0x80) ? 4 : 0, end = o + hl + ml + len;
    if (end > buf.length) break;
    let pl = buf.subarray(o + hl + ml, end);
    if (ml) { const m = buf.subarray(o + hl, o + hl + 4); pl = Buffer.from(pl.map((x, i) => x ^ m[i % 4])); }
    out.push({ op: a & 0x0f, fin: !!(a & 0x80), pl });
    o = end;
  }
  return { out, rest: buf.subarray(o) };
}

(async () => {
  try { execSync('pkill -f remote-debugging-port=' + PORT, { stdio: 'pipe' }); } catch (e) {}
  execSync('rm -rf ' + PROFILE, { stdio: 'pipe' });
  execSync('mkdir -p ' + PROFILE, { stdio: 'pipe' });
  try { execSync('cp -r "' + SOURCE + '/Default" ' + PROFILE + '/Default', { stdio: 'pipe' }); } catch (e) {}
  try { execSync('cp "' + SOURCE + '/Local State" ' + PROFILE + '/', { stdio: 'pipe' }); } catch (e) {}
  execSync('rm -f ' + PROFILE + '/Singleton*', { stdio: 'pipe' });

  const ch = spawn('/usr/bin/google-chrome', [
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, '--headless=new',
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--password-store=basic', 'about:blank'
  ], { detached: true, stdio: 'ignore' });
  ch.unref();

  const j = async (u) => (await fetch(u)).json();
  for (let i = 0; i < 60; i++) { try { await j('http://127.0.0.1:' + PORT + '/json/version'); break; } catch (e) { await new Promise(r => setTimeout(r, 300)); } }
  const pages = await j('http://127.0.0.1:' + PORT + '/json/list');
  const ws = net.createConnection({ host: '127.0.0.1', port: PORT });
  await new Promise((r, jj) => { ws.once('connect', r); ws.once('error', jj); });
  const u = new URL(pages[0].webSocketDebuggerUrl);
  const ck = crypto.randomBytes(16).toString('base64');
  ws.write('GET ' + u.pathname + u.search + ' HTTP/1.1\r\nHost: ' + u.host +
    '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + ck +
    '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  let buf = Buffer.alloc(0), frag = Buffer.alloc(0);
  await new Promise((r) => {
    const ondata = (c) => { buf = Buffer.concat([buf, c]); const i = buf.indexOf('\r\n\r\n'); if (i >= 0) { ws.off('data', ondata); buf = buf.subarray(i + 4); r(); } };
    ws.on('data', ondata);
  });
  let id = 1; const pend = new Map();
  const handle = (c) => {
    buf = Buffer.concat([buf, c]);
    const { out, rest } = parse(buf); buf = rest;
    for (const f of out) {
      if (f.op !== 1 && f.op !== 0) continue;
      let t = '';
      if (f.op === 1 && f.fin) t = f.pl.toString('utf8');
      else { frag = Buffer.concat([frag, f.pl]); if (!f.fin) continue; t = frag.toString('utf8'); frag = Buffer.alloc(0); }
      let m; try { m = JSON.parse(t); } catch (e) { continue; }
      if (m.id && pend.has(m.id)) { const { res } = pend.get(m.id); pend.delete(m.id); res(m.result); }
    }
  };
  ws.on('data', handle);
  const send = (method, params) => new Promise((res) => {
    const mid = id++; pend.set(mid, { res });
    ws.write(frame(JSON.stringify({ id: mid, method, params })));
    setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); res(null); } }, 30000);
  });

  await send('Page.enable', {}); await send('Runtime.enable', {});
  await send('Page.navigate', { url: 'https://sp.mxipos.com/' });
  await new Promise(r => setTimeout(r, 7000));
  const r = await send('Runtime.evaluate', {
    expression: "(()=>localStorage.getItem('userInfo')||'')()", returnByValue: true
  });
  const raw = (r && r.result && r.result.value) || '';
  console.log('SESSION_B64:' + Buffer.from(raw, 'utf8').toString('base64'));
  ws.end();
  try { process.kill(ch.pid); } catch (e) {}
})().catch(e => { console.error('EXTRACT_ERR ' + e.message); process.exit(1); });
"""


def cmd_extract(args) -> int:
    tmp = args.workdir or "/tmp/mxipos_order_api_extract.cjs"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(EXTRACT_JS)
    cmd = ["node", tmp, str(args.port), args.profile, os.path.expanduser(args.chrome_profile)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=args.timeout)
    except FileNotFoundError:
        print("未找到 node，可执行文件需与 Chrome 同机。", file=sys.stderr)
        return 1
    if proc.stderr.strip():
        print(proc.stderr.strip()[:800], file=sys.stderr)

    lines = [l for l in proc.stdout.splitlines() if l.startswith("SESSION_B64:")]
    if not lines:
        print("未能提取会话（可能未登录或页面未加载）。", file=sys.stderr)
        return 2

    import base64
    raw = base64.b64decode(lines[0].split(":", 1)[1]).decode("utf-8", "replace")
    if not raw:
        print("localStorage 中无 userInfo，说明该 profile 未登录。", file=sys.stderr)
        return 2
    info = json.loads(raw)
    sess = {
        "loginId": info.get("loginId"),
        "mchntCd": info.get("mchntCd"),
        "token": info.get("token"),
        "timestamp": info.get("timestamp"),
        "isCalcPckDis": info.get("isCalcPckDis", "1"),
        "currencySign": info.get("currencySign", "CNY"),
        "shopId": info.get("singleShopId") or info.get("shopId") or "",
        "extractedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    if not sess["token"]:
        print("userInfo 中无 token。", file=sys.stderr)
        return 2
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(sess, fh, ensure_ascii=False, indent=2)
    print("已写入 %s（token 前 8 位 %s...）" % (args.out, sess["token"][:8]))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="MXIPOS 订单直连查询（无需 MCP JWT）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    q = sub.add_parser("query", help="按时间范围查询订单（纯 HTTP）")
    q.add_argument("--session", required=True)
    q.add_argument("--start", required=True, help="YYYY-MM-DD")
    q.add_argument("--end", required=True, help="YYYY-MM-DD")
    q.add_argument("--shop-id", default="")
    q.add_argument("--page", type=int, default=1)
    q.add_argument("--size", type=int, default=20)
    q.add_argument("--all", action="store_true", help="按 totalPages 抓取全部页")
    q.add_argument("--keep-raw", action="store_true", help="输出中保留原始分页响应")
    q.add_argument("--search-type", default="")
    q.add_argument("--preview", type=int, default=5)
    q.add_argument("--out", default="")
    q.set_defaults(func=cmd_query)

    r = sub.add_parser("renew", help="用 loginByToken 续期")
    r.add_argument("--session", required=True)
    r.add_argument("--out", default="")
    r.set_defaults(func=cmd_renew)

    e = sub.add_parser("extract-session", help="从已登录 Chrome 提取会话（需同机有 node+Chrome）")
    e.add_argument("--out", required=True)
    e.add_argument("--port", type=int, default=9240)
    e.add_argument("--profile", default="/tmp/mxipos_order_api_profile")
    e.add_argument("--chrome-profile", default="~/.config/google-chrome")
    e.add_argument("--workdir", default="")
    e.add_argument("--timeout", type=int, default=180)
    e.set_defaults(func=cmd_extract)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
