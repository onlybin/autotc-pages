#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""纯 HTTP 拉单编排（完全替代 xvfb + Chrome + puppeteer 链路）。

流程：
  1. 读 mxipos_session.json（loginId/token/mchntCd/timestamp）
  2. 轻量校验会话（查当天订单）
  3. orderAsyncExport 建导出任务 -> 轮询下载中心 -> 下载 ZIP
  4. python3 generate_data.py            (COMMISSION_ORDER_FILE / COMMISSION_DATA_OUTPUT)
  5. node scripts/ledger_cli.js import   (写入 SQLite 台账，权威源)
  6. node scripts/export_datajs.js       (从台账导出 data.js)
  7. 原子替换 data.js

为什么不走浏览器：远端仅 1.8GB 内存，Chrome 启动经常 30s 超时；
签名是纯参数签名（md5(SECRET|key|SECRET)），不依赖 Cookie，HTTP 可直连。

用法：
  python3 scripts/mxipos_http_fetch.py                # 拉当前月
  python3 scripts/mxipos_http_fetch.py --month 2026-10
  python3 scripts/mxipos_http_fetch.py --verify-only  # 只校验会话，不导出

退出码：0 成功；2 会话无效；3 导出失败；4 生成/导入失败；5 已有任务在跑
输出：最后一行固定为 JSON 摘要，供 server.js 解析。
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import calendar
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

DB_PATH = os.environ.get("COMMISSION_DB_PATH") or \
    "/home/abc/.local/share/commission_tool/commission.sqlite3"
# 注意：mxipos_session.json 已被 fetch_orders_and_update.mjs 用来存 Cookie 数组（list），
# 会话对象必须另起文件名，否则读到的是 list 而不是 dict。
SESSION_FILE = os.environ.get("MXIPOS_SESSION_FILE") or \
    os.path.join(os.path.dirname(DB_PATH), "mxipos_api_session.json")
LOG_FILE = os.path.join(ROOT, "auto_fetch.log")
LOCK_FILE = os.path.join(ROOT, ".mxipos_http_fetch.lock")
PYTHON = sys.executable or "python3"


def log(*parts):
    line = "[%s] %s" % (datetime.now().strftime("%Y/%m/%d %H:%M:%S"), " ".join(str(p) for p in parts))
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def run(cmd, cwd=ROOT, env=None, timeout=900):
    """执行外部命令，返回 (ok, stdout, stderr)。"""
    merged = dict(os.environ)
    if env:
        merged.update(env)
    proc = subprocess.run(
        cmd, cwd=cwd, env=merged, capture_output=True, text=True, timeout=timeout
    )
    return proc.returncode == 0, (proc.stdout or ""), (proc.stderr or "")


def load_session():
    if not os.path.exists(SESSION_FILE):
        return None
    try:
        with open(SESSION_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as ex:  # noqa: BLE001
        log("读取会话文件失败", ex)
        return None
    if not isinstance(data, dict):
        log("会话文件格式错误（应为对象，实际是 %s）" % type(data).__name__, SESSION_FILE)
        return None
    for key in ("loginId", "token", "mchntCd", "timestamp"):
        if not str(data.get(key) or "").strip():
            log("会话文件缺字段", key)
            return None
    return data


def _verify_once(sess, api):
    today = datetime.now().strftime("%Y-%m-%d")
    params = api.session_params(sess)
    params.update({
        "payTmStartStr": today + " 00:00:00",
        "payTmEndStr": today + " 23:59:59",
        "pageNum": "1",
        "pageSize": "1",
    })
    try:
        res = api.http_post_form("/order/queryOrderPage.action", params)
    except Exception as ex:  # noqa: BLE001
        return False, "请求异常: %s" % ex
    code = api.resp_code(res)
    if code == "000000":
        return True, "OK total=%s" % res.get("totalCount", "?")
    return False, "%s %s" % (code, api.resp_desc(res))


# 这台机器的 Wi-Fi（BCM4324）会间歇断连，表现为 DNS 解析失败或连接超时，
# 与 token 有效性无关，必须退避重试，否则一次抖动就被记成一次失败。
NETWORK_HINTS = ("name resolution", "urlopen", "timed out", "timedout",
                 "connection reset", "temporary failure", "network is unreachable")


def verify_session(sess, api, attempts=3):
    last = ""
    for attempt in range(attempts):
        ok, desc = _verify_once(sess, api)
        if ok:
            return True, desc
        last = desc
        if any(h in desc.lower() for h in NETWORK_HINTS):
            log("会话校验遇网络异常 第%d/%d次，退避重试" % (attempt + 1, attempts), desc)
            time.sleep(8)
            continue
        return False, desc  # 明确的业务错误（如 TK04 过期），不做无谓重试
    return False, last


def month_range(month):
    year, mon = [int(x) for x in month.split("-")]
    last = calendar.monthrange(year, mon)[1]
    return ("%s-01 00:00:00" % month, "%s-%02d 23:59:59" % (month, last))


def main():
    args = sys.argv[1:]
    month = ""
    verify_only = False
    for i, a in enumerate(args):
        if a == "--month" and i + 1 < len(args):
            month = args[i + 1]
        elif a == "--verify-only":
            verify_only = True
    month = month or datetime.now().strftime("%Y-%m")

    lock_fh = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("已有拉单任务在运行，跳过")
        print(json.dumps({"ok": False, "skipped": True, "reason": "another run in progress"},
                         ensure_ascii=False))
        return 5

    import mxipos_order_api as api
    import mxipos_export_orders as exporter

    sess = load_session()
    if not sess:
        log("会话文件不存在或缺字段", SESSION_FILE)
        print(json.dumps({"ok": False, "reason": "no session"}, ensure_ascii=False))
        return 2

    ok, desc = verify_session(sess, api)
    if not ok:
        log("会话校验失败", desc)
        print(json.dumps({"ok": False, "reason": "session invalid", "detail": desc},
                         ensure_ascii=False))
        return 2
    log("会话校验通过", desc)

    if verify_only:
        print(json.dumps({"ok": True, "verified": True, "loginId": sess["loginId"]},
                         ensure_ascii=False))
        return 0

    start, end = month_range(month)
    run_dir = tempfile.mkdtemp(prefix="mxhttp_%s_" % month, dir="/tmp")
    log("开始 HTTP 拉单", month, start, "~", end)

    try:
        uuid, _res = exporter.create_export_task(sess, start, end)
        log("导出任务已创建", uuid or "(no uuid)")

        row = None
        deadline = time.time() + 420
        while time.time() < deadline:
            try:
                rows, _total = exporter.query_download_list(sess, start[:10], end[:10])
            except Exception as ex:  # noqa: BLE001
                log("查询下载列表异常，重试", ex)
                rows = []
            row = exporter.pick_row(rows, uuid)
            if row:
                status = str(row.get("status") or row.get("_status") or "")
                file_status = str(row.get("fileStatus") or row.get("_fileStatus") or "")
                name = row.get("taskName") or row.get("fileName") or ""
                if status == "1" and file_status in ("0", "", "1"):
                    log("导出完成", name)
                    break
                if "失败" in status or "异常" in status:
                    log("导出任务失败", status, name)
                    print(json.dumps({"ok": False, "reason": "export failed", "status": status},
                                     ensure_ascii=False))
                    return 3
            time.sleep(5)
        else:
            log("等待导出超时")
            print(json.dumps({"ok": False, "reason": "export timeout"}, ensure_ascii=False))
            return 3

        row_id = row.get("rowId") or row.get("id")
        zip_path = None
        last_error = None
        for attempt in range(3):
            try:
                zip_path = exporter.download_zip(sess, row_id, run_dir)
                break
            except Exception as ex:  # noqa: BLE001
                last_error = ex
                log("ZIP 下载失败 第%d/3次" % (attempt + 1), ex)
                time.sleep(3)
        if not zip_path:
            log("ZIP 下载最终失败", last_error)
            print(json.dumps({"ok": False, "reason": "download failed",
                              "detail": str(last_error)}, ensure_ascii=False))
            return 3
        zip_name = os.path.basename(zip_path)
        log("ZIP 已下载", zip_path, os.path.getsize(zip_path), "bytes")

        generated = os.path.join(run_dir, "data.js")
        ok, out, err = run(
            [PYTHON, "generate_data.py"],
            env={"COMMISSION_ORDER_FILE": zip_path, "COMMISSION_DATA_OUTPUT": generated},
        )
        if err.strip():
            log("生成数据提示", err.strip()[:500])
        if not ok or not os.path.exists(generated):
            log("generate_data.py 失败", out[-500:], err[-500:])
            print(json.dumps({"ok": False, "reason": "generate failed"}, ensure_ascii=False))
            return 4
        log("数据已生成", out.strip()[-300:])

        with open(zip_path, "rb") as fh:
            sha = hashlib.sha256(fh.read()).hexdigest()

        ok, out, err = run([
            "node", "scripts/ledger_cli.js", "import",
            "--db", DB_PATH, "--data", generated,
            "--month", month, "--source", zip_name, "--sha", sha,
        ])
        if not ok:
            log("台账导入失败", out[-500:], err[-500:])
            print(json.dumps({"ok": False, "reason": "ledger import failed"}, ensure_ascii=False))
            return 4
        ledger_summary = ""
        try:
            payload = json.loads(out)
            ledger_summary = json.dumps(
                {k: payload.get(k) for k in ("month", "rowCount", "commissionRows",
                                             "totalCommission", "integrity") if k in payload},
                ensure_ascii=False)
        except Exception:  # noqa: BLE001
            ledger_summary = out.strip()[:200]
        log("台账已提交", ledger_summary)

        tmp_data = os.path.join(ROOT, "data.js.tmp")
        ok, out, err = run([
            "node", "scripts/export_datajs.js", "--db", DB_PATH,
            "--month", month, "--source", zip_name, "--out", tmp_data,
        ])
        if not ok:
            log("导出 data.js 失败", out[-500:], err[-500:])
            print(json.dumps({"ok": False, "reason": "export_datajs failed"}, ensure_ascii=False))
            return 4
        os.replace(tmp_data, os.path.join(ROOT, "data.js"))
        log("data.js 已由台账刷新", out.strip()[-200:])

        summary = {"ok": True, "month": month, "source": zip_name, "sha256": sha,
                   "range": [start, end], "generated": out.strip()[-200:]}
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)
        try:
            fcntl.flock(lock_fh, fcntl.LOCK_UN)
            lock_fh.close()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        log("未捕获异常", repr(exc))
        print(json.dumps({"ok": False, "reason": "exception", "detail": str(exc)},
                         ensure_ascii=False))
        sys.exit(1)
