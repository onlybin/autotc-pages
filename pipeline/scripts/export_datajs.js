#!/usr/bin/env node
// 由 SQLite 台账导出统计页回退数据 data.js（统一规则源，不再走 custom_rules.json）。
// 用法：node scripts/export_datajs.js [--db 路径] [--month YYYY-MM] [--source 来源文件名] [--out 输出文件]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CommissionStore } = require("../lib/commission_db");
const { number, roundMoney } = require("../lib/rules");

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return args;
}

function nowText() {
  const pad = (value) => String(value).padStart(2, "0");
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = args.db || process.env.COMMISSION_DB_PATH || path.join(os.homedir(), ".local", "share", "commission_tool", "commission.sqlite3");
  const month = String(args.month || nowText().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`月份格式不正确：${month}`);
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const start = `${month}-01`;
  const end = `${month}-${String(lastDay).padStart(2, "0")}`;
  const outFile = path.resolve(String(args.out || "data.js"));

  const store = new CommissionStore(dbPath);
  try {
    const rows = store.rowsFrom(start, end).filter((row) => row.sourceKind === "auto");
    store.annotateOrderDifferences(rows);
    for (const row of rows) {
      delete row.sourceKind;
      delete row.lineKey;
      delete row.manualReason;
    }
    rows.sort((a, b) => String(a.checkoutTime).localeCompare(String(b.checkoutTime)) || String(a.orderId).localeCompare(String(b.orderId)));

    const commissioned = rows.filter((row) => number(row.commissionPerUnit) > 0 && row.status === "正常");
    const group = (key, withItems = false) => {
      const map = new Map();
      for (const row of commissioned) {
        const name = typeof key === "function" ? key(row) : row[key];
        const item = map.get(name) || { name, quantity: 0, commission: 0, sales: 0, orders: new Set(), items: 0 };
        item.quantity += number(row.quantity);
        item.commission += number(row.commission);
        item.sales += number(row.amount);
        item.orders.add(row.orderId);
        item.items += 1;
        map.set(name, item);
      }
      return [...map.values()]
        .map((item) => ({
          name: item.name,
          quantity: roundMoney(item.quantity),
          commission: roundMoney(item.commission),
          sales: roundMoney(item.sales),
          orderCount: item.orders.size,
          ...(withItems ? { items: item.items } : {}),
        }))
        .sort((a, b) => b.commission - a.commission);
    };
    const dailyMap = new Map();
    for (const row of commissioned) {
      if (!row.date) continue;
      const item = dailyMap.get(row.date) || { date: row.date, quantity: 0, commission: 0 };
      item.quantity += number(row.quantity);
      item.commission += number(row.commission);
      dailyMap.set(row.date, item);
    }

    const lastBatch = store.db
      .prepare("SELECT source_filename FROM import_batches WHERE target_month=? AND status='success' ORDER BY id DESC LIMIT 1")
      .get(month);
    const dates = rows.map((row) => row.date).filter(Boolean).sort();
    const payload = {
      generatedAt: nowText(),
      period: `${dates[0] || "-"} 至 ${dates.at(-1) || "-"}`,
      source: {
        orders: String(args.source || lastBatch?.source_filename || ""),
        rules: "后台维护规则",
      },
      metrics: {
        totalRows: rows.length,
        commissionRows: commissioned.length,
        totalCommission: roundMoney(commissioned.reduce((sum, row) => sum + number(row.commission), 0)),
        totalQuantity: roundMoney(commissioned.reduce((sum, row) => sum + number(row.quantity), 0)),
        totalSales: roundMoney(commissioned.reduce((sum, row) => sum + number(row.amount), 0)),
        people: new Set(commissioned.map((row) => row.cashier)).size,
        unmatchedRows: rows.filter((row) => row.productName !== "快速收银" && !row.ruleName).length,
      },
      rules: store.currentRules().rules,
      people: group("cashier", true),
      products: group((row) => row.ruleName || row.productName),
      daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((item) => ({ date: item.date, quantity: roundMoney(item.quantity), commission: roundMoney(item.commission) })),
      orders: rows,
    };

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `window.COMMISSION_DATA = ${JSON.stringify(payload, null, 2)};\n`, "utf8");
    console.log(JSON.stringify(payload.metrics));
  } finally {
    store.close();
  }
}

main();
