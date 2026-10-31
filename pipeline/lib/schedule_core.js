function pad(value) { return String(value).padStart(2, "0"); }

const STORE_HOURS = Object.freeze({
  start: "07:00",
  end: "03:00",
  crossDay: true,
});

const DEFAULT_SHIFT_TEMPLATES = Object.freeze([
  Object.freeze({
    id: "white",
    name: "白班",
    type: "连续班",
    segments: Object.freeze([
      Object.freeze({ start: "07:00", end: "17:00", crossDay: false }),
    ]),
  }),
  Object.freeze({
    id: "night",
    name: "晚班",
    type: "连续班",
    segments: Object.freeze([
      Object.freeze({ start: "17:00", end: "03:00", crossDay: true }),
    ]),
  }),
  Object.freeze({
    id: "floating",
    name: "穿插班",
    type: "分段班",
    segments: Object.freeze([
      Object.freeze({ start: "11:30", end: "13:30", crossDay: false }),
      Object.freeze({ start: "18:00", end: "01:00", crossDay: true }),
    ]),
  }),
]);

const PEAK_WINDOWS = Object.freeze([
  Object.freeze({ id: "noon", name: "午高峰", start: "11:30", end: "13:30", crossDay: false, requiredStaff: 2 }),
  Object.freeze({ id: "evening", name: "晚高峰", start: "18:00", end: "20:00", crossDay: false, requiredStaff: 2 }),
  Object.freeze({ id: "late", name: "深夜高峰", start: "23:00", end: "01:00", crossDay: true, requiredStaff: 2 }),
]);

function currentMonth(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function previousMonth(date = new Date()) {
  return currentMonth(new Date(date.getFullYear(), date.getMonth() - 1, 1));
}

function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) throw new Error("月份格式必须为 YYYY-MM");
  const [year, value] = month.split("-").map(Number);
  if (value < 1 || value > 12) throw new Error("月份超出范围");
  const last = new Date(year, value, 0).getDate();
  const firstDay = `${month}-01`;
  const lastDay = `${month}-${pad(last)}`;
  return { month, start: `${firstDay} 00:00:00`, end: `${lastDay} 23:59:59`, label: `${firstDay}-${lastDay}` };
}

function validDate(value) {
  const text = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("排班日期格式不正确");
  return text;
}

function normalizeTime(value) {
  const match = String(value || "").trim().replaceAll("：", ":").match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) throw new Error("排班时间格式不正确");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("排班时间超出范围");
  return `${pad(hour)}:${pad(minute)}`;
}

function minutesOfDay(value) {
  const [hour, minute] = normalizeTime(value).split(":").map(Number);
  return hour * 60 + minute;
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function addDays(dateText, days) {
  const [year, month, day] = validDate(dateText).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function dateTimeFromParts(dateText, timeValue, addDay = 0) {
  return `${addDays(dateText, addDay)} ${normalizeTime(timeValue)}:00`;
}

function cleanShiftTemplate(shift) {
  const segments = Array.isArray(shift?.segments) ? shift.segments : [];
  if (!segments.length) throw new Error("班次至少需要一个时间段");
  return {
    id: String(shift.id || shift.name || "shift").trim(),
    name: String(shift.name || "").trim() || "未命名班次",
    type: String(shift.type || (segments.length > 1 ? "分段班" : "连续班")).trim(),
    segments: segments.map((segment) => {
      const start = normalizeTime(segment.start || segment.startTime);
      const end = normalizeTime(segment.end || segment.endTime);
      const explicit = segment.crossDay ?? segment.cross_day;
      return {
        start,
        end,
        crossDay: explicit === undefined ? minutesOfDay(end) <= minutesOfDay(start) : truthy(explicit),
      };
    }),
  };
}

function segmentToWindow(date, segment, shift, assignment, index, totalSegments) {
  const start = normalizeTime(segment.start || segment.startTime);
  const end = normalizeTime(segment.end || segment.endTime);
  const crossDay = Boolean(segment.crossDay ?? segment.cross_day ?? (minutesOfDay(end) <= minutesOfDay(start)));
  const startAt = dateTimeFromParts(date, start, 0);
  const endAt = dateTimeFromParts(date, end, crossDay ? 1 : 0);
  const durationMinutes = minutesOfDay(end) + (crossDay ? 24 * 60 : 0) - minutesOfDay(start);
  if (durationMinutes <= 0) throw new Error("班次结束时间必须晚于开始时间");
  const baseId = String(assignment.id || `${assignment.cashier}-${date}-${shift.id}`).replace(/\s+/g, "-");
  return {
    id: totalSegments > 1 ? `${baseId}-${index + 1}` : baseId,
    cashier: String(assignment.cashier || "").trim(),
    date,
    shiftName: shift.name,
    shiftType: shift.type,
    segmentIndex: index + 1,
    totalSegments,
    startTime: start,
    endTime: end,
    crossDay,
    startAt,
    endAt,
    durationMinutes,
    effectiveFrom: String(assignment.effectiveFrom || `${date} 00:00:00`).replace("T", " "),
    enabled: assignment.enabled !== false,
  };
}

function expandShiftAssignment(assignment = {}) {
  const date = validDate(assignment.date || assignment.shiftDate);
  if (!String(assignment.cashier || "").trim()) throw new Error("排班缺少收银员");
  const shift = cleanShiftTemplate(assignment.shift || assignment);
  return shift.segments.map((segment, index) => segmentToWindow(date, segment, shift, assignment, index, shift.segments.length));
}

function businessDayRange(date) {
  const startAt = dateTimeFromParts(date, STORE_HOURS.start, 0);
  const endAt = dateTimeFromParts(date, STORE_HOURS.end, STORE_HOURS.crossDay ? 1 : 0);
  return { date: validDate(date), startAt, endAt, ...STORE_HOURS };
}

function coverageForPeaks({ date, windows = [], peaks = PEAK_WINDOWS, requiredStaff = 2 } = {}) {
  const shiftDate = validDate(date);
  return peaks.map((peak) => {
    const startAt = dateTimeFromParts(shiftDate, peak.start, 0);
    const endAt = dateTimeFromParts(shiftDate, peak.end, peak.crossDay ? 1 : 0);
    const cashiers = [];
    const seen = new Set();
    for (const window of windows) {
      if (window.enabled === false || window.enabled === 0) continue;
      if (String(window.startAt || "") > startAt || String(window.endAt || "") < endAt) continue;
      const cashier = String(window.cashier || "").split("/")[0].trim();
      if (!cashier || seen.has(cashier)) continue;
      seen.add(cashier);
      cashiers.push(cashier);
    }
    const minimum = Number(peak.requiredStaff || requiredStaff || 1);
    const count = cashiers.length;
    return {
      ...peak,
      date: shiftDate,
      startAt,
      endAt,
      requiredStaff: minimum,
      count,
      cashiers,
      status: count >= minimum ? "covered" : count > 0 ? "understaffed" : "empty",
    };
  });
}

module.exports = {
  STORE_HOURS,
  DEFAULT_SHIFT_TEMPLATES,
  PEAK_WINDOWS,
  currentMonth,
  previousMonth,
  monthRange,
  normalizeTime,
  addDays,
  dateTimeFromParts,
  expandShiftAssignment,
  businessDayRange,
  coverageForPeaks,
};
