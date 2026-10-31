// 占位商品名：收银员未录入具体商品时的占位行，简繁体都要覆盖。
const PLACEHOLDER_PRODUCT_NAMES = ["快速收银", "快速收銀"];

function isPlaceholderProduct(value) {
  return PLACEHOLDER_PRODUCT_NAMES.includes(String(value || "").trim());
}

const MANUAL_STORAGE_KEY = "commission_manual_orders_v1";
const LEGACY_RULE_STORAGE_KEY = "commission_rules_v1";

function readManualEntries() {
  try {
    const saved = JSON.parse(localStorage.getItem(MANUAL_STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveManualEntries(entries) {
  localStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify(entries));
}

function readLegacyLocalRules() {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_RULE_STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.map(normalizeCommissionRule).filter((rule) => rule.name) : [];
  } catch {
    return [];
  }
}

function clearLegacyLocalRules() {
  localStorage.removeItem(LEGACY_RULE_STORAGE_KEY);
}

function baseCommissionRules() {
  return (window.COMMISSION_DATA?.rules || []).map(normalizeCommissionRule).filter((rule) => rule.name);
}

function normalizeCommissionRule(rule, index = 0) {
  return {
    id: rule.id || `R${String(index + 1).padStart(3, "0")}`,
    name: String(rule.name || "").trim(),
    packPrice: toManualNumber(rule.packPrice),
    cartonPrice: toManualNumber(rule.cartonPrice),
    commission: toManualNumber(rule.commission),
    source: rule.source || "数据文件",
  };
}

function stripNote(value) {
  return String(value || "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/【[^】]*】/g, "")
    .trim();
}

function normalizeManualDate(value) {
  const raw = stripNote(value).replace(/[年月]/g, ".").replace(/日/g, "");
  const parts = raw.split(/[.\-/]/).filter(Boolean);
  if (parts.length < 3) return "";
  const [year, month, day] = parts;
  return `${year.padStart(4, "20")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function toManualNumber(value) {
  const parsed = Number(stripNote(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRuleName(value) {
  let text = String(value || "").trim();
  const replacements = {
    "（": "(",
    "）": ")",
    " ": "",
    "大": "",
    "关税": "",
    "特": "",
    "芙": "",
    "支": "",
    "(": "",
    ")": "",
    "/": "",
    "-": "",
  };
  Object.entries(replacements).forEach(([oldValue, newValue]) => {
    text = text.replaceAll(oldValue, newValue);
  });
  return text;
}

function seriesPrefix(ruleName) {
  for (const suffix of ["全系列", "其它系列", "其他系列"]) {
    if (ruleName.endsWith(suffix)) return ruleName.slice(0, -suffix.length);
  }
  return "";
}

function findCommissionRule(rules, name) {
  return rules.find((rule) => rule.name === name) || null;
}

function zeroRule(productName, reason = "无提成规则") {
  return {
    rule: { id: `NO_${productName}`, name: productName, commission: 0, packPrice: 0, cartonPrice: 0 },
    matchType: reason,
  };
}

function matchCommissionRule(productName, rules) {
  const product = String(productName || "").trim();
  if (!product || isPlaceholderProduct(product)) return { rule: null, matchType: "未匹配" };

  const exact = findCommissionRule(rules, product);
  if (exact) return { rule: exact, matchType: "精确匹配" };

  if (product.startsWith("七星蓝莓")) return zeroRule(product);
  if (product.includes("中华") && !product.includes("关税")) return zeroRule(product);
  if (product === "牡丹红中支") return zeroRule(product);

  if (product.startsWith("爱喜")) {
    const rule = findCommissionRule(rules, product === "爱喜薄荷" ? "爱喜薄荷" : "爱喜其它系列");
    if (rule) return { rule, matchType: "系列匹配" };
  }

  if (product.startsWith("百乐")) {
    const rule = findCommissionRule(rules, "百乐全系列");
    if (rule) return { rule, matchType: "系列匹配" };
  }

  if (product.toLowerCase().startsWith("dash")) {
    const rule = findCommissionRule(rules, "dash系列");
    if (rule) return { rule, matchType: "系列匹配" };
  }

  if (product.startsWith("冰爆")) {
    const rule = findCommissionRule(rules, "冰爆系列") || findCommissionRule(rules, "冰爆系统");
    if (rule) return { rule, matchType: "系列匹配" };
  }

  if (product.includes("中华") && product.includes("双中支")) {
    const rule = findCommissionRule(rules, "关税双中支中华") || findCommissionRule(rules, "关税中华双中支");
    if (rule) return { rule, matchType: "别名匹配" };
  }

  const contains = rules
    .filter((rule) => rule.name && (product.includes(rule.name) || rule.name.includes(product)))
    .sort((a, b) => b.name.length - a.name.length);
  if (contains[0]) return { rule: contains[0], matchType: "包含匹配" };

  const normalizedProduct = normalizeRuleName(product);
  const normalized = rules
    .filter((rule) => {
      const normalizedRule = normalizeRuleName(rule.name);
      return normalizedRule === normalizedProduct || normalizedProduct.includes(normalizedRule) || normalizedRule.includes(normalizedProduct);
    })
    .sort((a, b) => normalizeRuleName(b.name).length - normalizeRuleName(a.name).length);
  if (normalized[0]) return { rule: normalized[0], matchType: "名称归一" };

  const aliases = [];
  if (product.includes("寒冰") && product.includes("粗")) aliases.push("粗寒冰");
  if (product.includes("寒冰") && product.includes("细")) aliases.push("细寒冰");
  if (product.includes("七星") && product.includes("港")) aliases.push("七星港版");
  for (const alias of aliases) {
    const rule = findCommissionRule(rules, alias);
    if (rule) return { rule, matchType: "别名匹配" };
  }

  const series = rules.filter((rule) => {
    const prefix = seriesPrefix(rule.name);
    return prefix && normalizeRuleName(product).startsWith(normalizeRuleName(prefix));
  });
  if (series[0]) {
    return {
      rule: series.sort((a, b) => seriesPrefix(b.name).length - seriesPrefix(a.name).length)[0],
      matchType: "系列匹配",
    };
  }

  return { rule: null, matchType: "未匹配" };
}

function applyCommissionRulesToOrder(order, rules) {
  const { rule, matchType } = matchCommissionRule(order.productName, rules);
  const baseCommission = rule ? Number(rule.commission || 0) : 0;
  const quantity = Number(order.quantity || 0);
  const amount = Number(order.amount || 0);
  const zeroAmount = order.status === "正常" && baseCommission > 0 && amount <= 0;
  const canCommission = order.status === "正常" && baseCommission > 0 && quantity > 0 && amount > 0;
  const commission = canCommission
    ? Math.round((quantity * baseCommission + (amount - quantity * Number(rule.packPrice || 0)) * 0.5) * 100) / 100
    : 0;
  return {
    ...order,
    ruleName: rule ? rule.name : "",
    ruleId: rule ? rule.id : "",
    commissionPerUnit: zeroAmount ? 0 : baseCommission,
    commission,
    matchType: zeroAmount ? "实收金额不大于0，不计提" : matchType,
  };
}

function manualEntryToOrder(entry, rules) {
  const rawOrder = {
    store: "手工录入",
    orderId: entry.id,
    paymentNo: "",
    productId: "",
    productName: entry.productName,
    unit: "包",
    originalQuantity: entry.quantity,
    quantity: entry.quantity,
    quantityBasis: "后台手工录入，按计提包数计算",
    unitPrice: entry.unitPrice,
    amount: entry.unitPrice * entry.quantity,
    refund: 0,
    status: "正常",
    cashier: entry.cashier,
    checkoutTime: entry.checkoutTime || `${entry.date} 手工录入`,
    date: entry.date,
    manualReason: entry.reason,
    isManual: true,
  };
  return applyCommissionRulesToOrder(rawOrder, rules);
}

function buildManualOrders(rules) {
  return readManualEntries().map((entry) => manualEntryToOrder(entry, rules));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
