#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通过纯 HTTP 完成掌中宝订单导出并下载 ZIP（替代浏览器自动化）。

流程（全部为后端 API，无需 puppeteer / CDP / 滑块验证）：
  1. POST /export/orderAsyncExport.action   创建异步导出任务 -> uuid
  2. POST /file/queryDownloadFileList.action 轮询下载中心，等任务"生成成功"
  3. GET  /file/downLoadAsyncFile.action     按 rowId 下载 ZIP
  4. 解压出「A 订单详情总表*.csv」（GB18030 编码）

用法：
  python mxipos_export_orders.py --session session.json \
      --start "2026-10-01 00:00:00" --end "2026-10-24 23:59:59" --out-dir D:/Temp/mxdl

下载成功后打印 CSV 绝对路径，可直接交给 generate_data.py：
  COMMISSION_ORDER_FILE=<csv> python generate_data.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mxipos_order_api as api  # noqa: E402

# 下载中心任务类型：订单导出落在 "03"（财务账单类）。
# 注意 "02" 是商品报表，用它过滤会查不到订单导出任务。
TASK_TYPE = "03"
STATUS_OK = "1"  # 生成成功


def create_export_task(sess, start, end, export_types="1,2,3,4,5"):
    params = api.session_params(sess)
    params.update({
        "payTmStartStr": start,
        "payTmEndStr": end,
        "searchType": "02",
        "exportTypeList": export_types,
    })
    shop = sess.get("singleShopId")
    if shop:
        params.setdefault("shopId", str(shop))
        params.setdefault("shopIds", str(shop))
    res = api.http_post_form("/export/orderAsyncExport.action", params)
    code = api.resp_code(res)
    if code != "000000":
        raise RuntimeError("创建导出任务失败: %s %s" % (code, api.resp_desc(res)))
    uuid = res.get("uuid") or (res.get("data") or {}).get("uuid") or ""
    return uuid, res


def query_download_list(sess, start_day, end_day, page=1, size=30):
    params = api.session_params(sess)
    params.update({
        "taskType": TASK_TYPE,
        "status": "",
        "taskName": "",
        # 后端按字符串比较 createTime，必须补时间部分，否则当天新建的任务会被过滤掉
        "beginDateStr": start_day + " 00:00:00",
        "endDateStr": end_day + " 23:59:59",
        "pageNum": str(page),
        "pageSize": str(size),
    })
    res = api.http_post_form("/file/queryDownloadFileList.action", params)
    code = api.resp_code(res)
    if code != "000000":
        raise RuntimeError("查询下载列表失败: %s %s" % (code, api.resp_desc(res)))
    rows = res.get("data") or []
    if isinstance(rows, dict):
        rows = rows.get("records") or rows.get("list") or []
    return rows, res.get("totalCount")


def pick_row(rows, uuid=""):
    """优先按 uuid 精确匹配 taskName；否则取 createTime 最新的一条。"""
    if not rows:
        return None
    if uuid:
        for r in rows:
            if uuid in (r.get("taskName") or "") or uuid in (r.get("fileName") or ""):
                return r
    return max(rows, key=lambda r: (r.get("createTime") or "", int(r.get("rowId") or 0)))


def download_zip(sess, row_id, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    params = api.session_params(sess)
    params.update({
        "rowId": str(row_id),
        "blank": "true",
        "removeSingle": "true",
    })
    status, body, ctype = api.http_get_bytes("/file/downLoadAsyncFile.action", params)
    if status != 200 or not body:
        raise RuntimeError("下载失败 status=%s type=%s head=%r" % (
            status, ctype, body[:200]))
    if body[:2] != b"PK":
        # 非 ZIP，多半是 JSON 错误
        snippet = body[:400].decode("utf-8", "replace")
        raise RuntimeError("返回内容不是 ZIP: %s" % snippet)
    path = os.path.join(out_dir, "orders_%s.zip" % time.strftime("%Y%m%d_%H%M%S"))
    with open(path, "wb") as fh:
        fh.write(body)
    return path


def extract_csv(zip_path, out_dir):
    """解压全部 CSV。注意 generate_data.py 真正使用的是 ZIP 内的
    「商品详情」（商品级明细）与「订单基础数据表」（收银员/结账时间），
    订单详情总表仅作核对用。"""
    with zipfile.ZipFile(zip_path) as zf:
        targets = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        if not targets:
            raise RuntimeError("ZIP 内没有 CSV")
        out = []
        for n in targets:
            dest = os.path.join(out_dir, os.path.basename(n))
            with zf.open(n) as src, open(dest, "wb") as dst:
                dst.write(src.read())
            out.append(dest)
        return out


def main():
    ap = argparse.ArgumentParser(description="纯 HTTP 导出掌中宝订单")
    ap.add_argument("--session", required=True)
    ap.add_argument("--start", required=True, help='"2026-10-01 00:00:00"')
    ap.add_argument("--end", required=True, help='"2026-10-24 23:59:59"')
    ap.add_argument("--out-dir", default="D:/Temp/mxdl")
    ap.add_argument("--wait", type=int, default=300, help="等待任务完成的秒数")
    ap.add_argument("--reuse", action="store_true",
                    help="不新建任务，直接用下载中心里最新的已完成任务")
    ap.add_argument("--uuid", default="",
                    help="直接指定已有导出任务的 uuid")
    args = ap.parse_args()

    sess = api.load_session(args.session)
    start_day = args.start[:10]
    end_day = args.end[:10]

    uuid = args.uuid
    if not args.reuse and not uuid:
        print("[1/4] 创建导出任务 %s ~ %s ..." % (start_day, end_day))
        uuid, raw = create_export_task(sess, args.start, args.end)
        print("      uuid=%s" % (uuid or "(未返回)"))
        if not uuid:
            print("      原始返回: %s" % json.dumps(raw, ensure_ascii=False)[:300])
    else:
        print("[1/4] 跳过创建，复用已有任务%s" % (" uuid=" + uuid if uuid else ""))

    print("[2/4] 轮询下载中心 ...")
    row = None
    deadline = time.time() + args.wait
    last_desc = ""
    while time.time() < deadline:
        rows, total = query_download_list(sess, start_day, end_day)
        row = pick_row(rows, uuid)
        if row:
            st = str(row.get("status"))
            desc = "rowId=%s status=%s taskCount=%s/%s fileStatus=%s" % (
                row.get("rowId"), st,
                row.get("taskCount"), row.get("failCount"), row.get("fileStatus"))
            if desc != last_desc:
                print("      %s" % desc)
                last_desc = desc
            if st == STATUS_OK:
                break
            if st == "2":
                raise RuntimeError("任务生成失败: %s" % json.dumps(row, ensure_ascii=False)[:300])
        else:
            print("      下载中心暂无该任务，等待 ...")
        time.sleep(5)
    else:
        raise RuntimeError("等待超时（%ss），最后状态: %s" % (args.wait, last_desc))

    print("[3/4] 下载 ZIP (rowId=%s) ..." % row.get("rowId"))
    zip_path = download_zip(sess, row["rowId"], args.out_dir)
    print("      %s (%.1f KB)" % (zip_path, os.path.getsize(zip_path) / 1024))

    print("[4/4] 解压 ...")
    csvs = extract_csv(zip_path, args.out_dir)
    for c in csvs:
        print("      %s (%.1f KB)" % (c, os.path.getsize(c) / 1024))

    print("\n" + "=" * 60)
    print("ZIP（推荐直接交给 generate_data.py）:")
    print("  " + os.path.abspath(zip_path).replace("\\", "/"))
    print("  用法: COMMISSION_ORDER_ZIP=<上面路径> python generate_data.py")
    print("=" * 60)
    print("解压出的 CSV:")
    for c in csvs:
        print("  " + os.path.abspath(c).replace("\\", "/"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
