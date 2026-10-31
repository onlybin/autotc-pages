#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""KV 门禁：决定本次 workflow 是否真的要拉单。

背景（决策 4-A）：
  手机上报 → Pages Function 写 Cloudflare KV；Pages 不能 spawn 子进程，
  所以由 Actions 侧决定何时拉单。若每 15 分钟都全量拉一次，一天 96 次，
  对商户网关是滥用；因此只在「会话 timestamp 发生变化」时才真跑，
  另由 6 小时一次的强制 cron 兜底。

判定：
  run = force OR (KV.timestamp != KV.session_processed)

输出（写 $GITHUB_OUTPUT，同时打印到 stdout 便于排查）：
  run=true|false
  reason=<说明>
  timestamp=<会话毫秒时间戳>
  age_hours=<会话年龄，用于识别 token 是否已超过 24h47m 上限>
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{ns}/values/{key}"


def kv_get(token, account, namespace, key):
    url = API.format(account=account, ns=namespace, key=key)
    request = urllib.request.Request(url, headers={"Authorization": "Bearer %s" % token})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode("utf-8"), None
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None, "missing"
        return None, "http %s" % error.code
    except Exception as error:  # noqa: BLE001
        return None, str(error)


def kv_put(token, account, namespace, key, value):
    url = API.format(account=account, ns=namespace, key=key)
    request = urllib.request.Request(
        url, data=value.encode("utf-8"), method="PUT",
        headers={"Authorization": "Bearer %s" % token, "Content-Type": "text/plain"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.status


def emit_output(pairs):
    for key, value in pairs.items():
        print("%s=%s" % (key, value))
    target = os.environ.get("GITHUB_OUTPUT")
    if target:
        with open(target, "a", encoding="utf-8") as handle:
            for key, value in pairs.items():
                handle.write("%s=%s\n" % (key, value))


def main():
    mode = os.environ.get("MODE", "gate")
    token = os.environ.get("CF_API_TOKEN", "").strip()
    account = os.environ.get("CF_ACCOUNT_ID", "").strip()
    namespace = os.environ.get("CF_KV_NAMESPACE_ID", "").strip()

    if not (token and account and namespace):
        print("缺少 CF_API_TOKEN / CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID")
        return 1

    if mode == "mark":
        # 拉单成功后把本次会话标记为已处理
        timestamp = os.environ.get("SESSION_TIMESTAMP", "").strip()
        if not timestamp:
            print("SESSION_TIMESTAMP 为空，跳过标记")
            return 0
        status = kv_put(token, account, namespace, "session_processed", timestamp)
        print("已标记 session_processed=%s (http %s)" % (timestamp, status))
        return 0

    if mode == "session":
        # 只在真的执行时才把会话落到 runner 本地（避免 token 进入 Actions 缓存）
        raw, error = kv_get(token, account, namespace, "mxipos_session")
        if not raw:
            print("KV 无会话：%s" % error)
            return 2
        target = os.environ["SESSION_OUT"]
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(raw if raw.endswith("\n") else raw + "\n")
        os.chmod(target, 0o600)
        payload = json.loads(raw)
        print("已写入会话 loginId=%s updatedAt=%s" % (payload.get("loginId"), payload.get("updatedAt")))
        emit_output({"timestamp": str(payload.get("timestamp") or "")})
        return 0

    # mode == gate
    force = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
    raw, error = kv_get(token, account, namespace, "mxipos_session")
    if not raw:
        emit_output({"run": "false", "reason": "KV 中还没有会话（手机尚未上报）：%s" % error,
                     "timestamp": "", "age_hours": ""})
        return 0

    try:
        session = json.loads(raw)
    except json.JSONDecodeError:
        emit_output({"run": "false", "reason": "KV 会话不是合法 JSON", "timestamp": "", "age_hours": ""})
        return 0

    timestamp = str(session.get("timestamp") or "")
    try:
        age_hours = round((time.time() * 1000 - int(timestamp)) / 3600000, 1)
    except (TypeError, ValueError):
        age_hours = ""

    processed, _ = kv_get(token, account, namespace, "session_processed")
    processed = (processed or "").strip()

    changed = bool(timestamp) and timestamp != processed
    run = force or changed
    if force:
        reason = "强制触发（cron 兜底 / 手动 dispatch）"
    elif changed:
        reason = "检测到新会话 timestamp=%s（上次已处理=%s）" % (timestamp, processed or "无")
    else:
        reason = "会话未变化 timestamp=%s，跳过" % timestamp

    if run and age_hours != "" and float(age_hours) >= 24.0:
        reason += (
            "；提示：会话距今 %sh，已超过文档记录的 24h47m 上限，本次可能因 token 过期失败"
            "（实测存在 28h 仍拉单成功的先例，该上限可能是按最近一次成功调用滑动计算，仅供参考）"
            % age_hours
        )

    emit_output({
        "run": "true" if run else "false",
        "reason": reason,
        "timestamp": timestamp,
        "age_hours": str(age_hours),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
