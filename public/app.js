const apiBase = location.protocol === "file:" ? "" : "/autotc/api";
const localMonth = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 7);
};
// 占位商品名：收银员未录入具体商品时的占位行，简繁体都要覆盖。
const APP_PLACEHOLDER_PRODUCT_NAMES = ["快速收银", "快速收銀"];

function appIsPlaceholderProduct(value) {
  return APP_PLACEHOLDER_PRODUCT_NAMES.includes(String(value || "").trim());
}

const state = { month: "", person: "", startDate: "", endDate: "", search: "", mode: "commission", page: 1, pageSize: 500 };
let periods = { months: [], minDate: "", maxDate: "" };
let report = { summary: {}, people: [], products: [], daily: [], rows: [], pagination: { total: 0 }, freshness: {} };
let searchTimer = null;
let useFallbackReport = false;
let currentOrderDetailId = "";

const el = Object.fromEntries([
  "sourceLine", "staleBanner", "staleMessage", "monthFilter", "personFilter", "startDateFilter", "endDateFilter", "searchInput", "exportBtn", "resetBtn",
  "totalCommission", "heroHint", "goalLabel", "goalRing", "goalPercent", "goalProgress", "goalText", "goalPolicyHint", "peopleCount", "leaderboard", "kpiQty", "kpiSales", "kpiOrders", "kpiUnmatched",
  "dailyChart", "dateRangeLabel", "productCount", "productList", "detailCount", "detailBody", "orderDetailDialog", "orderDetailTitle", "orderDetailSummary", "orderDetailNote", "orderDetailBody", "closeOrderDetailBtn",
  "orderAllocationPanel", "orderAllocationBody", "orderAllocationNote", "orderAllocationPassword", "saveOrderAllocationBtn", "orderAllocationStatus",
].map((id) => [id, document.querySelector(`#${id}`)]));

const money = (value) => `¥${Number(value || 0).toFixed(2)}`;
const qty = (value) => Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const cashierName = (value) => String(value || "").split("/")[0].trim() || String(value || "").trim();
const leaderboardNames = ["刘超霞", "陈漫莉"];
const aliases = { 陈漠莉: "陈漫莉" };
const leaderName = (value) => aliases[cashierName(value)] || cashierName(value);

async function api(path) {
  const response = await fetch(`${apiBase}${path}`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.message || `请求失败：${response.status}`);
  return payload;
}

async function apiJson(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    cache: "no-store",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.message || `请求失败：${response.status}`);
  return payload;
}

function monthBounds(month) {
  const [year, value] = month.split("-").map(Number);
  const last = new Date(year, value, 0).getDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

function fallbackData() {
  const data = window.COMMISSION_DATA || { orders: [] };
  const rows = [...(data.orders || []), ...buildManualOrders(baseCommissionRules())];
  const dates = rows.map((item) => item.date).filter(Boolean).sort();
  periods = { months: [...new Set(dates.map((date) => date.slice(0, 7)))], minDate: dates[0] || "", maxDate: dates.at(-1) || "" };
  return summarizeFallback(rows);
}

function summarizeFallback(rows) {
  const keyword = state.search.toLowerCase();
  let visible = rows.filter((row) => row.date >= state.startDate && row.date <= state.endDate);
  if (state.person) visible = visible.filter((row) => cashierName(row.cashier) === state.person);
  if (keyword) {
    visible = visible.filter((row) => [row.productName, row.orderId, row.paymentNo].some((value) => String(value || "").toLowerCase().includes(keyword)));
  }
  const modeRows = visible.filter((row) => {
    if (state.mode === "all") return true;
    if (state.mode === "unmatched") return !appIsPlaceholderProduct(row.productName) && !row.ruleName;
    return Number(row.commissionPerUnit) > 0 && row.status === "正常";
  });
  const commissioned = modeRows.filter((row) => Number(row.commissionPerUnit) > 0 && row.status === "正常");
  const group = (key) => {
    const map = new Map();
    for (const row of commissioned) {
      const name = typeof key === "function" ? key(row) : row[key];
      const current = map.get(name) || { name, quantity: 0, commission: 0, sales: 0, orders: new Set() };
      current.quantity += Number(row.quantity || 0); current.commission += Number(row.commission || 0); current.sales += Number(row.amount || 0); current.orders.add(row.orderId); map.set(name, current);
    }
    return [...map.values()].map((item) => ({ ...item, orderCount: item.orders.size })).sort((a, b) => b.commission - a.commission);
  };
  return {
    summary: { totalCommission: commissioned.reduce((sum, row) => sum + Number(row.commission || 0), 0), totalQuantity: commissioned.reduce((sum, row) => sum + Number(row.quantity || 0), 0), totalSales: commissioned.reduce((sum, row) => sum + Number(row.amount || 0), 0), orderCount: new Set(commissioned.map((row) => row.orderId)).size, unmatchedCount: visible.filter((row) => !appIsPlaceholderProduct(row.productName) && !row.ruleName).length },
    people: group("cashier"), products: group((row) => row.ruleName || row.productName), daily: group("date"), rows: modeRows.slice(0, 500), pagination: { total: modeRows.length, pageSize: 500 }, fallback: true,
  };
}

async function initialize() {
  let fallbackReason = "";
  try {
    periods = await api("/report/periods");
  } catch (error) {
    useFallbackReport = true;
    fallbackReason = error.message;
    report = fallbackData();
    el.sourceLine.textContent = `服务器台账暂不可用，显示本地回退数据：${error.message}`;
  }
  const requestedMonth = new URLSearchParams(location.search).get("month") || "";
  const latestMonth = periods.months?.at(-1) || localMonth();
  state.month = periods.months?.includes(requestedMonth) ? requestedMonth : latestMonth;
  const bounds = monthBounds(state.month);
  state.startDate = periods.maxDate?.startsWith(state.month) ? `${state.month}-01` : bounds.start;
  state.endDate = periods.maxDate?.startsWith(state.month) ? periods.maxDate : bounds.end;
  setupFilters();
  if (!report.fallback) {
    await loadReport();
  } else {
    report = fallbackData();
    const people = report.people.map((item) => cashierName(item.name)).filter(Boolean).sort();
    el.personFilter.innerHTML = ["全部收银员", ...new Set(people)].map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    el.sourceLine.textContent = `服务器台账暂不可用，显示本地回退数据：${fallbackReason}`;
    render();
  }
}

function setupFilters() {
  el.monthFilter.innerHTML = (periods.months || []).map((month) => `<option value="${escapeHtml(month)}">${escapeHtml(month)}</option>`).join("");
  el.monthFilter.value = state.month;
  el.startDateFilter.value = state.startDate;
  el.endDateFilter.value = state.endDate;
  el.monthFilter.addEventListener("change", async () => {
    state.month = el.monthFilter.value;
    const bounds = monthBounds(state.month); state.startDate = bounds.start; state.endDate = state.month === periods.months.at(-1) && periods.maxDate ? periods.maxDate : bounds.end;
    el.startDateFilter.value = state.startDate; el.endDateFilter.value = state.endDate; await loadReport();
  });
  el.startDateFilter.addEventListener("change", async () => { state.month = ""; state.startDate = el.startDateFilter.value; if (state.endDate < state.startDate) { state.endDate = state.startDate; el.endDateFilter.value = state.endDate; } await loadReport(); });
  el.endDateFilter.addEventListener("change", async () => { state.month = ""; state.endDate = el.endDateFilter.value; if (state.startDate > state.endDate) { state.startDate = state.endDate; el.startDateFilter.value = state.startDate; } await loadReport(); });
  el.personFilter.addEventListener("change", async () => { state.person = el.personFilter.value === "全部收银员" ? "" : el.personFilter.value; await loadReport(false); });
  el.searchInput.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(async () => { state.search = el.searchInput.value.trim(); await loadReport(false); }, 300); });
  document.querySelectorAll(".segmented button").forEach((button) => button.addEventListener("click", async () => { state.mode = button.dataset.mode; document.querySelectorAll(".segmented button").forEach((item) => item.classList.toggle("active", item === button)); await loadReport(false); }));
  el.resetBtn.addEventListener("click", async () => { const latest = periods.months.at(-1); state.month = latest; const bounds = monthBounds(latest); state.startDate = bounds.start; state.endDate = periods.maxDate || bounds.end; state.person = ""; state.search = ""; state.mode = "commission"; el.monthFilter.value = latest; el.startDateFilter.value = state.startDate; el.endDateFilter.value = state.endDate; el.searchInput.value = ""; document.querySelectorAll(".segmented button").forEach((button) => button.classList.toggle("active", button.dataset.mode === "commission")); await loadReport(); });
  el.exportBtn.addEventListener("click", exportRows);
  el.detailBody.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-order-id]");
    if (trigger) showOrderDetail(trigger.dataset.orderId);
  });
  el.closeOrderDetailBtn.addEventListener("click", closeOrderDetail);
  el.saveOrderAllocationBtn?.addEventListener("click", saveOrderAllocation);
  el.goalPolicyHint?.addEventListener("click", () => alert("计量目标值为：上两个月的平均值结合作业人数，综合评估值"));
}

async function loadReport(refreshPeople = true) {
  if (!apiBase || useFallbackReport) {
    report = fallbackData();
    if (refreshPeople && !state.person) {
      const people = report.people.map((item) => cashierName(item.name)).filter(Boolean).sort();
      el.personFilter.innerHTML = ["全部收银员", ...new Set(people)].map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    }
    render();
    return;
  }
  const params = new URLSearchParams({ start: state.startDate, end: state.endDate, mode: state.mode, page: "1", pageSize: String(state.pageSize) });
  if (state.person) params.set("cashier", state.person);
  if (state.search) params.set("search", state.search);
  try {
    report = await api(`/report?${params}`);
    if (refreshPeople && !state.person) {
      const people = report.people.map((item) => cashierName(item.name)).filter(Boolean).sort();
      el.personFilter.innerHTML = ["全部收银员", ...new Set(people)].map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    }
    el.sourceLine.textContent = `最后成功更新：${report.freshness?.lastSuccess?.completed_at || "暂无"} · 查询 ${state.startDate} 至 ${state.endDate}`;
    renderFreshness(); render();
  } catch (error) {
    useFallbackReport = true;
    report = fallbackData();
    render();
    el.sourceLine.textContent = `台账查询失败：${error.message}`;
    el.staleBanner.hidden = false; el.staleMessage.textContent = "服务器报表接口不可用，请联系管理员。";
  }
}

function renderFreshness() {
  const stale = Boolean(report.freshness?.stale);
  el.staleBanner.hidden = !stale;
  if (stale) el.staleMessage.textContent = `最后成功更新：${report.freshness?.lastSuccess?.completed_at || "未知"}。最近错误：${report.freshness?.lastImport?.error_message || "无记录"}`;
}

function salesTargetMessage(summary, salesTarget) {
  const baseSales = Number(salesTarget?.baseSales ?? summary.totalSales ?? 0);
  const supplementSales = Number(salesTarget?.supplementSales || 0);
  const actualSales = Number(salesTarget?.actualSales ?? baseSales + supplementSales);
  const targetSales = Number(salesTarget?.targetSales || 0);
  const sourceText = supplementSales > 0
    ? `计提商品销售额 ${money(baseSales)} + 补录销售额 ${money(supplementSales)} / 销售目标`
    : "计提商品销售额 / 销售目标";
  if (targetSales <= 0) {
    return {
      actualSales,
      targetSales,
      progress: 0,
      label: `${money(actualSales)} / 未设置`,
      text: `${sourceText}；请先在后台设置本月销售目标。`,
      policyText: "未设置销售目标，提成按原规则全额计算。目标达成率影响提成发放。",
      policyTitle: "计量目标值为：上两个月的平均值结合作业人数，综合评估值",
    };
  }
  const progress = Math.min(100, actualSales / targetSales * 100);
  const remaining = Math.max(0, targetSales - actualSales);
  const exceeded = Math.max(0, actualSales - targetSales);
  const slogan = progress >= 100
    ? "目标已达成，继续扩大领先优势！"
    : progress >= 50
      ? "冲刺进行中，距离目标只差一步。"
      : "稳住节奏，每一单都在靠近目标。";
  const gapText = progress >= 100 ? `已超过目标 ${money(exceeded)}` : `距离目标还差 ${money(remaining)}`;
  return {
    actualSales,
    targetSales,
    progress,
    label: `${money(actualSales)} / ${money(targetSales)}`,
    text: `${sourceText}。销售目标${targetSales.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}元[由管理员后台设定]，${gapText}。${slogan}`,
    policyText: salesTarget?.appliesCommissionPayout
      ? `目标达成率影响提成发放：${salesTarget?.commissionPolicyText || "历史完整月份按销售目标达成率阶梯发放"}。历史完整月份已按${Number(salesTarget?.commissionPayoutRate ?? 100)}%发放。`
      : `目标达成率影响提成发放：${salesTarget?.commissionPolicyText || "当前月只提示不正式调整"}。当前月只提示不正式调整，页面仍展示当前可得原始提成。`,
    policyTitle: "计量目标值为：上两个月的平均值结合作业人数，综合评估值",
  };
}

function render() {
  const summary = report.summary || {};
  const target = salesTargetMessage(summary, report.salesTarget);
  el.totalCommission.textContent = money(summary.totalCommission); el.heroHint.textContent = summary.totalCommission ? `已产生 ${qty(summary.totalQuantity)} 包计提商品。` : "当前筛选下暂无提成。";
  el.goalLabel.textContent = target.label; el.goalProgress.style.width = `${target.progress}%`; el.goalRing.style.setProperty("--progress", `${target.progress * 3.6}deg`); el.goalPercent.textContent = `${target.progress.toFixed(1)}%`; el.goalText.textContent = target.text; if (el.goalPolicyHint) { el.goalPolicyHint.textContent = target.policyText; el.goalPolicyHint.title = target.policyTitle; }
  renderLeaderboard((report.people || []).filter((item) => leaderboardNames.includes(leaderName(item.name))).map((item) => ({ ...item, name: leaderName(item.name) })));
  el.kpiQty.textContent = qty(summary.totalQuantity); el.kpiSales.textContent = money(summary.totalSales); el.kpiOrders.textContent = summary.orderCount || 0; el.kpiUnmatched.textContent = summary.unmatchedCount || 0;
  renderDaily(report.daily || []); renderProducts(report.products || []); renderTable(report.rows || []);
}

function renderLeaderboard(people) {
  el.peopleCount.textContent = `${people.length} 人`;
  if (!people.length) { el.leaderboard.innerHTML = '<div class="empty">当前筛选下暂无指定收银员提成</div>'; return; }
  const max = people[0].commission || 1;
  el.leaderboard.innerHTML = people.map((person, index) => `<div class="leader-row ${index === 0 ? "winner" : ""}"><div class="rank">${index + 1}</div><div class="avatar">${escapeHtml(person.name.slice(0, 1))}</div><div><div class="leader-name">${escapeHtml(person.name)}</div><div class="leader-meta">${qty(person.quantity)} 包 · ${person.orderCount} 单</div><div class="mini-track"><div class="mini-fill" style="width:${Math.max(8, person.commission / max * 100)}%"></div></div></div><div class="leader-money">${money(person.commission)}</div></div>`).join("");
}

function renderDaily(days) {
  el.dateRangeLabel.textContent = `${state.startDate} 至 ${state.endDate}`;
  if (!days.length) { el.dailyChart.innerHTML = '<div class="empty">暂无每日提成数据</div>'; return; }
  const max = Math.max(...days.map((item) => item.commission), 1);
  el.dailyChart.innerHTML = [...days].sort((a, b) => a.name.localeCompare(b.name)).map((day) => `<div class="bar-row"><span>${escapeHtml(day.name)}</span><div class="mini-track"><div class="mini-fill blue" style="width:${Math.max(6, day.commission / max * 100)}%"></div></div><b>${money(day.commission)}</b></div>`).join("");
}

function renderProducts(products) {
  el.productCount.textContent = `${products.length} 项`;
  el.productList.innerHTML = products.length ? products.slice(0, 8).map((item) => `<div class="product-row"><div><strong>${escapeHtml(item.name)}</strong><span>${qty(item.quantity)} 包 · ${item.orderCount} 单 · 销售 ${money(item.sales)}</span></div><b>${money(item.commission)}</b></div>`).join("") : '<div class="empty">暂无商品贡献</div>';
}

function priceStatusText(status) {
  return ({
    NORMAL: "正常价",
    WITHIN_DISCOUNT: "范围内优惠",
    LOWER_THAN_MIN_PRICE: "低于底线",
    ZERO_AMOUNT: "零实收",
    NO_COMMISSION: "不计提",
  })[status] || "—";
}

function priceStatusBadge(item) {
  const status = item.priceStatus || item.commissionStatus || "";
  const warn = status === "LOWER_THAN_MIN_PRICE" || status === "ZERO_AMOUNT";
  return `<span class="match-badge ${warn ? "warn" : ""}" title="规则应收 ${money(item.expectedAmount)}；最低实收 ${money(item.minAllowedAmount)}">${escapeHtml(priceStatusText(status))}</span>`;
}

function renderTable(rows) {
  el.detailCount.textContent = `${report.pagination?.total || rows.length} 行`;
  if (!rows.length) { el.detailBody.innerHTML = '<tr><td class="empty" colspan="19">没有符合条件的明细</td></tr>'; return; }
  el.detailBody.innerHTML = rows.map((item) => {
    const splitText = item.splitGroupSize > 1 ? `原：${item.originalCashier || "-"} · ${item.splitCashiers} 均分 ${item.splitIndex}/${item.splitGroupSize}` : "";
    const orderId = String(item.orderId || "");
    const orderLink = `<button type="button" class="order-link" data-order-id="${escapeHtml(orderId)}">${escapeHtml(orderId)}</button>`;
    const orderDifference = item.orderDifferenceNote ? `<button type="button" class="match-badge warn order-flag" data-order-id="${escapeHtml(orderId)}" title="${escapeHtml(item.orderDifferenceNote)}">⚠ 金额差额</button>` : "—";
    return `<tr><td>${escapeHtml(item.checkoutTime || item.date || "")}</td><td>${orderLink}</td><td>${orderDifference}</td><td>${escapeHtml(item.paymentNo || "")}</td><td>${escapeHtml(item.cashier)}</td><td>${escapeHtml(splitText)}</td><td>${escapeHtml(item.productName)}</td><td>${escapeHtml(item.ruleName || "待补规则")}</td><td class="num">${qty(item.originalQuantity ?? item.quantity)}</td><td>${escapeHtml(item.unit || "包")}</td><td class="num" title="${escapeHtml(item.quantityBasis || "")}">${qty(item.quantity)}</td><td class="num">${money(item.unitPrice)}</td><td class="num">${money(item.amount)}</td><td class="num">${money(item.expectedAmount)}</td><td class="num">${money(item.minAllowedAmount)}</td><td>${priceStatusBadge(item)}</td><td class="num">${money(item.commissionPerUnit)}</td><td class="num"><strong>${money(item.commission)}</strong></td><td><span class="match-badge ${item.matchType === "未匹配" ? "warn" : ""}">${escapeHtml(item.sourceKind === "manual" ? `手工 · ${item.matchType}` : item.matchType)}</span></td></tr>`;
  }).join("");
}

function closeOrderDetail() {
  if (el.orderDetailDialog.open && typeof el.orderDetailDialog.close === "function") el.orderDetailDialog.close();
  else el.orderDetailDialog.removeAttribute("open");
}

function fallbackOrderDetails(orderId) {
  const dataRows = window.COMMISSION_DATA?.orders || [];
  const visibleRows = [...dataRows, ...(report.rows || [])];
  return visibleRows.filter((row) => String(row.orderId || "") === String(orderId)).map((row) => ({ ...row, orderDifferenceNote: row.orderDifferenceNote || "" }));
}

function renderAllocationPanel(orderId, allocation = {}) {
  if (!el.orderAllocationPanel) return;
  const breakdown = allocation.breakdown || {};
  const totals = breakdown.totals || {};
  const hasBreakdown = Boolean(breakdown.totals) && (Number(totals.quickAmount || 0) > 0 || Number(totals.otherNonCommissionAmount || 0) > 0 || Boolean(allocation.required) || Boolean(allocation.manual));
  el.orderAllocationPanel.hidden = !hasBreakdown;
  if (!hasBreakdown) {
    el.orderAllocationBody.innerHTML = "";
    el.orderAllocationStatus.textContent = "";
    return;
  }
  const required = Boolean(allocation.required);
  el.orderAllocationStatus.textContent = allocation.manual ? "已保存手动分摊" : (required ? "待管理员核对" : "已自动拆分");
  el.orderAllocationNote.value = allocation.note || "";
  if (el.orderAllocationPassword) el.orderAllocationPassword.value = "";
  const suggestions = allocation.suggestions || [];
  const finalTitle = allocation.manual ? "最终核对结果" : "请逐项填写核对金额";
  const itemLabel = (item) => `${escapeHtml(item.productName)}${item.quantity ? ` ${qty(item.quantity)}${escapeHtml(item.unit || "")}` : ""}`;
  const inputRow = (item) => `<label class="search-field allocation-row"><span>${itemLabel(item)}：</span><input type="number" step="0.01" min="0" data-allocation-line-key="${escapeHtml(item.lineKey)}" value="${Number(item.manualAllocatedAmount ?? item.suggestedAmount ?? item.currentAmount ?? 0).toFixed(2)}" /><small>POS行金额 ${money(item.currentAmount)}${Number(item.expectedAmount || 0) > 0 ? `；规则应收 ${money(item.expectedAmount)}` : ""}</small></label>`;
  el.orderAllocationBody.innerHTML = `
    <div class="order-detail-summary">
      <span>订单总额 <strong>${money(totals.orderAmount)}</strong></span>
      <span>逐项合计 <strong>${money(totals.allocatedTotal)}</strong></span>
      <span>差额 <strong>${money(totals.difference)}</strong></span>
    </div>
    <div class="order-allocation-section order-allocation-form" data-order-amount="${Number(totals.orderAmount || 0).toFixed(2)}">
      <strong>${finalTitle}</strong>
      ${suggestions.map(inputRow).join("")}
      ${!(breakdown.otherNonCommissionItems || []).length ? `<label class="search-field allocation-row"><span>其它非提成商品：</span><input type="number" step="0.01" min="0" value="0.00" disabled /><small>本订单没有其它非提成商品明细</small></label>` : ""}
      <div class="order-detail-summary">
        <span>提成商品金额 <strong>${money(totals.commissionAmount)}</strong></span>
        <span>快速收银金额 <strong>${money(totals.quickAmount)}</strong></span>
        <span>其它非提成商品金额 <strong>${money(totals.otherNonCommissionAmount)}</strong></span>
      </div>
    </div>
    <small>${required ? "请把每一笔款填写到对应商品、快速收银或其它非提成商品上；合计必须等于订单总额，输入确认密码后才能保存。" : "该订单已自动拆出提成商品、快速收银和其它非提成商品金额。"}</small>
  `;
  el.orderAllocationNote.closest("label").hidden = !required;
  el.orderAllocationPassword.closest("label").hidden = !required;
  el.saveOrderAllocationBtn.hidden = !required;
  currentOrderDetailId = orderId;
}

async function saveOrderAllocation() {
  if (!currentOrderDetailId || !apiBase) return;
  const allocations = [...el.orderAllocationBody.querySelectorAll("[data-allocation-line-key]")].map((input) => ({
    lineKey: input.dataset.allocationLineKey,
    amount: Number(input.value || 0),
  }));
  try {
    el.orderAllocationStatus.textContent = "正在保存…";
    await apiJson(`/order-allocations/${encodeURIComponent(currentOrderDetailId)}`, {
      method: "PUT",
      body: JSON.stringify({ confirmPassword: el.orderAllocationPassword.value, note: el.orderAllocationNote.value.trim(), allocations }),
    });
    el.orderAllocationStatus.textContent = "保存成功";
    await showOrderDetail(currentOrderDetailId);
  } catch (error) {
    el.orderAllocationStatus.textContent = `保存失败：${error.message}`;
  }
}

async function showOrderDetail(orderId) {
  const target = String(orderId || "").trim();
  if (!target) return;
  el.orderDetailTitle.textContent = `订单 ${target}`;
  el.orderDetailSummary.textContent = "正在加载整单明细…";
  el.orderDetailNote.hidden = true;
  if (el.orderAllocationPanel) el.orderAllocationPanel.hidden = true;
  el.orderDetailBody.innerHTML = '<tr><td class="empty" colspan="11">正在加载…</td></tr>';
  if (typeof el.orderDetailDialog.showModal === "function") el.orderDetailDialog.showModal();
  else el.orderDetailDialog.setAttribute("open", "");
  try {
    const payload = apiBase && !useFallbackReport ? await api(`/order-details/${encodeURIComponent(target)}`) : { rows: fallbackOrderDetails(target), allocation: { required: false } };
    const rows = payload.rows || [];
    if (!rows.length) {
      el.orderDetailSummary.textContent = "没有找到该订单的完整明细。";
      el.orderDetailBody.innerHTML = '<tr><td class="empty" colspan="11">暂无明细</td></tr>';
      return;
    }
    const first = rows[0];
    el.orderDetailSummary.innerHTML = `<span>订单实收 <strong>${money(first.orderAmount)}</strong></span><span>提成商品销售额 <strong>${money(first.commissionSalesAmount)}</strong></span><span>非提成商品金额 <strong>${money(first.nonCommissionAmount)}</strong></span><span>扣除后待核对 <strong>${money(first.orderUnexplainedDifference)}</strong></span>`;
    if (first.orderDifferenceNote) { el.orderDetailNote.textContent = first.orderDifferenceNote; el.orderDetailNote.hidden = false; }
    renderAllocationPanel(target, payload.allocation || {});
    el.orderDetailBody.innerHTML = rows.map((item) => `<tr><td>${escapeHtml(item.checkoutTime || item.date || "")}</td><td>${escapeHtml(item.paymentNo || "")}</td><td>${escapeHtml(item.productName || "")}</td><td>${escapeHtml(item.ruleName || "非提成商品/未匹配")}</td><td class="num">${qty(item.originalQuantity ?? item.quantity)}</td><td>${escapeHtml(item.unit || "包")}</td><td class="num">${money(item.unitPrice)}</td><td class="num">${money(item.manualAllocatedAmount ?? item.amount)}${item.manualAllocatedAmount != null ? "<br><small>手动分摊</small>" : ""}</td><td class="num">${money(item.commissionPerUnit)}</td><td class="num"><strong>${money(item.commission)}</strong></td><td><span class="match-badge ${item.commissionPerUnit > 0 ? "" : "warn"}">${escapeHtml(item.matchType || "未匹配")}</span></td></tr>`).join("");
  } catch (error) {
    el.orderDetailSummary.textContent = `整单明细加载失败：${error.message}`;
    el.orderDetailBody.innerHTML = '<tr><td class="empty" colspan="11">请稍后重试</td></tr>';
  }
}

async function exportRows() {
  const params = new URLSearchParams({ start: state.startDate, end: state.endDate, mode: state.mode, page: "1", pageSize: "1000" });
  if (state.person) params.set("cashier", state.person); if (state.search) params.set("search", state.search);
  const first = await api(`/report?${params}`); const rows = [...first.rows]; const pages = Math.ceil(first.pagination.total / first.pagination.pageSize);
  for (let page = 2; page <= pages; page += 1) { params.set("page", String(page)); rows.push(...(await api(`/report?${params}`)).rows); }
  const lines = [["时间","订单号","订单金额核对","支付流水号","收银员","原收银员","均分人员","均分人数","商品","匹配规则","原数量","单位","计提包数","计提规则","单价","销售额","提成/包","提成","原提成","匹配方式","事由"], ...rows.map((item) => [item.checkoutTime,item.orderId,item.orderDifferenceNote || "",item.paymentNo,item.cashier,item.originalCashier || "",item.splitCashiers || "",item.splitGroupSize || "",item.productName,item.ruleName,item.originalQuantity,item.unit,item.quantity,item.quantityBasis,item.unitPrice,item.amount,item.commissionPerUnit,item.commission,item.originalCommission || "",item.matchType,item.manualReason])];
  const blob = new Blob([`\uFEFF${lines.map((line) => line.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n")}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `外烟提成明细_${state.startDate}_${state.endDate}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

initialize();
