const fs = require("node:fs");
const crypto = require("node:crypto");
const { CommissionStore } = require("../lib/commission_db");
const { number, roundMoney } = require("../lib/rules");

function parseDataJs(filename) {
  const text = fs.readFileSync(filename, "utf8");
  const jsonText = text.replace(/^\s*window\.COMMISSION_DATA\s*=\s*/, "").replace(/;\s*$/, "");
  return JSON.parse(jsonText);
}

function metrics(payload) {
  const commissioned = (payload.orders || []).filter((item) => number(item.commissionPerUnit) > 0 && item.status === "正常");
  return {
    totalRows: (payload.orders || []).length,
    commissionRows: commissioned.length,
    totalCommission: roundMoney(commissioned.reduce((sum, item) => sum + number(item.commission), 0)),
  };
}

function reportMetrics(report) {
  return {
    totalRows: report.pagination.total,
    commissionRows: report.summary.commissionRows,
    totalCommission: report.summary.totalCommission,
  };
}

function migrateLegacyFile({ dbPath, dataFile }) {
  const payload = parseDataJs(dataFile);
  const before = metrics(payload);
  const store = new CommissionStore(dbPath);
  try {
    store.migrateLegacyPayload(payload);
    const report = store.getReport({ start: "0000-01-01", end: "9999-12-31", mode: "all", pageSize: 1000 });
    const after = reportMetrics(report);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`迁移校验失败: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    return { before, after, integrity: store.integrityCheck(), periods: store.listPeriods() };
  } finally { store.close(); }
}

function importGeneratedFile({ dbPath, dataFile, targetMonth, sourceFilename, sourceSha256 = "", isMonthClose = false }) {
  const payload = parseDataJs(dataFile);
  const store = new CommissionStore(dbPath);
  try {
    const imported = store.importOrders({ targetMonth, sourceFilename, sourceSha256, isMonthClose, orders: payload.orders || [], fallbackRules: payload.rules || [] });
    return { imported, report: store.getReport({ start: `${targetMonth}-01`, end: `${targetMonth}-31`, mode: "all", pageSize: 1000 }), integrity: store.integrityCheck() };
  } finally { store.close(); }
}

function sha256File(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function summarizeImportResult(result) {
  return {
    batchId: result.imported?.batchId,
    rowCount: result.imported?.rowCount,
    totalCommission: result.report?.summary?.totalCommission,
    commissionRows: result.report?.summary?.commissionRows,
    integrity: result.integrity,
  };
}

module.exports = { importGeneratedFile, metrics, migrateLegacyFile, parseDataJs, sha256File, summarizeImportResult };
