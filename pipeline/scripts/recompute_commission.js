#!/usr/bin/env node
// 一次性重算：按当前规则版本 + 整数公式 + 订单合并资格校验重算指定日期以来的订单提成。
// 默认干跑（只输出变更预览），加 --apply 才写入数据库。
// 用法：node scripts/recompute_commission.js [--db 路径] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--apply] [--allow-closed]
const os = require("node:os");
const path = require("node:path");
const { CommissionStore } = require("../lib/commission_db");
const { applyCommissionGroups, calculateCommission, number, roundMoney } = require("../lib/rules");

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return args;
}

const args = parseArgs(process.argv);
const dbPath = args.db || process.env.COMMISSION_DB_PATH || path.join(os.homedir(), ".local", "share", "commission_tool", "commission.sqlite3");
const from = String(args.from || "2026-07-01");
const to = args.to ? String(args.to) : "9999-12-31";
const apply = Boolean(args.apply);
const allowClosed = Boolean(args["allow-closed"] || args.allowClosed);

const store = new CommissionStore(dbPath);
try {
  const { ruleSetId, rules } = store.currentRules();
  const ruleById = new Map(rules.map((rule) => [String(rule.id), rule]));
  const rows = store.db.prepare("SELECT * FROM orders WHERE order_date BETWEEN ? AND ? ORDER BY checkout_time").all(from, to);
  const closedMonths = [...new Set(rows.map((row) => String(row.order_date).slice(0, 7)))].filter((month) => store.isMonthClosed(month));
  if (apply && closedMonths.length && !allowClosed) throw new Error(`以下月份已月结，禁止重算：${closedMonths.join("、")}；如已获确认，请加 --allow-closed`);

  // 第一步：逐行按当前规则重新匹配 + 整数公式
  const planned = rows.map((row) => {
    const calc = calculateCommission({
      productName: row.product_name,
      unit: row.unit,
      originalQuantity: row.original_quantity,
      quantity: row.quantity,
      amount: row.amount,
      status: row.status,
    }, rules);
    return { row, calc };
  });

  // 第二步：按订单聚合有提成商品，执行拼单整组核价。
  applyCommissionGroups(planned);

  // 第三步：逐行生成最终值并对比。
  const changes = [];
  let beforeTotal = 0;
  let afterTotal = 0;
  for (const item of planned) {
    const { row, calc } = item;
    const commissioned = row.status === "正常" && calc.commissionPerUnit > 0;
    const finalCommission = calc.commission;
    const finalMatchType = String(calc.matchType || "").replace(/；实收不足额，不计提$/, "");
    if (commissioned) {
      beforeTotal += number(row.commission);
      afterTotal += finalCommission;
    }
    const finalPriceStatus = calc.priceStatus;
    const finalCommissionStatus = calc.commissionStatus;
    const changed = String(row.rule_key || "") !== String(calc.ruleId || "")
      || String(row.rule_name || "") !== String(calc.ruleName || "")
      || number(row.commission_per_unit) !== number(calc.commissionPerUnit)
      || number(row.commission) !== number(finalCommission)
      || String(row.match_type || "") !== finalMatchType
      || number(row.expected_amount) !== number(calc.expectedAmount)
      || number(row.min_allowed_amount) !== number(calc.minAllowedAmount)
      || number(row.actual_amount) !== number(calc.actualAmount)
      || number(row.discount_amount) !== number(calc.discountAmount)
      || number(row.discount_rate) !== number(calc.discountRate)
      || String(row.price_status || "") !== finalPriceStatus
      || String(row.commission_status || "") !== finalCommissionStatus;
    if (changed) {
      changes.push({
        orderId: row.order_id,
        date: row.order_date,
        product: row.product_name,
        quantity: number(row.quantity),
        amount: number(row.amount),
        before: { rule: row.rule_name, perUnit: number(row.commission_per_unit), commission: number(row.commission), matchType: row.match_type, priceStatus: row.price_status, commissionStatus: row.commission_status },
        after: { rule: calc.ruleName, perUnit: calc.commissionPerUnit, commission: finalCommission, matchType: finalMatchType, priceStatus: finalPriceStatus, commissionStatus: finalCommissionStatus },
        calc: { expectedAmount: calc.expectedAmount, minAllowedAmount: calc.minAllowedAmount, actualAmount: calc.actualAmount, discountAmount: calc.discountAmount, discountRate: calc.discountRate, baseCommission: calc.baseCommission, adjustmentAmount: calc.adjustmentAmount, varianceAmount: calc.varianceAmount, varianceRate: calc.varianceRate },
        lineKey: row.line_key,
      });
    }
    item.final = {
      ruleSetId,
      ruleId: calc.ruleId,
      ruleName: calc.ruleName,
      commissionPerUnit: calc.commissionPerUnit,
      commission: finalCommission,
      matchType: finalMatchType,
      expectedAmount: calc.expectedAmount,
      minAllowedAmount: calc.minAllowedAmount,
      actualAmount: calc.actualAmount,
      discountAmount: calc.discountAmount,
      discountRate: calc.discountRate,
      priceStatus: finalPriceStatus,
      commissionStatus: finalCommissionStatus,
      auditStatus: calc.auditStatus,
      auditReason: calc.auditReason,
    };
  }

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    from,
    to,
    allowClosed,
    ruleSetId,
    rows: rows.length,
    changedLines: changes.length,
    ordersInScope: new Set(rows.map((row) => row.order_id).filter(Boolean)).size,
    beforeTotal: roundMoney(beforeTotal),
    afterTotal: roundMoney(afterTotal),
    difference: roundMoney(afterTotal - beforeTotal),
  }, null, 2));
  for (const change of changes) console.log(JSON.stringify(change));

  if (apply) {
    const update = store.db.prepare("UPDATE orders SET rule_set_id=?,rule_key=?,rule_name=?,commission_per_unit=?,commission=?,match_type=?,expected_amount=?,min_allowed_amount=?,actual_amount=?,discount_amount=?,discount_rate=?,price_status=?,commission_status=?,audit_status=?,audit_reason=? WHERE line_key=?");
    store.db.exec("BEGIN");
    try {
      for (const item of planned) {
        update.run(
          item.final.ruleSetId,
          item.final.ruleId,
          item.final.ruleName,
          item.final.commissionPerUnit,
          item.final.commission,
          item.final.matchType,
          item.final.expectedAmount,
          item.final.minAllowedAmount,
          item.final.actualAmount,
          item.final.discountAmount,
          item.final.discountRate,
          item.final.priceStatus,
          item.final.commissionStatus,
          item.final.auditStatus,
          item.final.auditReason,
          item.row.line_key,
        );
      }
      store.db.exec("COMMIT");
      console.log(`已写入 ${planned.length} 行`);
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  }
} finally {
  store.close();
}
