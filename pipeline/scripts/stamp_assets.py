#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布前刷新静态资源版本号。

为什么需要：
  自定义域 auto.aininja365.xyz 处于 aininja365.xyz zone，该 zone 的
  Browser Cache TTL 会把静态资源统一改写为 max-age=14400（4 小时），
  覆盖 Pages 的 _headers。旧通道同样如此（app.js 也是 14400），说明这是既有配置，
  按护栏 6 不能为迁移去改 zone 级设置。

  因此改用文档许可的 ?v= 版本号方案：HTML 本身是 no-store，
  每次发布给它引用的资源换一个唯一查询串，天然绕过 4 小时边缘缓存。
  这也是旧项目既有习惯（?v=20261029-fixdupe-1）。

用法：
  python3 pipeline/scripts/stamp_assets.py [--dir public] [--stamp 20261031120000]
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime

# 只处理这些页面里出现的资源引用
PAGES = ("index.html", "orders.html")
ASSETS = ("data.js", "app.js", "manual.js", "styles.css", "leaderboard.js", "leaderboard.css")


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", default="public")
    parser.add_argument("--stamp", default="")
    options = parser.parse_args(argv)

    stamp = options.stamp or datetime.now().strftime("%Y%m%d%H%M%S")
    changed = []

    for page in PAGES:
        path = os.path.join(options.dir, page)
        if not os.path.exists(path):
            print("跳过不存在的页面 %s" % path)
            continue
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        before = text
        for asset in ASSETS:
            # 只替换 "asset?v=..." 形式，未带版本号的不动（避免误伤其它路径）
            text = re.sub(
                re.escape(asset) + r"\?v=[^\"'&>\s]*",
                "%s?v=%s" % (asset, stamp),
                text,
            )
        if text != before:
            with open(path, "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
            changed.append(page)

    print("版本号 stamp=%s | 已更新: %s" % (stamp, ", ".join(changed) if changed else "(无变化)"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
