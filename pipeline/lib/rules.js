const crypto = require("node:crypto");

function number(value, fallback = 0) {
  const parsed = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round(number(value) * 100) / 100;
}

function normalizeRule(rule, index = 0) {
  const packPrice = number(rule.packPrice);
  const cartonPrice = number(rule.cartonPrice);
  return {
    id: String(rule.id || `R${String(index + 1).padStart(3, "0")}`),
    name: String(rule.name || "").trim(),
    packPrice,
    cartonPrice,
    minPackPrice: number(rule.minPackPrice, packPrice) || packPrice,
    minCartonPrice: number(rule.minCartonPrice, cartonPrice) || cartonPrice,
    commission: number(rule.commission),
    unitMode: String(rule.unitMode || rule.unit_mode || "").trim(),
    source: String(rule.source || "后台维护"),
  };
}

function normalizeRules(rules) {
  return (Array.isArray(rules) ? rules : []).map(normalizeRule).filter((rule) => rule.name);
}

function normalizeName(value) {
  let text = String(value || "").trim();
  for (const [oldText, newText] of Object.entries({
    "（": "(", "）": ")", " ": "", "外": "", "关税": "", "版": "", "花": "", "支": "", "(": "", ")": "", "/": "", "-": "",
  })) text = text.replaceAll(oldText, newText);
  return text;
}

function findRule(rules, name) {
  return rules.find((rule) => rule.name === name) || null;
}

function seriesPrefix(name) {
  for (const suffix of ["全系列", "其它系列", "其他系列"]) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return "";
}

// 占位商品名：收银员未录入具体商品时的占位行，简繁体都要覆盖。
const PLACEHOLDER_PRODUCT_NAMES = ["快速收银", "快速收銀"];

function isPlaceholderProduct(value) {
  return PLACEHOLDER_PRODUCT_NAMES.includes(String(value || "").trim());
}

function noCommission(id, name) {
  return { id, name, packPrice: 0, cartonPrice: 0, commission: 0, source: "系统排除" };
}

function matchRule(productName, inputRules) {
  const rules = normalizeRules(inputRules);
  const product = String(productName || "").trim();
  if (!product || isPlaceholderProduct(product)) return { rule: null, matchType: "未匹配" };
  const exact = findRule(rules, product);
  if (exact) return { rule: exact, matchType: "精确匹配" };
  if (product.startsWith("七星蓝莓")) {
    const alias = findRule(rules, "七星港版");
    if (alias) return { rule: alias, matchType: "别名匹配" };
  }
  if (product.includes("中华") && !product.includes("关税")) return { rule: noCommission("NO_COMMISSION_CHUNGHWA", product), matchType: "无提成规则" };
  if (product === "牡丹红中支") return { rule: noCommission("NO_COMMISSION_001", product), matchType: "无提成规则" };
  const named = product.startsWith("爱喜") ? findRule(rules, product === "爱喜爆珠" || product === "爱喜薄荷" ? "爱喜爆珠" : "爱喜其它系列")
    : product.startsWith("百乐") ? findRule(rules, "百乐全系列")
      : product.startsWith("卡比龙") ? findRule(rules, "卡比龙全系列")
      : product.toLowerCase().startsWith("dash") ? findRule(rules, "dash系列")
        : product.startsWith("冰爆") ? (findRule(rules, "冰爆系列") || findRule(rules, "冰爆系统")) : null;
  if (named) return { rule: named, matchType: "系列匹配" };
  if (product.includes("中华") && product.includes("双中支")) {
    const alias = findRule(rules, "关税双中支中华") || findRule(rules, "关税中华双中支");
    if (alias) return { rule: alias, matchType: "别名匹配" };
  }
  const contains = rules.filter((rule) => product.includes(rule.name) || rule.name.includes(product)).sort((a, b) => b.name.length - a.name.length);
  if (contains.length) return { rule: contains[0], matchType: "包含匹配" };
  const normalizedProduct = normalizeName(product);
  const normalized = rules.filter((rule) => {
    const name = normalizeName(rule.name);
    return name === normalizedProduct || name.includes(normalizedProduct) || normalizedProduct.includes(name);
  }).sort((a, b) => normalizeName(b.name).length - normalizeName(a.name).length);
  if (normalized.length) return { rule: normalized[0], matchType: "名称归一" };
  const aliases = [];
  if (product.includes("寒冰") && product.includes("粗")) aliases.push("粗寒冰");
  if (product.includes("寒冰") && product.includes("细")) aliases.push("细寒冰");
  if (product.includes("七星") && product.includes("港")) aliases.push("七星港版");
  for (const alias of aliases) {
    const rule = findRule(rules, alias);
    if (rule) return { rule, matchType: "别名匹配" };
  }
  const series = rules.filter((rule) => {
    const prefix = seriesPrefix(rule.name);
    return prefix && normalizedProduct.startsWith(normalizeName(prefix));
  }).sort((a, b) => seriesPrefix(b.name).length - seriesPrefix(a.name).length);
  return series.length ? { rule: series[0], matchType: "系列匹配" } : { rule: null, matchType: "未匹配" };
}

function calculateCommission(order, rules) {
  const { rule, matchType } = matchRule(order.productName, rules);
  return calculateCommissionForRule(order, rule, matchType);
}

function quantityBreakdown(order, rule = null) {
  const quantity = number(order.quantity);
  const originalQuantity = number(order.originalQuantity || order.original_quantity);
  const unit = String(order.unit || "").trim();
  const ruleName = String(rule?.name || "").trim();
  const unitMode = String(rule?.unitMode || "").trim().toLowerCase();
  if (unitMode === "can" || unit.includes("罐") || ruleName.includes("罐装南洋")) {
    return { cartons: 0, loosePacks: quantity, packs: quantity };
  }
  if (unit.includes("条")) {
    const cartons = originalQuantity > 0 ? originalQuantity : quantity / 10;
    return { cartons, loosePacks: 0, packs: roundMoney(cartons * 10) };
  }
  const cartons = Math.floor(quantity / 10);
  const loosePacks = roundMoney(quantity - cartons * 10);
  return { cartons, loosePacks, packs: quantity };
}

function calculateExpectedAmount(order, rule) {
  const { cartons, loosePacks } = quantityBreakdown(order, rule);
  const packPrice = number(rule?.packPrice);
  const cartonPrice = number(rule?.cartonPrice) || packPrice * 10;
  return roundMoney(cartons * cartonPrice + loosePacks * packPrice);
}

function calculateMinAllowedAmount(order, rule) {
  const expected = calculateExpectedAmount(order, rule);
  return roundMoney(expected * 0.95);
}

function calculateAdjustment(amount, expectedAmount) {
  const expected = number(expectedAmount);
  if (expected <= 0) return { adjustmentAmount: 0, priceStatus: "NO_COMMISSION", diffAmount: 0, diffRate: 0 };
  const diffAmount = roundMoney(number(amount) - expected);
  const diffRate = roundMoney((diffAmount / expected) * 100);
  if (diffRate < -5) {
    return { adjustmentAmount: roundMoney(diffAmount * 0.5), priceStatus: "UNDER_RECEIVED_PENALTY", diffAmount, diffRate };
  }
  if (diffRate > 5) {
    return { adjustmentAmount: roundMoney(diffAmount * 0.5), priceStatus: "OVER_RECEIVED_BONUS", diffAmount, diffRate };
  }
  return { adjustmentAmount: 0, priceStatus: Math.abs(diffRate) > 0 ? "WITHIN_5_PERCENT" : "NORMAL", diffAmount, diffRate };
}

function calculateLegacyMinAllowedAmount(order, rule) {
  const { cartons, loosePacks } = quantityBreakdown(order, rule);
  const packPrice = number(rule?.packPrice);
  const minCartonPrice = number(rule?.minCartonPrice) || number(rule?.cartonPrice) || number(rule?.packPrice) * 10;
  const minPackPrice = number(rule?.minPackPrice) || number(rule?.packPrice);
  return roundMoney(cartons * minCartonPrice + loosePacks * minPackPrice);
}

function calculateCommissionForRule(order, rule, matchType = "未匹配") {
  const baseCommission = number(rule?.commission);
  const { packs } = quantityBreakdown(order, rule);
  const quantity = number(packs);
  const amount = number(order.amount);
  const expectedAmount = rule ? calculateExpectedAmount(order, rule) : 0;
  const minAllowedAmount = rule ? calculateMinAllowedAmount(order, rule) : 0;
  const discountAmount = roundMoney(expectedAmount - amount);
  const discountRate = expectedAmount > 0 ? roundMoney((amount / expectedAmount) * 100) : 0;
  const zeroAmount = amount <= 0;
  const active = order.status === "正常" && rule && baseCommission > 0 && quantity > 0 && !zeroAmount;
  const baseTotalCommission = active ? roundMoney(quantity * baseCommission) : 0;
  const adjustment = active ? calculateAdjustment(amount, expectedAmount) : { adjustmentAmount: 0, priceStatus: zeroAmount && rule ? "INVALID_ZERO_AMOUNT" : "NO_COMMISSION", diffAmount: 0, diffRate: 0 };
  const commissionPerUnit = active ? baseCommission : 0;
  const commission = active ? roundMoney(baseTotalCommission + adjustment.adjustmentAmount) : 0;
  const priceStatus = active ? adjustment.priceStatus : adjustment.priceStatus;
  const commissionStatus = active ? adjustment.priceStatus : adjustment.priceStatus;
  const auditStatus = active && (priceStatus === "UNDER_RECEIVED_PENALTY" || priceStatus === "OVER_RECEIVED_BONUS") ? "price_variance" : "";
  const auditReason = auditStatus ? "实收款与规则定价偏差超过5%" : "";
  return {
    ruleId: rule?.id || "",
    ruleName: rule?.name || "",
    packPrice: number(rule?.packPrice),
    commissionPerUnit,
    commission,
    baseCommission: baseTotalCommission,
    adjustmentAmount: adjustment.adjustmentAmount,
    matchType,
    expectedAmount,
    minAllowedAmount,
    actualAmount: roundMoney(amount),
    discountAmount,
    discountRate,
    varianceAmount: adjustment.diffAmount,
    varianceRate: adjustment.diffRate,
    priceStatus,
    commissionStatus,
    auditStatus,
    auditReason,
  };
}

// 每 10 包允许少收金额（按单包价分档）：
// ≤15 元（含）→ 0；15–25 元（含 25）→ 10 元；25 元以上 → 单包价/2；35–38 元特殊档 → 30 元
function packTolerance(packPrice) {
  const price = number(packPrice);
  if (price >= 35 && price <= 38) return 30;
  if (price > 25) return price / 2;
  if (price > 15) return 10;
  return 0;
}

// 同订单提成商品拼单资格校验：
// 只传入已匹配提成规则的商品行。总包数超过 10 包时，按数量最多的商品单包价
// 估算整组价格，并允许整组实收低至估算价的 95%。
function evaluateCommissionGroup(lines) {
  const validLines = (Array.isArray(lines) ? lines : []).filter((line) => number(line.packs) > 0 && number(line.packPrice) > 0);
  const totalPacks = validLines.reduce((sum, line) => sum + number(line.packs), 0);
  const referenceLine = validLines
    .slice()
    .sort((a, b) => number(b.packs) - number(a.packs) || number(a.packPrice) - number(b.packPrice))[0] || null;
  const referencePackPrice = referenceLine ? roundMoney(referenceLine.packPrice) : 0;
  const expected = roundMoney(totalPacks * referencePackPrice);
  const actual = roundMoney(validLines.reduce((sum, line) => sum + number(line.amount), 0));
  const minAmount = roundMoney(expected * 0.95);
  return {
    eligible: totalPacks > 10 && validLines.length > 0 && actual >= minAmount,
    totalPacks: roundMoney(totalPacks),
    referencePackPrice,
    referenceProductName: referenceLine?.productName || "",
    expectedAmount: expected,
    actualAmount: actual,
    tolerance: roundMoney(expected - minAmount),
    minAmount,
  };
}

function applyCommissionGroups(items) {
  const groups = new Map();
  for (const item of items || []) {
    const row = item.row || item;
    const calc = item.calc || item;
    const orderId = String(row.orderId ?? row.order_id ?? "").trim();
    if (!orderId || row.status !== "正常" || number(calc.commissionPerUnit) <= 0) continue;
    const packs = String(row.unit || "").includes("条")
      ? number(row.originalQuantity || row.original_quantity || row.quantity) * 10
      : number(row.quantity);
    const group = groups.get(orderId) || [];
    group.push({ item, packs, packPrice: number(calc.packPrice) > 0 ? number(calc.packPrice) : number(row.unitPrice || row.unit_price), amount: number(row.amount), productName: row.productName || row.product_name || "" });
    groups.set(orderId, group);
  }
  for (const lines of groups.values()) {
    const result = evaluateCommissionGroup(lines);
    if (!result.eligible) continue;
    for (const line of lines) {
      const calc = line.item.calc || line.item;
      calc.commission = roundMoney(calc.baseCommission);
      calc.adjustmentAmount = 0;
      calc.expectedGroupAmount = result.expectedAmount;
      calc.minGroupAmount = result.minAmount;
      calc.actualGroupAmount = result.actualAmount;
      calc.groupReferencePackPrice = result.referencePackPrice;
      calc.groupReferenceProductName = result.referenceProductName;
      calc.priceStatus = "GROUP_WITHIN_5_PERCENT";
      calc.commissionStatus = "GROUP_WITHIN_5_PERCENT";
      calc.auditStatus = "";
      calc.auditReason = "拼单提成商品合计超过10包，按数量最多商品单包价估算，整组实收在95%范围内";
    }
  }
  return items;
}

function stableOrderKeys(orders) {
  const counts = new Map();
  return orders.map((order) => {
    if (order.lineKey) return { ...order, lineKey: String(order.lineKey) };
    const signature = [order.orderId, order.productId, order.productName, order.unit].join("|");
    const occurrence = (counts.get(signature) || 0) + 1;
    counts.set(signature, occurrence);
    return { ...order, lineKey: crypto.createHash("sha256").update(`${signature}|${occurrence}`).digest("hex") };
  });
}

module.exports = { applyCommissionGroups, calculateCommission, isPlaceholderProduct, calculateCommissionForRule, calculateExpectedAmount, calculateMinAllowedAmount, evaluateCommissionGroup, matchRule, normalizeRule, normalizeRules, number, packTolerance, roundMoney, stableOrderKeys };
