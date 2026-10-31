#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { CommissionStore } = require("../lib/commission_db");

const dbPath = process.env.COMMISSION_DB_PATH || path.join(os.homedir(), ".local", "share", "commission_tool", "commission.sqlite3");
const now = new Date();
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const store = new CommissionStore(dbPath);
let months;
try { months = store.pendingCloseMonths(currentMonth); } finally { store.close(); }

for (const month of months) {
  console.log(`closing pending commission month ${month}`);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "..", "fetch_orders_and_update.mjs"), "--month", month, "--month-close"], { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!months.length) console.log("no pending commission months");
