import csv
import io
import json
import os
import re
import zipfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import openpyxl


ROOT = Path(__file__).resolve().parent
CSV_ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "gbk")
CUSTOM_RULES_FILE = ROOT / "custom_rules.json"
RULE_SOURCE = "外烟提成.xlsx"
EXPLICIT_ORDER_FILE = os.environ.get("COMMISSION_ORDER_FILE", "").strip()
DATA_OUTPUT = os.environ.get("COMMISSION_DATA_OUTPUT", "").strip()


def latest_file(pattern):
    files = [path for path in ROOT.glob(pattern) if not path.name.startswith("~$")]
    return max(files, key=lambda path: path.stat().st_mtime) if files else None


def to_float(value, default=0.0):
    try:
        if value is None or value == "":
            return default
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return default


def decode_csv_bytes(raw):
    last_error = None
    for encoding in CSV_ENCODINGS:
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError as error:
            last_error = error
    raise last_error


def read_csv_rows_from_zip(keyword):
    explicit_path = Path(EXPLICIT_ORDER_FILE) if EXPLICIT_ORDER_FILE else None
    zip_path = explicit_path if explicit_path and explicit_path.suffix.lower() == ".zip" else latest_file("*.zip")
    if not zip_path:
        return None
    with zipfile.ZipFile(zip_path) as archive:
        for name in archive.namelist():
            if keyword in name and name.lower().endswith(".csv"):
                text = decode_csv_bytes(archive.read(name))
                return list(csv.reader(io.StringIO(text)))
    return None


def read_latest_order_total_rows():
    csv_path = Path(EXPLICIT_ORDER_FILE) if EXPLICIT_ORDER_FILE else latest_file("A 订单详情总表*.csv")
    if not csv_path or csv_path.suffix.lower() == ".zip":
        return None
    raw = csv_path.read_bytes()
    text = decode_csv_bytes(raw)
    return list(csv.reader(io.StringIO(text)))


def order_total_to_product_rows(rows):
    mapped = []
    current = {}
    carry_indexes = {
        "store": 0,
        "orderId": 1,
        "thirdOrderId": 2,
        "orderAmount": 4,
        "paidAmount": 7,
        "orderAmount": 7,
        "refund": 8,
        "cashier": 15,
        "orderStatus": 16,
        "remark": 20,
        "checkoutTime": 22,
    }

    for row in rows[4:]:
        if len(row) <= 56:
            continue
        for key, index in carry_indexes.items():
            if row[index]:
                current[key] = row[index]

        product_name = row[48].strip()
        if not product_name:
            continue

        quantity = to_float(row[53])
        unit_price = to_float(row[54])
        product_total = quantity * unit_price
        mapped.append(
            [
                current.get("store", row[0]),
                current.get("orderId", row[1]),
                current.get("thirdOrderId", row[2]),
                "",
                product_name,
                row[49],
                row[50],
                row[51],
                row[52],
                row[53],
                "",
                row[54],
                str(product_total),
                row[54],
                str(product_total),
                current.get("refund", row[8]),
                row[55] or current.get("orderStatus", ""),
                row[56] or current.get("cashier", ""),
                row[47],
                "",
            ]
        )

    return [
        [
            "消费门店名称",
            "订单号",
            "第三方订单号",
            "商品id",
            "商品名",
            "单位",
            "条形码",
            "属性",
            "加料",
            "数量",
            "标准定价",
            "原单单价",
            "原单总价",
            "实收单价",
            "实收总价",
            "退款金额",
            "商品状态",
            "商品下单人",
            "商品备注",
            "",
        ],
        *mapped,
    ]


def read_product_rows():
    total_rows = read_latest_order_total_rows()
    if total_rows:
        return order_total_to_product_rows(total_rows)

    rows = read_csv_rows_from_zip("商品详情")
    if rows is not None:
        normalized = [list(row) for row in rows]
        for row in normalized[4:]:
            if len(row) > 3:
                row[3] = ""
        return normalized
    return []


def read_order_detail_cashiers():
    """Read cashier values from the order-detail export by header name."""
    rows = read_csv_rows_from_zip("订单详情总表")
    if not rows or len(rows) < 4:
        return {}
    header = [str(value or "").strip() for value in rows[3]]
    try:
        order_index = header.index("订单号")
        cashier_index = header.index("收银员")
    except ValueError:
        return {}
    cashiers = {}
    for row in rows[4:]:
        if len(row) <= max(order_index, cashier_index):
            continue
        order_id = str(row[order_index] or "").strip()
        cashier = str(row[cashier_index] or "").strip()
        if order_id and cashier:
            cashiers[order_id] = cashier
    return cashiers


def read_base_rows():
    total_rows = read_latest_order_total_rows()
    if total_rows:
        base = {}
        current = {}
        for row in total_rows[4:]:
            if len(row) <= 56:
                continue
            if row[1]:
                current = {"checkoutTime": row[22], "cashier": row[15], "remark": row[20], "paymentNo": row[3], "orderAmount": row[7]}
                base[row[1]] = current
            elif current:
                base.setdefault(row[1], current)
        return base

    rows = read_csv_rows_from_zip("订单基础数据表")
    if rows is None:
        return {}

    base = {}
    for row in rows[4:]:
        if len(row) < 23:
            continue
        base[row[1]] = {
            "checkoutTime": row[16],
            "cashier": "",
            "remark": row[22],
            "paymentNo": row[3] if len(row) > 3 else "",
            "orderAmount": row[8] if len(row) > 8 else "",
        }
    return base


def normalize_rule_payload(rule, index):
    return {
        "id": rule.get("id") or f"R{index:03d}",
        "name": str(rule.get("name") or "").strip(),
        "packPrice": to_float(rule.get("packPrice")),
        "cartonPrice": to_float(rule.get("cartonPrice")),
        "commission": to_float(rule.get("commission")),
        "source": rule.get("source") or "后台维护",
    }


def read_custom_rules():
    if not CUSTOM_RULES_FILE.exists():
        return []
    try:
        payload = json.loads(CUSTOM_RULES_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    rows = payload if isinstance(payload, list) else payload.get("rules", [])
    if not isinstance(rows, list):
        return []
    rules = []
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            continue
        rule = normalize_rule_payload(row, index)
        if rule["name"]:
            rules.append(rule)
    return rules


def read_rules():
    global RULE_SOURCE
    custom_rules = read_custom_rules()
    if custom_rules:
        RULE_SOURCE = "后台维护规则"
        return custom_rules

    RULE_SOURCE = "外烟提成.xlsx"
    workbook_path = latest_file("*.xlsx")
    workbook = openpyxl.load_workbook(workbook_path, data_only=True)
    sheet = workbook.active
    rules = []
    for index, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=1):
        name = str(row[0]).strip() if row[0] else ""
        if not name:
            continue
        commission = to_float(row[3])
        rules.append(
            {
                "id": f"R{index:03d}",
                "name": name,
                "packPrice": to_float(row[1]),
                "cartonPrice": to_float(row[2]),
                "commission": commission,
                "source": "表格",
            }
        )
    return rules


def normalize_name(value):
    text = str(value or "").strip()
    for old, new in {
        "（": "(",
        "）": ")",
        " ": "",
        "外": "",
        "关税": "",
        "版": "",
        "花": "",
        "支": "",
        "(": "",
        ")": "",
        "/": "",
        "-": "",
    }.items():
        text = text.replace(old, new)
    return text


def series_prefix(rule_name):
    for suffix in ("全系列", "其它系列", "其他系列"):
        if rule_name.endswith(suffix):
            return rule_name[: -len(suffix)]
    return ""


def find_rule(rules, rule_name):
    for rule in rules:
        if rule["name"] == rule_name:
            return rule
    return None


# 占位商品名：收银员未录入具体商品时由系统生成的占位行，等同"无商品明细"。
# 简体与繁体都要覆盖（繁体来自个别收银端的快捷商品名配置）。
PLACEHOLDER_PRODUCT_NAMES = ("快速收银", "快速收銀")


def is_placeholder_product(value):
    return str(value or "").strip() in PLACEHOLDER_PRODUCT_NAMES


def match_rule(product_name, rules):
    product = str(product_name or "").strip()
    if not product or is_placeholder_product(product):
        return None, "未匹配"

    normalized_product = normalize_name(product)

    exact = [rule for rule in rules if rule["name"] == product]
    if exact:
        return exact[0], "精确匹配"

    # 注：不再对「七星蓝莓*」一律判无提成。
    # 规则表已包含「七星港版」与「七星蓝莓中支」，分别经别名匹配/精确匹配生效。

    if "中华" in product and "关税" not in product:
        return {
            "id": "NO_COMMISSION_CHUNGHWA",
            "name": product,
            "packPrice": 0,
            "cartonPrice": 0,
            "commission": 0,
        }, "无提成规则"

    if product == "牡丹红中支":
        return {
            "id": "NO_COMMISSION_001",
            "name": "牡丹红中支",
            "packPrice": 0,
            "cartonPrice": 0,
            "commission": 0,
        }, "无提成规则"

    if product.startswith("爱喜"):
        rule_name = "爱喜薄荷" if product == "爱喜薄荷" else "爱喜其它系列"
        rule = find_rule(rules, rule_name)
        if rule:
            return rule, "系列匹配"

    if product.startswith("百乐"):
        rule = find_rule(rules, "百乐全系列")
        if rule:
            return rule, "系列匹配"

    if product.lower().startswith("dash"):
        rule = find_rule(rules, "dash系列")
        if rule:
            return rule, "系列匹配"

    if product.startswith("冰爆"):
        rule = find_rule(rules, "冰爆系列") or find_rule(rules, "冰爆系统")
        if rule:
            return rule, "系列匹配"

    if "中华" in product and "双中支" in product:
        rule = find_rule(rules, "关税双中支中华") or find_rule(rules, "关税中华双中支")
        if rule:
            return rule, "别名匹配"

    contains = [
        rule
        for rule in rules
        if rule["name"] in product or product in rule["name"]
    ]
    if contains:
        return sorted(contains, key=lambda item: len(item["name"]), reverse=True)[0], "包含匹配"

    normalized = [
        rule
        for rule in rules
        if normalize_name(rule["name"]) == normalized_product
        or normalize_name(rule["name"]) in normalized_product
        or normalized_product in normalize_name(rule["name"])
    ]
    if normalized:
        return sorted(normalized, key=lambda item: len(normalize_name(item["name"])), reverse=True)[0], "名称归一"

    aliases = []
    if "寒冰" in product and "粗" in product:
        aliases.append("粗寒冰")
    if "寒冰" in product and "细" in product:
        aliases.append("细寒冰")
    if "七星" in product and "港" in product:
        aliases.append("七星港版")
    for alias in aliases:
        for rule in rules:
            if rule["name"] == alias:
                return rule, "别名匹配"

    series = []
    for rule in rules:
        prefix = series_prefix(rule["name"])
        if prefix and normalize_name(product).startswith(normalize_name(prefix)):
            series.append(rule)
    if series:
        return sorted(series, key=lambda item: len(series_prefix(item["name"])), reverse=True)[0], "系列匹配"

    return None, "未匹配"


def clean_person(value):
    value = str(value or "").strip()
    return value or "未记录收款人"


def has_chinese_name(value):
    """收银员是否绑定了中文姓名。

    纯手机号（如 19557933364）或纯工号说明账号未绑姓名，按业务要求直接剔除，
    不参与提成统计，避免以手机号冒充收银员出现在排行榜。
    """
    return any("\u4e00" <= ch <= "\u9fff" for ch in str(value or ""))


def commission_pack_quantity(product_name, unit, quantity):
    product_name = str(product_name or "").strip()
    unit = str(unit or "").strip()
    if "整条" in product_name or unit == "条":
        return quantity * 10, "按条计提：1条=10包"
    if unit == "包":
        return quantity, "按包计提"
    return quantity, "单位未注明包/条，默认按包计提"


def calculate_commission(rule, amount, pack_quantity, status):
    base_commission = to_float(rule.get("commission")) if rule else 0
    if status != "正常" or amount <= 0 or pack_quantity <= 0 or base_commission <= 0:
        return 0, 0 if amount <= 0 else base_commission
    rule_pack_price = to_float(rule.get("packPrice"))
    commission = pack_quantity * base_commission + (amount - pack_quantity * rule_pack_price) * 0.5
    return round(commission, 2), base_commission


def annotate_order_differences(orders):
    grouped = defaultdict(list)
    for item in orders:
        grouped[item.get("orderId") or item.get("lineKey")].append(item)

    for group in grouped.values():
        explicit_amounts = [to_float(item.get("orderAmount")) for item in group if to_float(item.get("orderAmount")) > 0]
        order_amount = round(explicit_amounts[0] if explicit_amounts else sum(to_float(item.get("amount")) for item in group), 2)
        commissioned = lambda item: item.get("status") == "正常" and to_float(item.get("commissionPerUnit")) > 0
        commission_sales_amount = round(sum(to_float(item.get("amount")) for item in group if commissioned(item)), 2)
        named_non_commission = [item for item in group if item.get("status") == "正常" and to_float(item.get("amount")) > 0 and not is_placeholder_product(item.get("productName")) and to_float(item.get("commissionPerUnit")) <= 0]
        non_commission_amount = round(sum(to_float(item.get("amount")) for item in named_non_commission), 2)
        order_difference = round(order_amount - commission_sales_amount, 2)
        order_adjusted_amount = round(order_amount - non_commission_amount, 2)
        order_unexplained_difference = round(order_adjusted_amount - commission_sales_amount, 2)
        names = list(dict.fromkeys(str(item.get("productName") or "").strip() for item in named_non_commission if str(item.get("productName") or "").strip()))
        note = ""
        if abs(order_difference) >= 0.01:
            if names:
                note = f"含非提成商品：{'、'.join(names)}，已扣除¥{non_commission_amount:.2f}"
                if abs(order_unexplained_difference) >= 0.01:
                    note += f"；扣除后仍差¥{order_unexplained_difference:.2f}，待核对"
            else:
                note = f"订单实收与提成商品销售额差额¥{order_difference:.2f}，待核对"
        for item in group:
            item.update({
                "orderAmount": order_amount,
                "commissionSalesAmount": commission_sales_amount,
                "nonCommissionAmount": non_commission_amount,
                "orderDifference": order_difference,
                "orderAdjustedAmount": order_adjusted_amount,
                "orderUnexplainedDifference": order_unexplained_difference,
                "orderDifferenceFlag": bool(note),
                "orderDifferenceNote": note,
            })
    return orders


def main():
    product_rows = read_product_rows()
    base_by_order = read_base_rows()
    cashier_by_order = read_order_detail_cashiers()
    rules = read_rules()

    orders = []
    for row in product_rows[4 if len(product_rows[0]) == 1 else 1 :]:
        if len(row) < 18:
            continue

        order_id = row[1]
        base = base_by_order.get(order_id, {})
        product_name = row[4].strip()
        unit = row[5].strip()
        qty = to_float(row[9])
        pack_qty, quantity_basis = commission_pack_quantity(product_name, unit, qty)
        unit_price = to_float(row[13] or row[11])
        amount = to_float(row[14] or row[12])
        refund = to_float(row[15])
        cashier = clean_person(cashier_by_order.get(order_id) or base.get("cashier") or row[17])
        checkout_time = base.get("checkoutTime") or ""
        payment_no = base.get("paymentNo") or ""
        rule, match_type = match_rule(product_name, rules)
        commission, commission_per_unit = calculate_commission(rule, amount, pack_qty, row[16])
        if rule and row[16] == "正常" and amount <= 0 and rule["commission"] > 0:
            match_type = "实收金额不大于0，不计提"

        orders.append(
            {
                "store": row[0],
                "orderId": order_id,
                "paymentNo": payment_no,
                "productId": row[3],
                "productName": product_name,
                "unit": unit,
                "originalQuantity": qty,
                "quantity": pack_qty,
                "quantityBasis": quantity_basis,
                "unitPrice": unit_price,
                "amount": amount,
                "orderAmount": to_float(base.get("orderAmount", amount)),
                "refund": refund,
                "status": row[16],
                "cashier": cashier,
                "cashierValid": has_chinese_name(cashier),
                "checkoutTime": checkout_time,
                "date": checkout_time[:10],
                "ruleName": rule["name"] if rule else "",
                "ruleId": rule["id"] if rule else "",
                "commissionPerUnit": commission_per_unit,
                "commission": round(commission, 2),
                "matchType": match_type,
            }
        )

    annotate_order_differences(orders)
    excluded_no_name = [
        item for item in orders
        if not item.get("cashierValid")
        and item["commissionPerUnit"] > 0
        and item["status"] == "正常"
    ]
    matched_orders = [
        item for item in orders
        if item["commissionPerUnit"] > 0
        and item["status"] == "正常"
        and item.get("cashierValid")
    ]
    summary_by_person = defaultdict(lambda: {"quantity": 0, "commission": 0, "sales": 0, "orders": set(), "items": 0})
    summary_by_product = defaultdict(lambda: {"quantity": 0, "commission": 0, "sales": 0, "orders": set()})
    daily = defaultdict(lambda: {"quantity": 0, "commission": 0})

    for item in matched_orders:
        person = summary_by_person[item["cashier"]]
        person["quantity"] += item["quantity"]
        person["commission"] += item["commission"]
        person["sales"] += item["amount"]
        person["orders"].add(item["orderId"])
        person["items"] += 1

        product = summary_by_product[item["ruleName"] or item["productName"]]
        product["quantity"] += item["quantity"]
        product["commission"] += item["commission"]
        product["sales"] += item["amount"]
        product["orders"].add(item["orderId"])

        if item["date"]:
            daily[item["date"]]["quantity"] += item["quantity"]
            daily[item["date"]]["commission"] += item["commission"]

    def pack_summary(mapping):
        packed = []
        for name, values in mapping.items():
            packed.append(
                {
                    "name": name,
                    "quantity": round(values["quantity"], 2),
                    "commission": round(values["commission"], 2),
                    "sales": round(values["sales"], 2),
                    "orderCount": len(values["orders"]),
                    "items": values.get("items", 0),
                }
            )
        return sorted(packed, key=lambda item: item["commission"], reverse=True)

    dates = sorted(item["date"] for item in orders if item["date"])
    source_order = Path(EXPLICIT_ORDER_FILE) if EXPLICIT_ORDER_FILE else (latest_file("A 订单详情总表*.csv") or latest_file("*.zip"))
    payload = {
        "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "period": f"{dates[0] if dates else '-'} 至 {dates[-1] if dates else '-'}",
        "source": {
            "orders": source_order.name if source_order else "",
            "rules": RULE_SOURCE,
        },
        "metrics": {
            "totalRows": len(orders),
            "commissionRows": len(matched_orders),
            "totalCommission": round(sum(item["commission"] for item in matched_orders), 2),
            "totalQuantity": round(sum(item["quantity"] for item in matched_orders), 2),
            "totalSales": round(sum(item["amount"] for item in matched_orders), 2),
            "people": len({item["cashier"] for item in matched_orders}),
            "unmatchedRows": len([item for item in orders if not is_placeholder_product(item["productName"]) and not item["ruleName"]]),
            "excludedNoNameRows": len(excluded_no_name),
            "excludedNoNameCommission": round(sum(item["commission"] for item in excluded_no_name), 2),
        },
        "rules": rules,
        "people": pack_summary(summary_by_person),
        "products": pack_summary(summary_by_product),
        "daily": [
            {"date": date, "quantity": round(values["quantity"], 2), "commission": round(values["commission"], 2)}
            for date, values in sorted(daily.items())
        ],
        "orders": orders,
    }

    output = Path(DATA_OUTPUT) if DATA_OUTPUT else ROOT / "data.js"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        "window.COMMISSION_DATA = "
        + json.dumps(payload, ensure_ascii=False, indent=2)
        + ";\n",
        encoding="utf-8",
    )
    print(json.dumps(payload["metrics"], ensure_ascii=False))


if __name__ == "__main__":
    main()
