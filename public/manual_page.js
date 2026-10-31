const localDate = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};
const localMonth = () => localDate().slice(0, 7);

const DEFAULT_SHIFT_TEMPLATES = [
  { id: "white", name: "白班", type: "连续班", segments: [{ start: "07:00", end: "17:00", crossDay: false }] },
  { id: "night", name: "晚班", type: "连续班", segments: [{ start: "17:00", end: "03:00", crossDay: true }] },
  { id: "floating", name: "穿插班", type: "分段班", segments: [{ start: "11:30", end: "13:30", crossDay: false }, { start: "18:00", end: "01:00", crossDay: true }] },
];
const PEAK_WINDOWS = [
  { id: "noon", name: "午高峰", start: "11:30", end: "13:30", crossDay: false, requiredStaff: 2 },
  { id: "evening", name: "晚高峰", start: "18:00", end: "20:00", crossDay: false, requiredStaff: 2 },
  { id: "late", name: "深夜高峰", start: "23:00", end: "01:00", crossDay: true, requiredStaff: 2 },
];

let rules = baseCommissionRules();
let drafts = [sampleDraft()];
let ruleDrafts = rules.map((rule) => ({ ...rule }));
let serverRuleMeta = { source: "数据文件", hasCustomRules: false };
let salesTargets = [];
let salesTargetSupplements = [];
let serverManualEntries = [];
let shiftShareWindows = [];
let shiftTemplates = DEFAULT_SHIFT_TEMPLATES;
let peakWindows = PEAK_WINDOWS;
let scheduleExtraCashiers = new Set();
let pendingRuleSave = null;
let manualMigrationInProgress = false;

const apiBase = location.protocol === "file:" ? "" : "/autotc/api";
const el = {
  loginScreen: document.querySelector("#loginScreen"),
  loginForm: document.querySelector("#loginForm"),
  passwordInput: document.querySelector("#passwordInput"),
  loginStatus: document.querySelector("#loginStatus"),
  adminApp: document.querySelector("#adminApp"),
  logoutBtn: document.querySelector("#logoutBtn"),
  migrationPanel: document.querySelector("#migrationPanel"),
  importLocalRulesBtn: document.querySelector("#importLocalRulesBtn"),
  manualMigrationPanel: document.querySelector("#manualMigrationPanel"),
  importLocalManualBtn: document.querySelector("#importLocalManualBtn"),
  serverRuleSource: document.querySelector("#serverRuleSource"),
  dataGeneratedAt: document.querySelector("#dataGeneratedAt"),
  targetMonthInput: document.querySelector("#targetMonthInput"),
  targetSalesInput: document.querySelector("#targetSalesInput"),
  saveSalesTargetBtn: document.querySelector("#saveSalesTargetBtn"),
  supplementDateInput: document.querySelector("#supplementDateInput"),
  supplementAmountInput: document.querySelector("#supplementAmountInput"),
  supplementNoteInput: document.querySelector("#supplementNoteInput"),
  saveSupplementBtn: document.querySelector("#saveSupplementBtn"),
  salesTargetSupplementBody: document.querySelector("#salesTargetSupplementBody"),
  salesTargetStatus: document.querySelector("#salesTargetStatus"),
  currentSalesTargetLine: document.querySelector("#currentSalesTargetLine"),
  currentSalesTargetStatus: document.querySelector("#currentSalesTargetStatus"),
  entryBody: document.querySelector("#entryBody"),
  addRowBtn: document.querySelector("#addRowBtn"),
  saveRowsBtn: document.querySelector("#saveRowsBtn"),
  exportBtn: document.querySelector("#exportManualBtn"),
  draftCount: document.querySelector("#draftCount"),
  savedCount: document.querySelector("#savedCount"),
  savedBody: document.querySelector("#savedBody"),
  shiftShareBody: document.querySelector("#shiftShareBody"),
  shiftShareCount: document.querySelector("#shiftShareCount"),
  addShiftShareBtn: document.querySelector("#addShiftShareBtn"),
  generateShiftRangeBtn: document.querySelector("#generateShiftRangeBtn"),
  shiftRangeStart: document.querySelector("#shiftRangeStart"),
  shiftRangeEnd: document.querySelector("#shiftRangeEnd"),
  shiftRangeCashier: document.querySelector("#shiftRangeCashier"),
  shiftTemplateSelect: document.querySelector("#shiftTemplateSelect"),
  shiftRangeSegments: document.querySelector("#shiftRangeSegments"),
  shiftRangeEffective: document.querySelector("#shiftRangeEffective"),
  saveShiftSharesBtn: document.querySelector("#saveShiftSharesBtn"),
  shiftShareStatus: document.querySelector("#shiftShareStatus"),
  shiftCoverageBody: document.querySelector("#shiftCoverageBody"),
  scheduleMatrixHead: document.querySelector("#scheduleMatrixHead"),
  scheduleMatrixBody: document.querySelector("#scheduleMatrixBody"),
  scheduleCoverageGrid: document.querySelector("#scheduleCoverageGrid"),
  addScheduleCashierBtn: document.querySelector("#addScheduleCashierBtn"),
  copyPreviousDayBtn: document.querySelector("#copyPreviousDayBtn"),
  ruleBody: document.querySelector("#ruleBody"),
  ruleCount: document.querySelector("#ruleCount"),
  addRuleBtn: document.querySelector("#addRuleBtn"),
  saveRulesBtn: document.querySelector("#saveRulesBtn"),
  previewResetRulesBtn: document.querySelector("#previewResetRulesBtn"),
  resetRulesBtn: document.querySelector("#resetRulesBtn"),
  exportRulesBtn: document.querySelector("#exportRulesBtn"),
  rulesStatus: document.querySelector("#rulesStatus"),
  ruleImpactPanel: document.querySelector("#ruleImpactPanel"),
  ruleEffectiveDate: document.querySelector("#ruleEffectiveDate"),
  ruleImpactText: document.querySelector("#ruleImpactText"),
  ruleImpactChanges: document.querySelector("#ruleImpactChanges"),
  forceRulesBtn: document.querySelector("#forceRulesBtn"),
  cancelForceRulesBtn: document.querySelector("#cancelForceRulesBtn"),
  adminRuleSourceLine: document.querySelector("#adminRuleSourceLine"),
  adminGeneratedAt: document.querySelector("#adminGeneratedAt"),
  adminStatDrafts: document.querySelector("#adminStatDrafts"),
  adminStatManuals: document.querySelector("#adminStatManuals"),
  adminStatShifts: document.querySelector("#adminStatShifts"),
  adminStatRules: document.querySelector("#adminStatRules"),
};

el.ruleEffectiveDate.value = `${localDate()}T00:00`;
if (el.targetMonthInput) el.targetMonthInput.value = localMonth();
if (el.supplementDateInput) el.supplementDateInput.value = localDate();
el.shiftRangeStart.value = localDate();
el.shiftRangeEnd.value = localDate();
el.shiftRangeEffective.value = `${localDate()}T00:00`;
renderShiftTemplateOptions();
applyShiftTemplate();

function apiUrl(path) {
  return `${apiBase}${path}`;
}

async function apiFetch(path, options = {}) {
  if (!apiBase) throw new Error("请通过线上地址访问后台管理");
  const response = await fetch(apiUrl(path), {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `请求失败：${response.status}`);
  }
  return data;
}

function showLogin(message = "") {
  el.adminApp.hidden = true;
  el.loginScreen.hidden = false;
  el.loginStatus.textContent = message;
  el.passwordInput?.focus();
}

async function showAdmin() {
  el.loginScreen.hidden = true;
  el.adminApp.hidden = false;
  await loadServerRules();
  await loadSalesTargets();
  await loadSalesTargetSupplements();
  await loadServerManualEntries();
  await loadShiftShares();
  renderRules();
  renderShiftShares();
  renderDrafts();
  renderSaved();
  renderMeta();
  renderMigrationPanel();
  if (readManualEntries().length) await importLocalManualEntries({ automatic: true });
}

async function checkSession() {
  if (!apiBase) {
    showLogin("请使用线上地址 https://aininja365.xyz/autotc/manual.html 打开后台管理。");
    return;
  }
  try {
    const session = await apiFetch("/session");
    if (session.authenticated) await showAdmin();
    else showLogin();
  } catch {
    showLogin();
  }
}

async function login(password) {
  const result = await apiFetch("/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  if (!result.authenticated) throw new Error("密码错误");
  await showAdmin();
}

async function logout() {
  await apiFetch("/logout", { method: "POST", body: "{}" }).catch(() => {});
  showLogin("已退出后台。");
}

async function loadServerRules() {
  try {
    const result = await apiFetch("/rules");
    rules = (result.rules || []).map(normalizeCommissionRule).filter((rule) => rule.name);
    serverRuleMeta = {
      source: result.source || "数据文件",
      hasCustomRules: Boolean(result.hasCustomRules),
      updatedAt: result.updatedAt || "",
    };
  } catch (error) {
    rules = baseCommissionRules();
    serverRuleMeta = { source: "数据文件", hasCustomRules: false, error: error.message };
  }
  ruleDrafts = rules.map((rule) => ({ ...rule }));
}

async function saveServerRules(cleanRules) {
  const result = await apiFetch("/rules", {
    method: "PUT",
    body: JSON.stringify({ rules: cleanRules }),
  });
  rules = (result.rules || cleanRules).map(normalizeCommissionRule).filter((rule) => rule.name);
  serverRuleMeta = {
    source: result.source || "后台维护规则",
    hasCustomRules: true,
    updatedAt: result.updatedAt || "",
  };
  ruleDrafts = rules.map((rule) => ({ ...rule }));
  renderMeta();
  return result;
}

function normalizeSalesTarget(target) {
  return {
    month: String(target?.month || ""),
    targetSales: Number(target?.targetSales || 0),
    updatedAt: target?.updatedAt || "",
    source: target?.source || "admin",
  };
}

function normalizeSalesTargetSupplement(supplement) {
  return {
    id: Number(supplement?.id || 0),
    date: String(supplement?.date || ""),
    month: String(supplement?.month || supplement?.date || "").slice(0, 7),
    amount: Number(supplement?.amount || 0),
    note: supplement?.note || "",
    updatedAt: supplement?.updatedAt || "",
  };
}

function findSalesTarget(month = el.targetMonthInput?.value || localMonth()) {
  return salesTargets.find((target) => target.month === month) || null;
}

function supplementsForTargetMonth(month = el.targetMonthInput?.value || localMonth()) {
  return salesTargetSupplements.filter((supplement) => supplement.month === month);
}

function targetSalesYuan(value) {
  return `${Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}元`;
}

function setSalesTargetStatus(message) {
  if (el.salesTargetStatus) el.salesTargetStatus.textContent = message;
}

function renderSalesTargetPanel() {
  const month = el.targetMonthInput?.value || localMonth();
  const target = findSalesTarget(month);
  const supplements = supplementsForTargetMonth(month);
  const supplementTotal = supplements.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  if (el.targetSalesInput) el.targetSalesInput.value = target ? String(target.targetSales) : "";
  const line = target
    ? `${month} 销售目标${targetSalesYuan(target.targetSales)}[由管理员后台设定]`
    : `${month} 暂未设置销售目标[由管理员后台设定]`;
  if (el.currentSalesTargetLine) el.currentSalesTargetLine.textContent = line;
  if (el.currentSalesTargetStatus) {
    el.currentSalesTargetStatus.textContent = target
      ? `当前月份目标为 ${money(target.targetSales)}，进度补录 ${money(supplementTotal)}，来源为管理员后台设定。`
      : `当前月份还没有保存销售目标；已记录进度补录 ${money(supplementTotal)}。`;
  }
  renderSalesTargetSupplements();
}

async function loadSalesTargets() {
  try {
    const result = await apiFetch("/sales-targets");
    salesTargets = (result.targets || []).map(normalizeSalesTarget).filter((target) => target.month);
    setSalesTargetStatus(salesTargets.length ? `已读取 ${salesTargets.length} 个月销售目标。` : "暂无销售目标，请选择月份并填写金额。");
  } catch (error) {
    salesTargets = [];
    setSalesTargetStatus(`读取销售目标失败：${error.message}`);
  }
  renderSalesTargetPanel();
}

async function saveSalesTarget() {
  const month = el.targetMonthInput?.value || "";
  const targetSales = toManualNumber(el.targetSalesInput?.value);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    setSalesTargetStatus("请选择目标月份。");
    return;
  }
  if (!Number.isFinite(targetSales) || targetSales < 0) {
    setSalesTargetStatus("请填写大于等于 0 的销售目标金额。");
    return;
  }
  setSalesTargetStatus("正在保存销售目标...");
  try {
    const result = await apiFetch("/sales-targets", {
      method: "PUT",
      body: JSON.stringify({ month, targetSales }),
    });
    const saved = normalizeSalesTarget(result.target || { month, targetSales });
    salesTargets = [saved, ...salesTargets.filter((target) => target.month !== saved.month)];
    renderSalesTargetPanel();
    setSalesTargetStatus(`已保存 ${saved.month} 销售目标：${money(saved.targetSales)}。`);
  } catch (error) {
    setSalesTargetStatus(`保存销售目标失败：${error.message}`);
  }
}

async function loadSalesTargetSupplements() {
  try {
    const result = await apiFetch("/sales-target-supplements");
    salesTargetSupplements = (result.supplements || []).map(normalizeSalesTargetSupplement).filter((item) => item.id && item.date);
  } catch (error) {
    salesTargetSupplements = [];
    setSalesTargetStatus(`读取销售额进度补录失败：${error.message}`);
  }
  renderSalesTargetPanel();
}

function renderSalesTargetSupplements() {
  if (!el.salesTargetSupplementBody) return;
  const rows = supplementsForTargetMonth();
  el.salesTargetSupplementBody.innerHTML = rows.length
    ? rows.map((item) => `
      <tr>
        <td>${escapeHtml(item.date)}</td>
        <td class="num">${money(item.amount)}</td>
        <td>${escapeHtml(item.note || "进度补录")}</td>
        <td><button class="row-btn" data-delete-supplement="${escapeHtml(item.id)}" type="button">删除</button></td>
      </tr>
    `).join("")
    : `<tr><td class="empty" colspan="4">当前月份暂无销售额进度补录</td></tr>`;
}

async function saveSalesTargetSupplement() {
  const date = el.supplementDateInput?.value || "";
  const amount = toManualNumber(el.supplementAmountInput?.value);
  const note = el.supplementNoteInput?.value || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    setSalesTargetStatus("请选择补录日期。");
    return;
  }
  if (!Number.isFinite(amount) || amount < 0) {
    setSalesTargetStatus("请填写大于等于 0 的补录销售额。");
    return;
  }
  setSalesTargetStatus("正在保存销售额进度补录...");
  try {
    const result = await apiFetch("/sales-target-supplements", {
      method: "POST",
      body: JSON.stringify({ date, amount, note }),
    });
    const saved = normalizeSalesTargetSupplement(result.supplement);
    salesTargetSupplements = [saved, ...salesTargetSupplements.filter((item) => item.id !== saved.id)];
    if (el.targetMonthInput) el.targetMonthInput.value = saved.month;
    if (el.supplementAmountInput) el.supplementAmountInput.value = "";
    if (el.supplementNoteInput) el.supplementNoteInput.value = "";
    renderSalesTargetPanel();
    setSalesTargetStatus(`已保存 ${saved.date} 销售额进度补录：${money(saved.amount)}。`);
  } catch (error) {
    setSalesTargetStatus(`保存销售额进度补录失败：${error.message}`);
  }
}

async function deleteSalesTargetSupplement(id) {
  try {
    const result = await apiFetch(`/sales-target-supplements/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (result.deleted) salesTargetSupplements = salesTargetSupplements.filter((item) => String(item.id) !== String(id));
    renderSalesTargetPanel();
    setSalesTargetStatus(result.deleted ? "已删除销售额进度补录。" : "未找到要删除的销售额进度补录。");
  } catch (error) {
    setSalesTargetStatus(`删除销售额进度补录失败：${error.message}`);
  }
}

async function previewRuleReset(cleanRules) {
  const effectiveDate = el.ruleEffectiveDate.value || `${localDate()}T00:00`;
  const preview = await apiFetch("/rules/preview", { method: "POST", body: JSON.stringify({ rules: cleanRules, effectiveDate }) });
  pendingRuleSave = { rules: cleanRules, effectiveDate, preview };
  el.ruleImpactPanel.hidden = false;
  el.ruleImpactText.textContent = `从 ${effectiveDate.replace("T", " ")} 起重置会改变 ${preview.affected.orders} 笔订单（${preview.affected.lines || preview.affected.orders} 行）：原提成 ${money(preview.affected.totalBefore)}，新提成 ${money(preview.affected.totalAfter)}，差额 ${money(preview.affected.difference)}。只有点击下方确认按钮才会修改历史。`;
  renderRuleImpactChanges(preview.changes || []);
  setRuleStatus("历史重置影响已列出，请逐条核对变更规则。普通保存不会修改历史订单。");
}
async function forcePendingRules() {
  if (!pendingRuleSave) return;
  setRuleStatus("正在从指定时间重置规则并重算...");
  try {
    const result = await apiFetch("/rules", { method: "PUT", body: JSON.stringify({ rules: pendingRuleSave.rules, effectiveDate: pendingRuleSave.effectiveDate, force: true, confirmationToken: pendingRuleSave.preview.confirmationToken }) });
    rules = (result.rules || pendingRuleSave.rules).map(normalizeCommissionRule).filter((rule) => rule.name);
    ruleDrafts = rules.map((rule) => ({ ...rule }));
    pendingRuleSave = null; el.ruleImpactPanel.hidden = true; renderRules(); refreshDraftCalculations(); renderSaved();
    setRuleStatus(`规则已从 ${result.effectiveFrom} 重置，重算 ${result.affected?.orders || 0} 笔订单。`);
  } catch (error) { setRuleStatus(`重置规则失败：${error.message}`); }
}

function renderRuleImpactChanges(changes) {
  const typeLabels = { added: "新增", deleted: "删除", modified: "修改" };
  el.ruleImpactChanges.innerHTML = changes.map((change) => {
    const fields = (change.fields || []).map((field) => {
      const before = field.before === null || field.before === "" ? "无" : field.before;
      const after = field.after === null || field.after === "" ? "无" : field.after;
      return `<li><strong>${escapeHtml(field.label)}</strong>：${escapeHtml(before)} → ${escapeHtml(after)}</li>`;
    }).join("");
    return `<article class="rule-change-item"><h3>${escapeHtml(change.name || change.id)} <span>${escapeHtml(typeLabels[change.type] || "变更")}</span></h3><p>影响 ${Number(change.affectedOrders || 0)} 笔订单</p><ul>${fields}</ul></article>`;
  }).join("");
}

async function resetServerRules() {
  ruleDrafts = baseCommissionRules().map((rule) => ({ ...rule, source: "数据文件基线" }));
  renderRules();
  setRuleStatus("已载入数据文件基线规则；点击保存后将按版本化流程预览影响。 ");
}

async function loadServerManualEntries() {
  const result = await apiFetch("/manual-orders");
  serverManualEntries = result.entries || [];
}

async function loadShiftShares() {
  try {
    const result = await apiFetch("/shift-shares");
    shiftShareWindows = result.windows || [];
    if (Array.isArray(result.templates) && result.templates.length) shiftTemplates = result.templates;
    if (Array.isArray(result.peaks) && result.peaks.length) peakWindows = result.peaks;
    renderShiftTemplateOptions();
    setShiftShareStatus(shiftShareWindows.length ? "当前班次均分已启用；多人同时在岗时会重分配报表提成。" : "暂无班次均分规则，报表保持原提成归属。");
  } catch (error) {
    shiftShareWindows = [];
    setShiftShareStatus(`读取班次失败：${error.message}`);
  }
}

function cashierCandidates() {
  return Array.from(new Set((window.COMMISSION_DATA?.orders || [])
    .map((order) => String(order.cashier || "").split("/")[0].trim())
    .filter((name) => name && !/^MXA\d+$/i.test(name)))).sort();
}

function localTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function normalizeManualTime(value) {
  const match = String(value || "").trim().replaceAll("：", ":").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function combineDateTime(date, time) {
  const cleanDate = normalizeManualDate(date);
  const cleanTime = normalizeManualTime(time);
  return cleanDate && cleanTime ? `${cleanDate} ${cleanTime}:00` : "";
}

function addLocalDays(dateText, days) {
  const [year, month, day] = String(dateText || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function timeMinutes(value) {
  const time = normalizeManualTime(value);
  if (!time) return NaN;
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function dateTimeForShift(date, time, crossDay = false) {
  const cleanDate = normalizeManualDate(date);
  const cleanTime = normalizeManualTime(time);
  if (!cleanDate || !cleanTime) return "";
  return `${crossDay ? addLocalDays(cleanDate, 1) : cleanDate} ${cleanTime}:00`;
}

function shiftTemplateLabel(shift) {
  const segments = (shift.segments || []).map((segment) => `${segment.start}-${segment.crossDay ? "次日" : ""}${segment.end}`).join("/");
  return `${shift.name}（${shift.type}，${segments}）`;
}

function renderShiftTemplateOptions() {
  if (!el.shiftTemplateSelect) return;
  el.shiftTemplateSelect.innerHTML = shiftTemplates
    .map((shift) => `<option value="${escapeHtml(shift.id)}">${escapeHtml(shiftTemplateLabel(shift))}</option>`)
    .join("");
}

function selectedShiftTemplate() {
  return shiftTemplates.find((shift) => shift.id === el.shiftTemplateSelect?.value) || shiftTemplates[0] || null;
}

function applyShiftTemplate() {
  const shift = selectedShiftTemplate();
  if (!shift || !el.shiftRangeSegments) return;
  el.shiftRangeSegments.value = (shift.segments || [])
    .map((segment) => `${segment.start}-${segment.crossDay ? "次日" : ""}${segment.end}`)
    .join("/");
}

function shiftTemplateById(id) {
  return shiftTemplates.find((shift) => shift.id === id) || null;
}

function scheduleDates() {
  const dates = datesBetween(el.shiftRangeStart?.value, el.shiftRangeEnd?.value);
  return dates.length ? dates.slice(0, 31) : [localDate()];
}

function scheduleCashiers() {
  const names = new Set(cashierCandidates());
  shiftShareWindows.forEach((window) => {
    const name = stripNote(window.cashier || "").split("/")[0].trim();
    if (name) names.add(name);
  });
  scheduleExtraCashiers.forEach((name) => {
    if (name) names.add(name);
  });
  const typed = stripNote(el.shiftRangeCashier?.value || "").split("/")[0].trim();
  if (typed) names.add(typed);
  return Array.from(names).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function segmentKeyFromWindow(window) {
  return [
    normalizeManualTime(window.startTime),
    normalizeManualTime(window.endTime),
    timeMinutes(window.endTime) <= timeMinutes(window.startTime) || Boolean(window.crossDay) ? "1" : "0",
  ].join("|");
}

function segmentKeyFromTemplate(segment) {
  return [
    normalizeManualTime(segment.start),
    normalizeManualTime(segment.end),
    Boolean(segment.crossDay) ? "1" : "0",
  ].join("|");
}

function cellShiftWindows(cashier, date, windows = shiftShareWindows) {
  const cleanCashier = stripNote(cashier);
  const cleanDate = normalizeManualDate(date);
  return windows
    .filter((window) => window.enabled !== false)
    .filter((window) => stripNote(window.cashier) === cleanCashier && normalizeManualDate(window.date) === cleanDate)
    .sort((a, b) => Number(a.segmentIndex || 1) - Number(b.segmentIndex || 1) || String(a.startTime).localeCompare(String(b.startTime)));
}

function shiftChoiceForCell(cashier, date) {
  const windows = cellShiftWindows(cashier, date);
  if (!windows.length) return "off";
  const actual = windows.map(segmentKeyFromWindow).sort();
  const matched = shiftTemplates.find((shift) => {
    const expected = (shift.segments || []).map(segmentKeyFromTemplate).sort();
    return expected.length === actual.length && expected.every((item, index) => item === actual[index]);
  });
  return matched?.id || "custom";
}

function buildShiftWindowsForCell(cashier, date, shift) {
  const cleanCashier = stripNote(cashier);
  const cleanDate = normalizeManualDate(date);
  if (!cleanCashier || !cleanDate || !shift) return [];
  const segments = Array.isArray(shift.segments) ? shift.segments : [];
  return segments.map((segment, index) => ({
    id: `shift-${cleanDate}-${cleanCashier}-${shift.id}-${index + 1}`.replace(/[^\w\u4e00-\u9fa5-]+/g, "-"),
    cashier: cleanCashier,
    shiftName: shift.name,
    shiftType: shift.type,
    segmentIndex: index + 1,
    totalSegments: segments.length,
    crossDay: Boolean(segment.crossDay),
    date: cleanDate,
    startTime: normalizeManualTime(segment.start),
    endTime: normalizeManualTime(segment.end),
    effectiveFrom: `${cleanDate} 00:00:00`,
    enabled: true,
  }));
}

function replaceCellShiftWindows(cashier, date, nextWindows) {
  const cleanCashier = stripNote(cashier);
  const cleanDate = normalizeManualDate(date);
  shiftShareWindows = shiftShareWindows.filter((window) => !(stripNote(window.cashier) === cleanCashier && normalizeManualDate(window.date) === cleanDate));
  shiftShareWindows.push(...nextWindows);
}

function applyScheduleCellShift(cashier, date, shiftId) {
  syncShiftSharesFromDom();
  if (shiftId === "custom") {
    setShiftShareStatus("自定义班次请在下方明细表调整，避免覆盖非模板时段。");
    renderScheduleWorkbench();
    return;
  }
  const shift = shiftTemplateById(shiftId);
  const nextWindows = shiftId === "off" ? [] : buildShiftWindowsForCell(cashier, date, shift);
  replaceCellShiftWindows(cashier, date, nextWindows);
  renderShiftShares();
  setShiftShareStatus(`${date} ${cashier} 已设置为${shift?.name || "休息"}，确认无误后点击保存班次均分。`);
}

function copyPreviousDaySchedule() {
  syncShiftSharesFromDom();
  const dates = scheduleDates();
  const cashiers = scheduleCashiers();
  if (dates.length < 2 || !cashiers.length) {
    setShiftShareStatus("至少需要两个日期和一个员工，才能复制上一日排班。");
    return;
  }
  let copied = 0;
  for (let index = 1; index < dates.length; index += 1) {
    const previousDate = dates[index - 1];
    const targetDate = dates[index];
    cashiers.forEach((cashier) => {
      const choice = shiftChoiceForCell(cashier, previousDate);
      if (choice === "custom") return;
      const shift = shiftTemplateById(choice);
      replaceCellShiftWindows(cashier, targetDate, choice === "off" ? [] : buildShiftWindowsForCell(cashier, targetDate, shift));
      copied += 1;
    });
  }
  renderShiftShares();
  setShiftShareStatus(`已按上一日复制 ${copied} 个排班格子；自定义班次未自动复制。`);
}

function addScheduleCashier() {
  const cashier = stripNote(el.shiftRangeCashier?.value || "").split("/")[0].trim();
  if (!cashier) {
    setShiftShareStatus("请先在收银员输入框填写要加入排班表的员工。");
    return;
  }
  scheduleExtraCashiers.add(cashier);
  renderScheduleWorkbench();
  setShiftShareStatus(`已将 ${cashier} 加入排班工作台，可直接在日期格子里选择班次。`);
}

function shiftCoverageText(window) {
  if (window.startAt && window.endAt) {
    const start = window.startAt.slice(0, 16);
    const end = window.endAt.slice(0, 16);
    return `${start} 至 ${end}`;
  }
  const date = normalizeManualDate(window.date);
  const startTime = normalizeManualTime(window.startTime);
  const endTime = normalizeManualTime(window.endTime);
  if (!date || !startTime || !endTime) return "填写后预览";
  const endDate = endTime <= startTime ? addLocalDays(date, 1) : date;
  const dayLabel = endDate === date ? "当天" : "次日";
  return `${date} ${startTime} 至 ${dayLabel} ${endDate} ${endTime}`;
}

function datesBetween(startDate, endDate) {
  const start = normalizeManualDate(startDate);
  const end = normalizeManualDate(endDate);
  if (!start || !end || start > end) return [];
  const dates = [];
  for (let date = start; date <= end; date = addLocalDays(date, 1)) dates.push(date);
  return dates;
}

function parseShiftSegments(value) {
  return String(value || "")
    .replaceAll("：", ":")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const times = part.match(/\d{1,2}:\d{2}/g) || [];
      if (times.length !== 2) return null;
      const startTime = normalizeManualTime(times[0]);
      const endTime = normalizeManualTime(times[1]);
      const crossDay = /次日|跨天/.test(part) || timeMinutes(endTime) <= timeMinutes(startTime);
      return startTime && endTime ? { startTime, endTime, crossDay } : null;
    })
    .filter(Boolean);
}

function displayTime(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text.slice(11, 16) : "";
}

function renderDatalists() {
  const productNames = Array.from(new Set(rules.map((rule) => rule.name).filter(Boolean))).sort();
  document.querySelector("#productRuleList")?.remove();
  document.querySelector("#cashierList")?.remove();

  const productList = document.createElement("datalist");
  productList.id = "productRuleList";
  productList.innerHTML = productNames.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
  document.body.appendChild(productList);

  const cashierList = document.createElement("datalist");
  cashierList.id = "cashierList";
  cashierList.innerHTML = cashierCandidates().map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
  document.body.appendChild(cashierList);
}

function sampleDraft() {
  const firstRule = rules[0] || {};
  const firstCashier = cashierCandidates()[0] || "";
  return {
    id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date: localDate(),
    time: localTime(),
    productName: firstRule.name || "",
    unitPrice: firstRule.packPrice || "",
    quantity: 1,
    cashier: firstCashier,
    reason: "现金收款",
  };
}

function blankDraft() {
  return {
    id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date: "",
    time: "",
    productName: "",
    unitPrice: "",
    quantity: "",
    cashier: "",
    reason: "",
  };
}

function blankShiftShare() {
  const date = localDate();
  const shift = selectedShiftTemplate() || DEFAULT_SHIFT_TEMPLATES[1];
  const segment = shift.segments[0] || { start: "17:00", end: "03:00", crossDay: true };
  return {
    id: `shift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    cashier: cashierCandidates()[0] || "",
    shiftName: shift.name,
    shiftType: shift.type,
    segmentIndex: 1,
    totalSegments: shift.segments.length,
    crossDay: Boolean(segment.crossDay),
    date,
    startTime: segment.start,
    endTime: segment.end,
    effectiveFrom: `${date}T00:00`,
    enabled: true,
  };
}

function blankRule() {
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    packPrice: "",
    cartonPrice: "",
    commission: "",
    source: "后台维护",
  };
}

function money(value) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

function qty(value) {
  return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function setRuleStatus(message) {
  el.rulesStatus.textContent = message;
}

function setShiftShareStatus(message) {
  el.shiftShareStatus.textContent = message;
}

function setOptionalText(node, value) {
  if (node) node.textContent = value;
}

function renderAdminSummary() {
  setOptionalText(el.adminStatDrafts, String(drafts.length));
  setOptionalText(el.adminStatManuals, String(serverManualEntries.length));
  setOptionalText(el.adminStatShifts, String(shiftShareWindows.length));
  setOptionalText(el.adminStatRules, String(ruleDrafts.length));
}

function renderMeta() {
  const source = serverRuleMeta.error ? `读取服务器规则失败，当前显示数据文件规则：${serverRuleMeta.error}` : `当前使用：${serverRuleMeta.source}`;
  el.serverRuleSource.textContent = source;
  el.dataGeneratedAt.textContent = `生成时间：${window.COMMISSION_DATA?.generatedAt || "-"}`;
  setOptionalText(el.adminRuleSourceLine, serverRuleMeta.error ? "读取失败，已回退数据文件" : serverRuleMeta.source);
  setOptionalText(el.adminGeneratedAt, `数据生成时间：${window.COMMISSION_DATA?.generatedAt || "-"}`);
  renderAdminSummary();
}

function renderMigrationPanel() {
  const legacy = readLegacyLocalRules();
  el.migrationPanel.hidden = !legacy.length;
  el.manualMigrationPanel.hidden = !readManualEntries().length;
}

function readDraftFromRow(row) {
  return {
    id: row.dataset.id,
    date: row.querySelector('[data-field="date"]').value.trim(),
    time: row.querySelector('[data-field="time"]').value.trim(),
    productName: row.querySelector('[data-field="productName"]').value.trim(),
    unitPrice: toManualNumber(row.querySelector('[data-field="unitPrice"]').value),
    quantity: toManualNumber(row.querySelector('[data-field="quantity"]').value),
    cashier: row.querySelector('[data-field="cashier"]').value.trim(),
    reason: row.querySelector('[data-field="reason"]').value.trim(),
  };
}

function readShiftShareFromRow(row) {
  return {
    id: row.dataset.id,
    enabled: row.querySelector('[data-shift-field="enabled"]').checked,
    cashier: row.querySelector('[data-shift-field="cashier"]').value.trim(),
    shiftName: row.dataset.shiftName || "",
    shiftType: row.dataset.shiftType || "",
    segmentIndex: Number(row.dataset.segmentIndex || 1),
    totalSegments: Number(row.dataset.totalSegments || 1),
    crossDay: row.dataset.crossDay === "true",
    date: row.querySelector('[data-shift-field="date"]').value.trim(),
    startTime: row.querySelector('[data-shift-field="startTime"]').value.trim(),
    endTime: row.querySelector('[data-shift-field="endTime"]').value.trim(),
    effectiveFrom: row.querySelector('[data-shift-field="effectiveFrom"]').value.trim(),
  };
}

function readRuleFromRow(row) {
  return {
    id: row.dataset.id,
    name: row.querySelector('[data-rule-field="name"]').value.trim(),
    packPrice: toManualNumber(row.querySelector('[data-rule-field="packPrice"]').value),
    cartonPrice: toManualNumber(row.querySelector('[data-rule-field="cartonPrice"]').value),
    commission: toManualNumber(row.querySelector('[data-rule-field="commission"]').value),
    source: row.dataset.source || "后台维护",
  };
}

function syncDraftsFromDom() {
  drafts = Array.from(el.entryBody.querySelectorAll("tr")).map(readDraftFromRow);
}

function syncRulesFromDom() {
  ruleDrafts = Array.from(el.ruleBody.querySelectorAll("tr")).map(readRuleFromRow);
}

function syncShiftSharesFromDom() {
  shiftShareWindows = Array.from(el.shiftShareBody.querySelectorAll("tr[data-id]")).map(readShiftShareFromRow);
}

function normalizeDraft(draft) {
  return {
    ...draft,
    date: normalizeManualDate(draft.date),
    time: normalizeManualTime(draft.time),
    productName: stripNote(draft.productName),
    unitPrice: toManualNumber(draft.unitPrice),
    quantity: toManualNumber(draft.quantity),
    cashier: stripNote(draft.cashier),
    reason: stripNote(draft.reason),
  };
}

function isValidDraft(draft) {
  const entry = normalizeDraft(draft);
  return entry.date && entry.time && entry.productName && entry.cashier && entry.quantity > 0;
}

function normalizeShiftShare(window) {
  const date = normalizeManualDate(window.date);
  const startTime = normalizeManualTime(window.startTime);
  const endTime = normalizeManualTime(window.endTime);
  const effectiveFrom = String(window.effectiveFrom || "").replace("T", " ");
  const crossDay = timeMinutes(endTime) <= timeMinutes(startTime);
  const segmentIndex = Math.max(1, Number(window.segmentIndex || 1) || 1);
  const totalSegments = Math.max(segmentIndex, Number(window.totalSegments || 1) || 1);
  return {
    id: window.id || `shift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    cashier: stripNote(window.cashier),
    shiftName: stripNote(window.shiftName || ""),
    shiftType: stripNote(window.shiftType || ""),
    segmentIndex,
    totalSegments,
    crossDay,
    date,
    startTime,
    endTime,
    effectiveFrom: effectiveFrom.length === 16 ? `${effectiveFrom}:00` : effectiveFrom,
    enabled: window.enabled !== false,
  };
}

function isValidShiftShare(window) {
  const clean = normalizeShiftShare(window);
  return clean.cashier && clean.date && clean.startTime && clean.endTime && clean.effectiveFrom;
}

function renderRules() {
  el.ruleCount.textContent = `${ruleDrafts.length} 条`;
  el.ruleBody.innerHTML = ruleDrafts.length
    ? ruleDrafts.map(renderRuleRow).join("")
    : `<tr><td class="empty" colspan="6">暂无提成规则，点击“新增规则”添加。</td></tr>`;
  setRuleStatus(serverRuleMeta.hasCustomRules ? "当前使用服务器后台维护规则" : "当前使用 Excel / 数据文件规则");
  renderDatalists();
  renderAdminSummary();
}

function renderRuleRow(rule) {
  return `
    <tr data-id="${escapeHtml(rule.id)}" data-source="${escapeHtml(rule.source || "后台维护")}">
      <td><input data-rule-field="name" value="${escapeHtml(rule.name)}" placeholder="例如：爱喜其它系列" /></td>
      <td><input class="num-input" data-rule-field="packPrice" value="${escapeHtml(rule.packPrice)}" inputmode="decimal" placeholder="包价" /></td>
      <td><input class="num-input" data-rule-field="cartonPrice" value="${escapeHtml(rule.cartonPrice)}" inputmode="decimal" placeholder="条价" /></td>
      <td><input class="num-input" data-rule-field="commission" value="${escapeHtml(rule.commission)}" inputmode="decimal" placeholder="提成" /></td>
      <td><span class="match-badge">${escapeHtml(rule.source || "后台维护")}</span></td>
      <td><button class="row-btn" data-remove-rule="${escapeHtml(rule.id)}" type="button">删除</button></td>
    </tr>
  `;
}

function addRuleRow() {
  syncRulesFromDom();
  ruleDrafts.unshift(blankRule());
  renderRules();
}

function removeRuleRow(id) {
  syncRulesFromDom();
  ruleDrafts = ruleDrafts.filter((rule) => rule.id !== id);
  renderRules();
  refreshDraftCalculations();
}

function collectRuleDrafts() {
  syncRulesFromDom();
  const seen = new Set();
  const cleanRules = [];
  ruleDrafts.forEach((rule, index) => {
    const clean = normalizeCommissionRule({ ...rule, source: "后台维护" }, index);
    if (!clean.name || seen.has(clean.name)) return;
    seen.add(clean.name);
    cleanRules.push(clean);
  });
  return cleanRules;
}

async function saveRuleRows() {
  const cleanRules = collectRuleDrafts();
  if (!cleanRules.length) {
    setRuleStatus("请至少保留一条有效规则。");
    return;
  }
  setRuleStatus("正在保存服务器规则并重建数据...");
  try {
    const result = await saveServerRules(cleanRules);
    renderRules();
    refreshDraftCalculations();
    renderSaved();
    setRuleStatus(`已保存 ${rules.length} 条规则，从 ${result.effectiveFrom} 起影响新订单；历史订单未改变。`);
  } catch (error) {
    setRuleStatus(error.code === "RULE_VERSION_CONFLICT" ? error.message : `保存失败：${error.message}`);
  }
}

async function previewResetRuleRows() {
  const cleanRules = collectRuleDrafts();
  if (!cleanRules.length) {
    setRuleStatus("请至少保留一条有效规则。");
    return;
  }
  setRuleStatus("正在计算历史重置影响...");
  try {
    await previewRuleReset(cleanRules);
  } catch (error) {
    setRuleStatus(`影响预览失败：${error.message}`);
  }
}
async function resetRuleRows() {
  setRuleStatus("正在恢复 Excel / 数据文件规则...");
  try {
    await resetServerRules();
    renderRules();
    refreshDraftCalculations();
    renderSaved();
    setRuleStatus("已恢复为 Excel / 数据文件规则。");
  } catch (error) {
    setRuleStatus(`恢复失败：${error.message}`);
  }
}

async function importLegacyRules() {
  const legacy = readLegacyLocalRules();
  if (!legacy.length) return;
  setRuleStatus("正在导入旧版浏览器本地规则...");
  try {
    await saveServerRules(legacy.map((rule, index) => normalizeCommissionRule({ ...rule, source: "后台维护" }, index)));
    clearLegacyLocalRules();
    renderRules();
    renderMigrationPanel();
    refreshDraftCalculations();
    renderSaved();
    setRuleStatus(`已导入 ${rules.length} 条规则到服务器。`);
  } catch (error) {
    setRuleStatus(`导入失败：${error.message}`);
  }
}

async function importLocalManualEntries({ automatic = false } = {}) {
  if (manualMigrationInProgress) return;
  const entries = readManualEntries();
  if (!entries.length) return;
  manualMigrationInProgress = true;
  setRuleStatus("正在导入浏览器本地手工记录...");
  try {
    const result = await apiFetch("/manual-orders", { method: "POST", body: JSON.stringify({ entries }) });
    serverManualEntries = result.entries || [];
    saveManualEntries([]); renderSaved(); renderMigrationPanel();
    setRuleStatus(`${automatic ? "已自动迁移" : "已迁移"} ${result.imported} 条手工记录到服务器 SQLite 台账。`);
  } catch (error) {
    setRuleStatus(`手工记录迁移失败，本地记录仍保留：${error.message}`);
  } finally {
    manualMigrationInProgress = false;
  }
}

function exportRules() {
  syncRulesFromDom();
  const rows = [["商品名/系列名", "包价", "条价", "提成/包", "来源"]];
  ruleDrafts.forEach((rule) => rows.push([rule.name, rule.packPrice, rule.cartonPrice, rule.commission, rule.source || "后台维护"]));
  downloadCsv("外烟提成规则清单.csv", rows);
}

function shiftWindowBounds(window) {
  const date = normalizeManualDate(window.date);
  const startTime = normalizeManualTime(window.startTime);
  const endTime = normalizeManualTime(window.endTime);
  if (!date || !startTime || !endTime) return null;
  const crossDay = Boolean(window.crossDay) || timeMinutes(endTime) <= timeMinutes(startTime);
  return {
    ...window,
    date,
    startAt: window.startAt || dateTimeForShift(date, startTime, false),
    endAt: window.endAt || dateTimeForShift(date, endTime, crossDay),
  };
}

function shiftCoverageRowsForDate(date, windows) {
  const cleanDate = normalizeManualDate(date) || localDate();
  const boundedWindows = windows
    .map(normalizeShiftShare)
    .map(shiftWindowBounds)
    .filter(Boolean)
    .filter((window) => window.enabled !== false);
  return peakWindows.map((peak) => {
    const startAt = dateTimeForShift(cleanDate, peak.start, false);
    const endAt = dateTimeForShift(cleanDate, peak.end, Boolean(peak.crossDay));
    const seen = new Set();
    const cashiers = [];
    boundedWindows.forEach((window) => {
      if (window.startAt > startAt || window.endAt < endAt) return;
      const cashier = stripNote(window.cashier).split("/")[0].trim();
      if (!cashier || seen.has(cashier)) return;
      seen.add(cashier);
      cashiers.push(cashier);
    });
    const required = Number(peak.requiredStaff || 2);
    const status = cashiers.length >= required ? "覆盖充足" : cashiers.length ? "人手不足" : "无人覆盖";
    return { peak, startAt, endAt, cashiers, required, status };
  });
}

function renderShiftCoverage() {
  if (!el.shiftCoverageBody) return;
  const date = normalizeManualDate(el.shiftRangeStart?.value) || localDate();
  const rows = shiftCoverageRowsForDate(date, shiftShareWindows);
  el.shiftCoverageBody.innerHTML = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.peak.name)}</td>
      <td>${escapeHtml(row.startAt.slice(11, 16))} - ${escapeHtml(row.peak.crossDay ? "次日" : "")}${escapeHtml(row.endAt.slice(11, 16))}</td>
      <td>${row.cashiers.length}/${row.required}</td>
      <td>${escapeHtml(row.cashiers.join("、") || "暂无")}</td>
      <td><span class="match-badge">${escapeHtml(row.status)}</span></td>
    </tr>
  `).join("");
}

function renderScheduleCoverageGrid() {
  if (!el.scheduleCoverageGrid) return;
  const dates = scheduleDates();
  el.scheduleCoverageGrid.innerHTML = dates.map((date) => {
    const rows = shiftCoverageRowsForDate(date, shiftShareWindows);
    return `
      <section class="schedule-coverage-card">
        <strong>${escapeHtml(date.slice(5))}</strong>
        ${rows.map((row) => `
          <div class="coverage-pill ${row.cashiers.length >= row.required ? "is-covered" : "is-under"}">
            <span>${escapeHtml(row.peak.name)}</span>
            <b>${row.cashiers.length}/${row.required}</b>
          </div>
        `).join("")}
      </section>
    `;
  }).join("");
}

function renderScheduleWorkbench() {
  if (!el.scheduleMatrixHead || !el.scheduleMatrixBody) return;
  const dates = scheduleDates();
  const cashiers = scheduleCashiers();
  const options = [
    { id: "off", name: "休息" },
    ...shiftTemplates.map((shift) => ({ id: shift.id, name: shift.name })),
    { id: "custom", name: "自定义" },
  ];
  el.scheduleMatrixHead.innerHTML = `
    <tr>
      <th>员工</th>
      ${dates.map((date) => `<th>${escapeHtml(date.slice(5))}</th>`).join("")}
    </tr>
  `;
  el.scheduleMatrixBody.innerHTML = cashiers.length
    ? cashiers.map((cashier) => `
      <tr>
        <th>${escapeHtml(cashier)}</th>
        ${dates.map((date) => {
          const choice = shiftChoiceForCell(cashier, date);
          return `
            <td class="schedule-cell schedule-cell-${escapeHtml(choice)}" data-schedule-cell="${escapeHtml(cashier)}|${escapeHtml(date)}">
              <select data-shift-choice data-cashier="${escapeHtml(cashier)}" data-date="${escapeHtml(date)}" aria-label="${escapeHtml(cashier)} ${escapeHtml(date)} 班次">
                ${options.map((option) => `<option value="${escapeHtml(option.id)}" ${option.id === choice ? "selected" : ""}>${escapeHtml(option.name)}</option>`).join("")}
              </select>
            </td>
          `;
        }).join("")}
      </tr>
    `).join("")
    : `<tr><td class="empty" colspan="${dates.length + 1}">请在收银员输入框填写员工后点击“加入员工”。</td></tr>`;
  renderScheduleCoverageGrid();
}

function renderDrafts() {
  el.draftCount.textContent = `${drafts.length} 行`;
  el.entryBody.innerHTML = drafts.map(renderDraftRow).join("");
  refreshDraftCalculations();
  renderAdminSummary();
}

function renderDraftRow(draft) {
  return `
    <tr data-id="${escapeHtml(draft.id)}">
      <td><input data-field="date" value="${escapeHtml(draft.date)}" placeholder="2026.6.9" /></td>
      <td><input data-field="time" type="time" value="${escapeHtml(draft.time || displayTime(draft.checkoutTime))}" /></td>
      <td><input data-field="productName" value="${escapeHtml(draft.productName)}" placeholder="选择或输入商品名" list="productRuleList" autocomplete="off" /></td>
      <td><input class="num-input" data-field="unitPrice" value="${escapeHtml(draft.unitPrice)}" inputmode="decimal" placeholder="22" /></td>
      <td><input class="num-input" data-field="quantity" value="${escapeHtml(draft.quantity)}" inputmode="decimal" placeholder="1" /></td>
      <td><input data-field="cashier" value="${escapeHtml(draft.cashier)}" placeholder="选择订单里的收银员" list="cashierList" autocomplete="off" /></td>
      <td><input data-field="reason" value="${escapeHtml(draft.reason)}" placeholder="现金收款" /></td>
      <td data-preview="rule">待填写</td>
      <td class="num" data-preview="commission">¥0.00</td>
      <td><button class="row-btn" data-remove-draft="${escapeHtml(draft.id)}" type="button">删除</button></td>
    </tr>
  `;
}

function renderShiftShares() {
  el.shiftShareCount.textContent = `${shiftShareWindows.length} 条`;
  el.shiftShareBody.innerHTML = shiftShareWindows.length
    ? shiftShareWindows.map(renderShiftShareRow).join("")
    : `<tr><td class="empty" colspan="11">暂无班次均分规则，点击“新增班次”添加。</td></tr>`;
  renderShiftCoverage();
  renderScheduleWorkbench();
  renderAdminSummary();
}

function renderShiftShareRow(window) {
  const effectiveValue = String(window.effectiveFrom || "").replace(" ", "T").slice(0, 16);
  const coverage = shiftCoverageText(window);
  const segmentText = `${Number(window.segmentIndex || 1)}/${Number(window.totalSegments || 1)}`;
  return `
    <tr data-id="${escapeHtml(window.id)}" data-shift-name="${escapeHtml(window.shiftName || "")}" data-shift-type="${escapeHtml(window.shiftType || "")}" data-segment-index="${escapeHtml(window.segmentIndex || 1)}" data-total-segments="${escapeHtml(window.totalSegments || 1)}" data-cross-day="${window.crossDay ? "true" : "false"}">
      <td><input data-shift-field="enabled" type="checkbox" ${window.enabled !== false ? "checked" : ""} /></td>
      <td><input data-shift-field="cashier" value="${escapeHtml(window.cashier)}" placeholder="选择收银员" list="cashierList" autocomplete="off" /></td>
      <td>${escapeHtml(window.shiftName || "自定义班次")}</td>
      <td>${escapeHtml(window.shiftType || (Number(window.totalSegments || 1) > 1 ? "分段班" : "连续班"))}</td>
      <td>${escapeHtml(segmentText)}</td>
      <td><input data-shift-field="date" type="date" value="${escapeHtml(window.date)}" /></td>
      <td><input data-shift-field="startTime" type="time" value="${escapeHtml(window.startTime)}" /></td>
      <td><input data-shift-field="endTime" type="time" value="${escapeHtml(window.endTime)}" /></td>
      <td><input data-shift-field="effectiveFrom" type="datetime-local" value="${escapeHtml(effectiveValue)}" /></td>
      <td>${escapeHtml(coverage)}</td>
      <td><button class="row-btn" data-remove-shift="${escapeHtml(window.id)}" type="button">删除</button></td>
    </tr>
  `;
}

function fillPriceFromRule(input) {
  const row = input.closest("tr");
  const priceInput = row?.querySelector('[data-field="unitPrice"]');
  const rule = rules.find((item) => item.name === input.value.trim());
  if (rule && priceInput && !priceInput.value.trim()) {
    priceInput.value = rule.packPrice || "";
  }
}

function refreshDraftCalculations() {
  Array.from(el.entryBody.querySelectorAll("tr")).forEach((row) => {
    const draft = normalizeDraft(readDraftFromRow(row));
    const order = manualEntryToOrder(
      {
        ...draft,
        id: draft.id || row.dataset.id,
        createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      },
      rules,
    );
    row.querySelector('[data-preview="rule"]').textContent = order.ruleName || "待补规则";
    row.querySelector('[data-preview="commission"]').textContent = money(order.commission);
  });
}

function addDraftRow() {
  syncDraftsFromDom();
  drafts.push(blankDraft());
  renderDrafts();
}

function removeDraftRow(id) {
  syncDraftsFromDom();
  drafts = drafts.filter((draft) => draft.id !== id);
  if (!drafts.length) drafts = [blankDraft()];
  renderDrafts();
}

async function saveDraftRows() {
  syncDraftsFromDom();
  const entries = drafts.filter(isValidDraft).map((draft) => ({
    ...normalizeDraft(draft),
    checkoutTime: combineDateTime(draft.date, draft.time),
    id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
  }));
  if (!entries.length) return;
  try {
    const result = await apiFetch("/manual-orders", { method: "POST", body: JSON.stringify({ entries }) });
    serverManualEntries = result.entries || [];
    drafts = [blankDraft()]; renderDrafts(); renderSaved();
  } catch (error) { setRuleStatus(`手工记录保存失败：${error.message}`); }
}

function addShiftShareRow() {
  syncShiftSharesFromDom();
  shiftShareWindows.push(blankShiftShare());
  renderShiftShares();
}

function generateShiftRangeRows() {
  syncShiftSharesFromDom();
  const cashier = stripNote(el.shiftRangeCashier.value);
  const dates = datesBetween(el.shiftRangeStart.value, el.shiftRangeEnd.value);
  const segments = parseShiftSegments(el.shiftRangeSegments.value);
  const effectiveFrom = String(el.shiftRangeEffective.value || `${el.shiftRangeStart.value}T00:00`).replace("T", " ");
  const selectedShift = selectedShiftTemplate();
  const shiftName = selectedShift?.name || "自定义班次";
  const shiftType = selectedShift?.type || (segments.length > 1 ? "分段班" : "连续班");
  if (!cashier || !dates.length || !segments.length || !effectiveFrom) {
    setShiftShareStatus("请填写起始日期、结束日期、收银员、班次时段和订单生效时间。");
    return;
  }
  const seen = new Set(shiftShareWindows.map((item) => [
    stripNote(item.cashier),
    normalizeManualDate(item.date),
    normalizeManualTime(item.startTime),
    normalizeManualTime(item.endTime),
    String(item.effectiveFrom || "").replace("T", " "),
  ].join("|")));
  const generated = [];
  for (const date of dates) {
    segments.forEach((segment, index) => {
      const key = [cashier, date, segment.startTime, segment.endTime, effectiveFrom].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      generated.push({
        id: `shift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index + 1}`,
        cashier,
        shiftName,
        shiftType,
        segmentIndex: index + 1,
        totalSegments: segments.length,
        crossDay: Boolean(segment.crossDay),
        date,
        startTime: segment.startTime,
        endTime: segment.endTime,
        effectiveFrom: effectiveFrom.length === 16 ? `${effectiveFrom}:00` : effectiveFrom,
        enabled: true,
      });
    });
  }
  shiftShareWindows.push(...generated);
  renderShiftShares();
  setShiftShareStatus(generated.length ? `已生成 ${generated.length} 条班次，核对后点击保存班次均分。` : "没有新增班次；相同收银员、日期、时段已存在。");
}

function removeShiftShareRow(id) {
  syncShiftSharesFromDom();
  shiftShareWindows = shiftShareWindows.filter((window) => window.id !== id);
  renderShiftShares();
}

async function saveShiftShareRows() {
  syncShiftSharesFromDom();
  const windows = shiftShareWindows.filter(isValidShiftShare).map(normalizeShiftShare);
  setShiftShareStatus("正在保存班次均分规则...");
  try {
    const result = await apiFetch("/shift-shares", { method: "PUT", body: JSON.stringify({ windows }) });
    shiftShareWindows = result.windows || [];
    renderShiftShares();
    setShiftShareStatus(`已保存 ${shiftShareWindows.length} 条班次；多人同时在岗的订单会在报表中均分。`);
  } catch (error) {
    setShiftShareStatus(`保存班次失败：${error.message}`);
  }
}

function renderSaved() {
  const entries = serverManualEntries;
  el.savedCount.textContent = `${entries.length} 行`;
  el.savedBody.innerHTML = entries.length
    ? entries.map(renderSavedRow).join("")
    : `<tr><td class="empty" colspan="10">暂无手工记录</td></tr>`;
  renderAdminSummary();
}

function renderSavedRow(entry) {
  return `
    <tr>
      <td>${escapeHtml(entry.date)}</td>
      <td>${escapeHtml(displayTime(entry.checkoutTime) || "无精确时间")}</td>
      <td>${escapeHtml(entry.productName)}</td>
      <td class="num">${money(entry.unitPrice)}</td>
      <td class="num">${qty(entry.quantity)}</td>
      <td>${escapeHtml(entry.cashier)}</td>
      <td>${escapeHtml(entry.reason)}</td>
      <td>${escapeHtml(entry.ruleName || "待补规则")}</td>
      <td class="num"><strong>${money(entry.commission)}</strong></td>
      <td><button class="row-btn" data-delete="${escapeHtml(entry.id)}" type="button">删除</button></td>
    </tr>
  `;
}

async function deleteEntry(id) {
  try {
    await apiFetch(`/manual-orders/${encodeURIComponent(id)}`, { method: "DELETE" });
    serverManualEntries = serverManualEntries.filter((entry) => entry.id !== id); renderSaved();
  } catch (error) { setRuleStatus(`删除失败：${error.message}`); }
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportManual() {
  const entries = serverManualEntries;
  const rows = [["日期", "成交时间", "商品", "单价", "计提包数", "收银员", "事由", "匹配规则", "提成"]];
  entries.forEach((entry) => {
    rows.push([entry.date, displayTime(entry.checkoutTime), entry.productName, entry.unitPrice, entry.quantity, entry.cashier, entry.reason, entry.ruleName || "待补规则", entry.commission]);
  });
  downloadCsv("手工提成记录.csv", rows);
}

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.loginStatus.textContent = "正在验证...";
  try {
    await login(el.passwordInput.value);
    el.passwordInput.value = "";
  } catch (error) {
    el.loginStatus.textContent = error.message || "密码错误";
  }
});
el.logoutBtn.addEventListener("click", logout);
el.importLocalRulesBtn.addEventListener("click", importLegacyRules);
el.importLocalManualBtn.addEventListener("click", importLocalManualEntries);
el.saveSalesTargetBtn.addEventListener("click", saveSalesTarget);
el.saveSupplementBtn.addEventListener("click", saveSalesTargetSupplement);
el.targetMonthInput.addEventListener("change", renderSalesTargetPanel);
el.salesTargetSupplementBody?.addEventListener("click", (event) => {
  const id = event.target?.dataset?.deleteSupplement;
  if (id) deleteSalesTargetSupplement(id);
});
el.addRuleBtn.addEventListener("click", addRuleRow);
el.saveRulesBtn.addEventListener("click", saveRuleRows);
el.previewResetRulesBtn.addEventListener("click", previewResetRuleRows);
el.resetRulesBtn.addEventListener("click", resetRuleRows);
el.exportRulesBtn.addEventListener("click", exportRules);
el.forceRulesBtn.addEventListener("click", forcePendingRules);
el.cancelForceRulesBtn.addEventListener("click", () => { pendingRuleSave = null; el.ruleImpactPanel.hidden = true; setRuleStatus("已取消规则覆盖。"); });
el.shiftTemplateSelect?.addEventListener("change", applyShiftTemplate);
el.shiftRangeStart?.addEventListener("change", () => { renderShiftCoverage(); renderScheduleWorkbench(); });
el.shiftRangeEnd?.addEventListener("change", () => { renderShiftCoverage(); renderScheduleWorkbench(); });
el.addScheduleCashierBtn?.addEventListener("click", addScheduleCashier);
el.copyPreviousDayBtn?.addEventListener("click", copyPreviousDaySchedule);
el.generateShiftRangeBtn.addEventListener("click", generateShiftRangeRows);
el.addShiftShareBtn.addEventListener("click", addShiftShareRow);
el.saveShiftSharesBtn.addEventListener("click", saveShiftShareRows);
el.scheduleMatrixBody?.addEventListener("change", (event) => {
  if (!event.target?.matches?.("[data-shift-choice]")) return;
  applyScheduleCellShift(event.target.dataset.cashier, event.target.dataset.date, event.target.value);
});
el.shiftShareBody.addEventListener("click", (event) => {
  const id = event.target?.dataset?.removeShift;
  if (id) removeShiftShareRow(id);
});
el.shiftShareBody.addEventListener("input", () => {
  syncShiftSharesFromDom();
  renderShiftCoverage();
  renderScheduleWorkbench();
});
el.ruleBody.addEventListener("click", (event) => {
  const id = event.target?.dataset?.removeRule;
  if (id) removeRuleRow(id);
});
el.ruleBody.addEventListener("input", () => {
  syncRulesFromDom();
  rules = ruleDrafts.map(normalizeCommissionRule).filter((rule) => rule.name);
  refreshDraftCalculations();
});

el.addRowBtn.addEventListener("click", addDraftRow);
el.saveRowsBtn.addEventListener("click", saveDraftRows);
el.exportBtn.addEventListener("click", exportManual);
el.entryBody.addEventListener("input", refreshDraftCalculations);
el.entryBody.addEventListener("change", (event) => {
  if (event.target?.dataset?.field === "productName") {
    fillPriceFromRule(event.target);
    refreshDraftCalculations();
  }
});
el.entryBody.addEventListener("click", (event) => {
  const id = event.target?.dataset?.removeDraft;
  if (id) removeDraftRow(id);
});
el.savedBody.addEventListener("click", (event) => {
  const id = event.target?.dataset?.delete;
  if (id) deleteEntry(id);
});

checkSession();
