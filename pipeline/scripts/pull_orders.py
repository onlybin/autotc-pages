#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub Actions 拉单入口（CI 版）。

业务逻辑完全复用远端同一套模块：
  mxipos_order_api.py（纯 HTTP 签名，不依赖 Cookie/浏览器）
  mxipos_export_orders.py（建导出任务 → 轮询下载中心 → 下载 ZIP）

与远端 scripts/mxipos_http_fetch.py 只有 3 处差异，均为 CI 环境强制要求：
  1. 去掉 fcntl 文件锁 —— 互斥改由 workflow 的 concurrency 保证。
  2. 去掉 /home/abc 与 /home/abc/.venv 硬路径 —— 全部走环境变量或命令行参数。
  3. data.js 输出改为 --out 指定，直接落到 Pages 的 public/ 目录。

流程（每个月一份 ZIP）：
  ① orderAsyncExport 建任务 → 轮询 → 下载 ZIP
  ② python generate_data.py   ZIP → 中间 JSON（COMMISSION_ORDER_FILE / COMMISSION_DATA_OUTPUT）
  ③ node scripts/ledger_cli.js import   中间 JSON → SQLite 台账（权威源）
  全部月份完成后：
  ④ node scripts/export_datajs.js       台账 → data.js（权威导出路径，不再走 custom_rules.json）

退出码：0 成功；2 会话无效；3 导出失败；4 生成/导入失败
最后一行固定输出 JSON 摘要，供 workflow 解析。
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

CST = timezone(timedelta(hours=8))
PYTHON = sys.executable or "python3"

# 新通道后端（Worker + D1）。设置后：规则从 D1 取，订单写回 D1。
WORKER_BASE = os.environ.get("COMMISSION_WORKER_BASE", "").strip().rstrip("/")
IMPORT_TOKEN = os.environ.get("COMMISSION_IMPORT_TOKEN", "").strip()
RULES_FILE = os.path.join(ROOT, "custom_rules.json")


def http_json(url, method="GET", body=None, token="", timeout=120):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "autotc-ci/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def sync_rules_from_d1():
    """把 D1 里的现行规则写成 custom_rules.json，供 generate_data.py 使用。

    这一步很关键：后台规则改在 D1 后，若 CI 仍用旧快照算提成，导出的 data.js 会与看板不一致。
    """
    if not WORKER_BASE or not IMPORT_TOKEN:
        log("未配置 WORKER_BASE / IMPORT_TOKEN，规则沿用本地快照")
        return False
    try:
        payload = http_json(f"{WORKER_BASE}/autotc/api/internal/rules", token=IMPORT_TOKEN, timeout=60)
        rules = payload.get("rules") or []
        if not rules:
            log("D1 返回的规则为空，沿用本地快照")
            return False
        with open(RULES_FILE, "w", encoding="utf-8") as handle:
            json.dump({"updatedAt": now_text(), "rules": rules}, handle, ensure_ascii=False)
        log(f"规则已从 D1 同步：{len(rules)} 条，ruleSetId={payload.get('ruleSetId')}")
        return True
    except Exception as exc:  # noqa: BLE001
        log("从 D1 取规则失败，沿用本地快照", exc)
        return False


def push_orders_to_d1(data_file, month, source_name, sha):
    """把这一批算好的订单写进 D1，使新通道看板与 CI 台账保持一致。"""
    if not WORKER_BASE or not IMPORT_TOKEN:
        return False
    try:
        with open(data_file, encoding="utf-8") as handle:
            text = handle.read()
        payload = json.loads(text.replace("window.COMMISSION_DATA", "", 1).strip().lstrip("=").strip().rstrip(";"))
        orders = payload.get("orders") or []
        result = http_json(
            f"{WORKER_BASE}/autotc/api/internal/import",
            method="POST",
            token=IMPORT_TOKEN,
            body={
                "targetMonth": month,
                "sourceFilename": source_name,
                "sourceSha256": sha,
                "orders": orders,
                "fallbackRules": payload.get("rules") or [],
            },
            timeout=300,
        )
        log(f"D1 导入完成 {month}：rowCount={result.get('rowCount')}")
        return True
    except Exception as exc:  # noqa: BLE001
        log("写入 D1 失败", exc)
        return False


def now_text():
    return datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")


def log(*parts):
    stamp = datetime.now(CST).strftime("%Y/%m/%d %H:%M:%S")
    print("[%s] %s" % (stamp, " ".join(str(p) for p in parts)), flush=True)


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def run(cmd, env=None, timeout=1800):
    merged = dict(os.environ)
    if env:
        merged.update(env)
    proc = subprocess.run(
        cmd, cwd=ROOT, env=merged, capture_output=True, text=True, timeout=timeout
    )
    return proc.returncode == 0, (proc.stdout or ""), (proc.stderr or "")


def parse_args(argv):
    opts = {
        "month": datetime.now(CST).strftime("%Y-%m"),
        "backfill": 1,
        "db": os.environ.get("COMMISSION_DB_PATH", "").strip(),
        "out": os.environ.get("COMMISSION_DATA_OUTPUT", "").strip(),
        "session": os.environ.get("MXIPOS_SESSION_FILE", "").strip(),
        "verify_only": False,
    }
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--month" and index + 1 < len(argv):
            opts["month"] = argv[index + 1]
            index += 2
        elif arg == "--backfill" and index + 1 < len(argv):
            opts["backfill"] = max(1, min(24, int(argv[index + 1])))
            index += 2
        elif arg == "--db" and index + 1 < len(argv):
            opts["db"] = argv[index + 1]
            index += 2
        elif arg == "--out" and index + 1 < len(argv):
            opts["out"] = argv[index + 1]
            index += 2
        elif arg == "--session" and index + 1 < len(argv):
            opts["session"] = argv[index + 1]
            index += 2
        elif arg == "--verify-only":
            opts["verify_only"] = True
            index += 1
        else:
            index += 1
    if not opts["db"]:
        opts["db"] = os.path.join(ROOT, "work", "commission.sqlite3")
    if not opts["out"]:
        opts["out"] = os.path.join(ROOT, "public", "data.js")
    if not opts["session"]:
        opts["session"] = os.path.join(os.path.dirname(opts["db"]), "mxipos_api_session.json")
    return opts


def load_session(path):
    if not os.path.exists(path):
        log("会话文件不存在", path)
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception as exc:  # noqa: BLE001
        log("读取会话文件失败", exc)
        return None
    if not isinstance(data, dict):
        log("会话文件应为对象，实际是 %s" % type(data).__name__)
        return None
    for key in ("loginId", "token", "mchntCd", "timestamp"):
        if not str(data.get(key) or "").strip():
            log("会话文件缺字段", key)
            return None
    return data


def month_range(month):
    year, mon = [int(x) for x in month.split("-")]
    if mon == 12:
        nxt = datetime(year + 1, 1, 1)
    else:
        nxt = datetime(year, mon + 1, 1)
    last_day = (nxt - timedelta(days=1)).day
    return ("%s-01 00:00:00" % month, "%s-%02d 23:59:59" % (month, last_day))


def shift_month(month, delta):
    year, mon = [int(x) for x in month.split("-")]
    total = year * 12 + (mon - 1) + delta
    return "%04d-%02d" % (total // 12, total % 12 + 1)


def verify_session(sess, api, attempts=3):
    today = datetime.now(CST).strftime("%Y-%m-%d")
    for attempt in range(attempts):
        params = api.session_params(sess)
        params.update({
            "payTmStartStr": today + " 00:00:00",
            "payTmEndStr": today + " 23:59:59",
            "pageNum": "1",
            "pageSize": "1",
        })
        try:
            res = api.http_post_form("/order/queryOrderPage.action", params)
        except Exception as exc:  # noqa: BLE001
            if attempt + 1 < attempts:
                log("会话校验网络异常，退避重试", exc)
                time.sleep(10)
                continue
            return False, "请求异常: %s" % exc
        code = api.resp_code(res)
        if code == "000000":
            return True, "OK total=%s" % res.get("totalCount", "?")
        # TK04 = token 过期；这是业务错误，重试无意义
        return False, "%s %s" % (code, api.resp_desc(res))
    return False, "重试耗尽"


def pull_month(sess, api, exporter, month, work_dir):
    start, end = month_range(month)
    log("开始导出", month, start, "~", end)

    uuid, _res = exporter.create_export_task(sess, start, end)
    log("导出任务已创建", uuid or "(no uuid)")

    row = None
    deadline = time.time() + 600
    while time.time() < deadline:
        try:
            rows, _total = exporter.query_download_list(sess, start[:10], end[:10])
        except Exception as exc:  # noqa: BLE001
            log("查询下载列表异常，重试", exc)
            rows = []
        row = exporter.pick_row(rows, uuid)
        if row:
            status = str(row.get("status") or row.get("_status") or "")
            file_status = str(row.get("fileStatus") or row.get("_fileStatus") or "")
            if status == "1" and file_status in ("0", "", "1"):
                log("导出完成", row.get("taskName") or row.get("fileName") or "")
                break
            if "失败" in status or "异常" in status:
                log("导出任务失败", status)
                return None, "export failed: %s" % status
        time.sleep(5)
    else:
        return None, "export timeout"

    row_id = row.get("rowId") or row.get("id")
    last_error = None
    for attempt in range(3):
        try:
            zip_path = exporter.download_zip(sess, row_id, work_dir)
            return zip_path, None
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            log("ZIP 下载失败 第%d/3次" % (attempt + 1), exc)
            time.sleep(5)
    return None, "download failed: %s" % last_error


def main():
    opts = parse_args(sys.argv[1:])

    import mxipos_order_api as api
    import mxipos_export_orders as exporter

    sess = load_session(opts["session"])
    if not sess:
        emit({"ok": False, "reason": "no session"})
        return 2

    ok, desc = verify_session(sess, api)
    if not ok:
        log("会话校验失败", desc)
        emit({"ok": False, "reason": "session invalid", "detail": desc})
        return 2
    log("会话校验通过", desc)

    if opts["verify_only"]:
        emit({"ok": True, "verified": True, "loginId": sess["loginId"]})
        return 0

    months = [shift_month(opts["month"], -offset) for offset in range(opts["backfill"] - 1, -1, -1)]
    log("本次处理月份", ",".join(months), "DB=", opts["db"])

    # 生成数据前先把 D1 的现行规则同步下来（后台改规则后这里立刻生效）
    sync_rules_from_d1()

    os.makedirs(os.path.dirname(os.path.abspath(opts["db"])), exist_ok=True)
    work_dir = tempfile.mkdtemp(prefix="mxipos_ci_")
    results = []
    try:
        for month in months:
            zip_path, error = pull_month(sess, api, exporter, month, work_dir)
            if not zip_path:
                emit({"ok": False, "reason": error, "month": month})
                return 3
            zip_name = os.path.basename(zip_path)
            log("ZIP 已下载", zip_name, os.path.getsize(zip_path), "bytes")

            generated = os.path.join(work_dir, "%s_data.js" % month)
            ok, out, err = run(
                [PYTHON, "generate_data.py"],
                env={"COMMISSION_ORDER_FILE": zip_path, "COMMISSION_DATA_OUTPUT": generated},
            )
            if err.strip():
                log("generate_data 提示", err.strip()[:400])
            if not ok or not os.path.exists(generated):
                log("generate_data.py 失败", out[-400:], err[-400:])
                emit({"ok": False, "reason": "generate failed", "month": month})
                return 4
            log("中间 JSON 已生成", month)

            with open(zip_path, "rb") as handle:
                sha = hashlib.sha256(handle.read()).hexdigest()

            ok, out, err = run([
                "node", "scripts/ledger_cli.js", "import",
                "--db", opts["db"], "--data", generated,
                "--month", month, "--source", zip_name, "--sha", sha,
            ])
            if not ok:
                log("台账导入失败", out[-400:], err[-400:])
                emit({"ok": False, "reason": "ledger import failed", "month": month})
                return 4
            summary = out.strip()
            try:
                payload = json.loads(summary)
                summary = json.dumps(
                    {k: payload.get(k) for k in ("month", "rowCount", "commissionRows",
                                                 "totalCommission") if k in payload},
                    ensure_ascii=False)
            except Exception:  # noqa: BLE001
                summary = summary[:200]
            log("台账已提交", month, summary)
            # 同步写进 D1：新通道的看板与后台读的就是这份
            push_orders_to_d1(generated, month, zip_name, sha)
            results.append({"month": month, "source": zip_name, "sha256": sha, "ledger": summary})
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    out_path = os.path.abspath(opts["out"])
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp_out = out_path + ".tmp"
    ok, out, err = run([
        "node", "scripts/export_datajs.js", "--db", opts["db"],
        "--month", opts["month"], "--source", os.path.basename(results[-1]["source"]),
        "--out", tmp_out,
    ])
    if not ok:
        log("导出 data.js 失败", out[-400:], err[-400:])
        emit({"ok": False, "reason": "export_datajs failed"})
        return 4
    os.replace(tmp_out, out_path)
    log("data.js 已刷新", out_path, os.path.getsize(out_path), "bytes")

    emit({
        "ok": True,
        "months": [item["month"] for item in results],
        "db": opts["db"],
        "dataJs": out_path,
        "bytes": os.path.getsize(out_path),
        "detail": results,
    })
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        log("未捕获异常", repr(exc))
        emit({"ok": False, "reason": "exception", "detail": str(exc)})
        sys.exit(1)
