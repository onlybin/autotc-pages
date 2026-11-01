/* 员工提成排行榜：数据全部来自 /autotc/api/leaderboard（现有提成台账同一口径） */
const lbApiBase = location.protocol === "file:" ? "" : "/autotc/api";

const lbQuery = new URLSearchParams(location.search);
const lbState = { month: lbQuery.get("month") || "", store: lbQuery.get("store") || "" };
let lbData = null;
let lbReqSeq = 0;

const lbEl = Object.fromEntries(
  ["lbMonth", "lbStore", "lbRows", "lbBoardSub", "lbTotal", "lbTrend", "lbGoalPercent", "lbGoalBar", "lbGoalNums", "lbGoalHint", "lbDetailBtn",
   "lbGoalRule", "lbGoalRuleTag", "lbGoalRuleList", "lbGoalRuleNote"]
    .map((id) => [id, document.getElementById(id)])
);

const lbAliases = { 陈漠莉: "陈漫莉" };
const lbName = (value) => lbAliases[String(value || "").split("/")[0].trim()] || String(value || "").split("/")[0].trim() || "未记录";

/**
 * 只展示「中文姓名」的收银员。
 *
 * 背景：台账的 cashier 字段里混有把手机号当姓名的脏数据（如 19557933364），
 * 排行榜会把它当成一名员工渲染出来（0 元、1 单）。按姓名形态过滤比写死人名更稳：
 * 真员工（刘超霞、陈漫莉…）照常显示，手机号 / 编号 / 英文名一律不显示。
 *
 * - 允许「阿依古丽·买买提」这类带间隔号的名字。
 * - LB_VISIBLE_NAMES 留空 = 只按姓名形态过滤；填入名字可额外限定到具体某人。
 * - 顶部「本月总提成」是门店级指标（summary.periodTotalCommission），不受本过滤影响。
 */
const LB_NAME_RE = /^[\u4e00-\u9fa5]{2,12}(?:[·•][\u4e00-\u9fa5]{1,12})?$/;
const LB_VISIBLE_NAMES = [];

function lbVisibleEmployees(employees) {
  return (employees || []).filter((person) => {
    const name = lbName(person.name);
    if (LB_VISIBLE_NAMES.length && !LB_VISIBLE_NAMES.includes(name)) return false;
    return LB_NAME_RE.test(name);
  });
}
const lbMoney = (value) => `¥ ${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lbEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const AVATAR_COLORS = [
  ["#5ea8f5", "#0b63ce"], ["#f7b733", "#e07b0e"], ["#8e9df5", "#4a5fd0"],
  ["#5fd0a5", "#0e9d70"], ["#f58ea8", "#d13d63"], ["#9b8ef5", "#6246d0"],
];
const avatarColor = (name) => {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
};

async function lbApi(path) {
  const response = await fetch(`${lbApiBase}${path}`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.message || `请求失败：${response.status}`);
  return payload;
}

function renderSkeleton() {
  lbEl.lbRows.innerHTML = Array.from({ length: 6 }, () => `
    <div class="lb-skel-row">
      <span class="lb-skel" style="width:26px"></span>
      <span style="display:flex;gap:12px;align-items:center"><span class="lb-skel circle"></span><span class="lb-skel" style="width:90px"></span></span>
      <span class="lb-skel" style="width:80px"></span>
      ${LB_SHOW_TOTAL_COMMISSION ? '<span class="lb-skel" style="width:80px"></span>' : ""}
      <span class="lb-skel"></span>
    </div>`).join("");
}

function renderState(kind, message) {
  const retry = kind === "error" ? `<button type="button" id="lbRetry">重试</button>` : "";
  lbEl.lbRows.innerHTML = `<div class="lb-state">${lbEscape(message)}<br>${retry}</div>`;
  document.getElementById("lbRetry")?.addEventListener("click", loadLeaderboard);
}

function medalHtml(rank) {
  if (rank <= 3) return `<span class="lb-medal g${rank}">${rank}</span>`;
  return `<span class="lb-rank-num">${rank}</span>`;
}

function progressHtml(person) {
  if (person.progressPercent === null || person.progressPercent === undefined || !Number.isFinite(Number(person.progressPercent))) {
    return `<span class="lb-progress-none">暂未设置目标</span>`;
  }
  const pct = Number(person.progressPercent);
  const width = Math.max(0, Math.min(100, pct));
  return `
    <div class="lb-progress" role="progressbar" aria-valuenow="${pct.toFixed(1)}" aria-valuemin="0" aria-valuemax="100"
         title="个人本月计提销售额 / 门店月销售目标">
      <div class="lb-progress-fill" style="width:${width}%"></div>
    </div>
    <span class="lb-progress-pct">${pct.toFixed(0)}%</span>`;
}

function renderRows(employees) {
  const top = employees.slice(0, 10);
  lbEl.lbBoardSub.textContent = `TOP ${top.length} ｜ 本月提成排名${employees.length > 10 ? `（共 ${employees.length} 人，仅展示前 10）` : ""}`;
  if (!top.length) {
    renderState("empty", "当前筛选条件下暂无提成数据，请尝试切换月份或门店。");
    return;
  }
  lbEl.lbRows.innerHTML = top.map((person, index) => {
    const name = lbName(person.name);
    const [c1, c2] = avatarColor(name);
    // 名次按过滤后的顺序重排：服务端 rank 是全量口径，过滤掉脏数据后会出现空号
    const rank = index + 1;
    return `
    <div class="lb-row ${rank === 1 ? "lb-top1" : ""}" role="row">
      <span class="lb-rank">${medalHtml(rank)}</span>
      <span class="lb-person">
        <span class="lb-avatar" style="background:linear-gradient(140deg,${c1},${c2})">${lbEscape(name.slice(0, 1))}</span>
        <span class="lb-person-meta"><b>${lbEscape(name)}</b><small>店员 · ${person.orderCount} 单</small></span>
      </span>
      <span class="lb-money month"><b>${lbMoney(person.currentPeriodCommission)}</b></span>
      ${LB_SHOW_TOTAL_COMMISSION ? `<span class="lb-money total">${lbMoney(person.cumulativeCommission)}</span>` : ""}
      <span class="lb-progress-cell">${progressHtml(person)}</span>
    </div>`;
  }).join("");
}

/**
 * 是否在排行榜上展示"总提成"。
 *
 * 店主要求隐藏，故为 false。关闭时同时隐藏两处：
 *   1. 顶部"本月总提成"卡片
 *   2. 表格里的"总提成"列（累计总提成）
 * 改回 true 即恢复，排版会随 body.lb-hide-total 自动切换，无需改其它代码。
 */
const LB_SHOW_TOTAL_COMMISSION = false;

function applyTotalCommissionVisibility() {
  if (LB_SHOW_TOTAL_COMMISSION) return;
  document.body.classList.add("lb-hide-total");
  lbEl.lbTotal?.closest(".lb-card-total")?.remove();
  document.querySelector('.lb-thead [data-col="total"]')?.remove();
}

/** 提成发放档位，与后端 salesTargetCommissionPayout() 一一对应，改动需两边同步 */
const LB_PAYOUT_TIERS = [
  { min: 0, max: 60, rate: 0, label: "不足 60%" },
  { min: 60, max: 81, rate: 70, label: "60%–80%" },
  { min: 81, max: 91, rate: 90, label: "81%–90%" },
  { min: 91, max: 111, rate: 100, label: "91%–110%" },
  { min: 111, max: 131, rate: 110, label: "111%–130%" },
  { min: 131, max: 151, rate: 120, label: "131%–150%" },
  { min: 151, max: Infinity, rate: 130, label: "超过 150%" },
];

function lbPayoutTier(percent) {
  const value = Number(percent) || 0;
  return LB_PAYOUT_TIERS.find((tier) => value >= tier.min && value < tier.max) || LB_PAYOUT_TIERS[LB_PAYOUT_TIERS.length - 1];
}

/** 在销售目标区域展示"按达成率发放"的规则与当前所处档位 */
function renderGoalRule(summary) {
  const data = summary || {};
  if (!lbEl.lbGoalRule) return;
  const configured = Boolean(data.targetConfigured) && Number(data.periodTargetSales) > 0;
  if (!configured) {
    lbEl.lbGoalRule.hidden = true;
    return;
  }
  const percent = Number(data.periodProgressPercent) || 0;
  const active = lbPayoutTier(percent);
  // 当月只提示、不真正调整；历史完整月份才按档位结算（后端 appliesCommissionPayout 的语义）
  const hintOnly = String(data.commissionPolicyText || "").startsWith("当前月只提示");
  lbEl.lbGoalRule.hidden = false;
  lbEl.lbGoalRuleTag.textContent = hintOnly
    ? `达成 ${percent.toFixed(2)}% → ${active.label}（本月仅提示，次月按此档结算）`
    : `达成 ${percent.toFixed(2)}% → ${active.label}，按 ${active.rate}% 发放`;
  lbEl.lbGoalRuleList.innerHTML = LB_PAYOUT_TIERS.map(
    (tier) => `<li class="${tier === active ? "is-active" : ""}"><span>${tier.label}</span><b>${tier.rate}%</b></li>`,
  ).join("");
  lbEl.lbGoalRuleNote.textContent = String(data.commissionPolicyText || "");
}

function renderSummary(summary) {
  const data = summary || {};
  lbEl.lbTotal.textContent = lbMoney(data.periodTotalCommission);
  if (data.previousPeriodCommission !== null && data.previousPeriodCommission !== undefined && data.changePercent !== null) {
    const pct = Number(data.changePercent);
    const arrow = pct >= 0 ? "▲" : "▼";
    lbEl.lbTrend.innerHTML = `<b>${arrow} 较上月 ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</b>`;
  } else {
    lbEl.lbTrend.textContent = "";
  }
  const goalBar = lbEl.lbGoalBar.closest(".lb-progress");
  if (data.targetConfigured && Number(data.periodTargetSales) > 0) {
    const pct = Number(data.periodProgressPercent) || 0;
    lbEl.lbGoalPercent.textContent = `${pct.toFixed(0)}%`;
    lbEl.lbGoalBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    goalBar?.setAttribute("aria-valuenow", pct.toFixed(1));
    lbEl.lbGoalNums.textContent = `${lbMoney(data.periodActualSales)} / ${lbMoney(data.periodTargetSales)}`;
    lbEl.lbGoalHint.textContent = pct >= 100
      ? `已超过目标 ${lbMoney(data.exceededTarget)}！保持领先，冲刺更高奖励！`
      : `距离目标还差 ${lbMoney(data.remainingTarget)}！再接再厉，冲刺更高奖励！`;
  } else {
    lbEl.lbGoalPercent.textContent = "--";
    lbEl.lbGoalBar.style.width = "0";
    goalBar?.setAttribute("aria-valuenow", "0");
    lbEl.lbGoalNums.textContent = `${lbMoney(data.periodActualSales)} / 未设置`;
    lbEl.lbGoalHint.textContent = "暂未设置本月销售目标，请先在后台管理中设定。";
  }
  renderGoalRule(data);
}

function renderFilters() {
  const months = lbData.months || [];
  lbEl.lbMonth.innerHTML = months.map((m) => `<option value="${lbEscape(m)}">${lbEscape(m)}</option>`).join("");
  lbEl.lbMonth.value = lbData.month;
  const stores = lbData.stores || [];
  if (stores.length <= 1) {
    lbEl.lbStore.innerHTML = `<option>${lbEscape(stores[0] || "鸿湖罗森便利店")}</option>`;
    lbEl.lbStore.disabled = true;
  } else {
    lbEl.lbStore.innerHTML = [`<option value="">全部门店</option>`, ...stores.map((s) => `<option value="${lbEscape(s)}">${lbEscape(s)}</option>`)].join("");
    lbEl.lbStore.value = lbData.store || "";
    lbEl.lbStore.disabled = false;
  }
  lbEl.lbDetailBtn.href = `orders.html?month=${encodeURIComponent(lbData.month)}#detailPanel`;
}

async function loadLeaderboard() {
  if (!lbApiBase) {
    renderState("error", "请通过系统服务地址访问本页面（https://auto.aininja365.xyz/）。");
    return;
  }
  const seq = ++lbReqSeq;
  renderSkeleton();
  try {
    const params = new URLSearchParams();
    if (lbState.month) params.set("month", lbState.month);
    if (lbState.store) params.set("store", lbState.store);
    const data = await lbApi(`/leaderboard${params.size ? `?${params}` : ""}`);
    if (seq !== lbReqSeq) return; // 防止旧请求覆盖新筛选结果
    lbData = data;
    lbState.month = data.month;
    renderFilters();
    renderRows(lbVisibleEmployees(data.employees || []));
    renderSummary(data.summary);
  } catch (error) {
    if (seq !== lbReqSeq) return;
    renderState("error", `排行榜加载失败：${error.message}`);
    renderSummary(null);
  }
}

lbEl.lbMonth.addEventListener("change", () => { lbState.month = lbEl.lbMonth.value; loadLeaderboard(); });
lbEl.lbStore.addEventListener("change", () => { lbState.store = lbEl.lbStore.value; loadLeaderboard(); });

applyTotalCommissionVisibility();
loadLeaderboard();
