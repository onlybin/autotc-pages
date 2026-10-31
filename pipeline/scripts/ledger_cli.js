#!/usr/bin/env node
const path = require("node:path");
const os = require("node:os");
const { CommissionStore } = require("../lib/commission_db");
const { importGeneratedFile, migrateLegacyFile } = require("./ledger_tools");

function args(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) result._.push(argv[i]);
    else result[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  }
  return result;
}

const input = args(process.argv.slice(2));
const command = input._[0];
const dbPath = input.db || process.env.COMMISSION_DB_PATH || path.join(os.homedir(), ".local", "share", "commission_tool", "commission.sqlite3");
const dataFile = input.data || path.resolve(__dirname, "..", "data.js");

let result;
if (command === "migrate") result = migrateLegacyFile({ dbPath, dataFile });
else if (command === "import") result = importGeneratedFile({ dbPath, dataFile, targetMonth: input.month, sourceFilename: input.source || path.basename(dataFile), sourceSha256: input.sha || "", isMonthClose: Boolean(input["month-close"]) });
else if (["health", "integrity", "periods", "month-closed", "failure", "close-month"].includes(command)) {
  const store = new CommissionStore(dbPath);
  try {
    result = command === "health" ? store.health()
      : command === "integrity" ? { integrity: store.integrityCheck() }
        : command === "periods" ? store.listPeriods()
          : command === "month-closed" ? { month: input.month, closed: store.isMonthClosed(input.month) }
            : command === "failure" ? { batchId: store.recordImportFailure({ targetMonth: input.month, sourceFilename: input.source || "scheduled-fetch", errorMessage: input.error || "unknown" }) }
              : { batchId: store.markMonthClosed({ targetMonth: input.month, sourceFilename: input.source, sourceSha256: input.sha || "", rowCount: input.rows || 0 }) };
  }
  finally { store.close(); }
} else throw new Error("用法: ledger_cli.js migrate|import|health|integrity|periods [--db PATH] [--data PATH] [--month YYYY-MM]");
console.log(JSON.stringify(result));
