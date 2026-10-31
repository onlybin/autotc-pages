/**
 * D1 版台账（由 pipeline/lib/commission_db.js 同步移植而来）
 *
 * 移植原则：SQL 语句、计算逻辑、返回结构一律不变，只把同步 IO 改成异步。
 * 唯一的行为差异是事务：D1 没有交互式事务（BEGIN/COMMIT 跨多次调用），
 * 这里用 db.batch() 在"语句集合可预先确定"的地方保持原子性，
 * 其余场景按幂等重建（import 用 INSERT OR IGNORE / 覆盖式 UPDATE，重跑收敛）。
 *
 * 时区：Worker 运行在 UTC，而旧主机是 CST。nowText() 显式指定 Asia/Shanghai，
 * 否则 health() 里 `completed_at + "+08:00"` 的换算会差 8 小时，stale 判断永远为真。
 */

import { calculateCommission, isPlaceholderProduct, normalizeRules, number, roundMoney, stableOrderKeys } from "./rules.js";

export class RuleConflictError extends Error {
  constructor(preview) {
    super("新规则会覆盖已有规则，请先确认影响范围");
    this.name = "RuleConflictError";
    this.code = "RULE_VERSION_CONFLICT";
    this.preview = preview;
  }
}

export function nowText() {
  return new Date()
    .toLocaleString("sv-SE", { hour12: false, timeZone: "Asia/Shanghai" })
    .replace("T", " ");
}

function effectiveText(date) {
  const value = String(date || "").trim();
  if (!value) return nowText();
  return value.length === 10 ? `${value} 00:00:00` : value.replace("T", " ");
}

function validDateText(value) {
  const text = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("班次日期格式不正确");
  return text;
}

function validMonthText(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) throw new Error("目标月份格式不正确");
  return text;
}

function validSupplementDateText(value) {
  const text = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("补录日期格式不正确");
  return text;
}

function monthBounds(month) {
  const [year, value] = String(month).split("-").map(Number);
  const last = new Date(Date.UTC(year, value, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

function addDays(dateText, days) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function timeText(value) {
  const match = String(value || "").trim().replaceAll("：", ":").match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) throw new Error("班次时间格式不正确");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("班次时间超出范围");
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function dateTimeFromParts(dateText, timeValue, addDay = 0) {
  return `${addDays(dateText, addDay)} ${timeText(timeValue)}`;
}

function cashierIdentity(value) {
  const raw = String(value || "").trim();
  return raw.split("/")[0].trim() || raw;
}

function hasConcreteCheckoutTime(value) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value || ""));
}

function normalizeShiftWindow(window, index = 0) {
  const cashier = cashierIdentity(window.cashier);
  const date = validDateText(window.date || window.shiftDate);
  const startTime = timeText(window.startTime);
  const endTime = timeText(window.endTime);
  const explicitCrossDay = window.crossDay ?? window.cross_day;
  const crossesMidnight = explicitCrossDay === undefined ? endTime <= startTime : truthy(explicitCrossDay);
  const startAt = dateTimeFromParts(date, startTime, 0);
  const endAt = dateTimeFromParts(date, endTime, crossesMidnight ? 1 : 0);
  if (endAt <= startAt) throw new Error("班次结束时间必须晚于开始时间");
  if (!cashier) throw new Error("班次缺少收银员");
  const segmentIndex = Math.max(1, Number(window.segmentIndex ?? window.segment_index ?? 1) || 1);
  const totalSegments = Math.max(segmentIndex, Number(window.totalSegments ?? window.total_segments ?? 1) || 1);
  return {
    id: String(window.id || `shift-${Date.now()}-${index}`),
    cashier,
    date,
    shiftName: String(window.shiftName || window.shift_name || window.name || "").trim(),
    shiftType: String(window.shiftType || window.shift_type || window.type || "").trim(),
    segmentIndex,
    totalSegments,
    crossDay: crossesMidnight ? 1 : 0,
    startTime: startTime.slice(0, 5),
    endTime: endTime.slice(0, 5),
    startAt,
    endAt,
    effectiveFrom: effectiveText(window.effectiveFrom || `${date} 00:00:00`),
    enabled: window.enabled === false || window.enabled === 0 || window.enabled === "false" ? 0 : 1,
  };
}

function splitMoney(value, parts) {
  const cents = Math.round(Number(value || 0) * 100);
  const base = Math.trunc(cents / parts);
  let remainder = cents - base * parts;
  return Array.from({ length: parts }, () => {
    const centsForPart = base + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;
    return centsForPart / 100;
  });
}

/** 与 rules.js 保持一致的金额/数值处理，直接复用其实现（见文件头 import） */

async function sha256Hex(text) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rule_sets(
    id INTEGER PRIMARY KEY AUTOINCREMENT, effective_from TEXT NOT NULL, created_at TEXT NOT NULL,
    source TEXT NOT NULL, superseded_at TEXT, superseded_by INTEGER
  );
  CREATE TABLE IF NOT EXISTS rule_items(
    id INTEGER PRIMARY KEY AUTOINCREMENT, rule_set_id INTEGER NOT NULL REFERENCES rule_sets(id),
    rule_key TEXT NOT NULL, name TEXT NOT NULL, pack_price REAL NOT NULL, carton_price REAL NOT NULL,
    min_pack_price REAL NOT NULL DEFAULT 0, min_carton_price REAL NOT NULL DEFAULT 0,
    commission REAL NOT NULL, source TEXT NOT NULL, UNIQUE(rule_set_id, rule_key)
  );
  CREATE TABLE IF NOT EXISTS import_batches(
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_month TEXT NOT NULL, source_filename TEXT NOT NULL,
    source_sha256 TEXT, started_at TEXT NOT NULL, completed_at TEXT, is_month_close INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, row_count INTEGER NOT NULL DEFAULT 0, error_message TEXT,
    UNIQUE(target_month, source_filename, source_sha256)
  );
  CREATE TABLE IF NOT EXISTS orders(
    line_key TEXT PRIMARY KEY, store TEXT, order_id TEXT, payment_no TEXT, product_id TEXT, product_name TEXT NOT NULL,
    unit TEXT, original_quantity REAL NOT NULL, quantity REAL NOT NULL, quantity_basis TEXT, unit_price REAL NOT NULL,
    amount REAL NOT NULL, order_amount REAL NOT NULL DEFAULT 0, refund REAL NOT NULL, status TEXT NOT NULL, cashier TEXT, checkout_time TEXT, order_date TEXT NOT NULL,
    rule_set_id INTEGER REFERENCES rule_sets(id), rule_key TEXT, rule_name TEXT, commission_per_unit REAL NOT NULL,
    commission REAL NOT NULL, match_type TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    source_batch_id INTEGER REFERENCES import_batches(id),
    -- 以下 9 列在原实现里由 ensureColumn 补加，这里直接建进表结构
    expected_amount REAL NOT NULL DEFAULT 0, min_allowed_amount REAL NOT NULL DEFAULT 0,
    actual_amount REAL NOT NULL DEFAULT 0, discount_amount REAL NOT NULL DEFAULT 0,
    discount_rate REAL NOT NULL DEFAULT 0, price_status TEXT NOT NULL DEFAULT '',
    commission_status TEXT NOT NULL DEFAULT '', audit_status TEXT NOT NULL DEFAULT '',
    audit_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date);
  CREATE INDEX IF NOT EXISTS idx_orders_checkout ON orders(checkout_time);
  CREATE TABLE IF NOT EXISTS manual_orders(
    id TEXT PRIMARY KEY, order_date TEXT NOT NULL, checkout_time TEXT, product_name TEXT NOT NULL, unit_price REAL NOT NULL,
    quantity REAL NOT NULL, cashier TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT '正常',
    rule_set_id INTEGER REFERENCES rule_sets(id), rule_key TEXT, rule_name TEXT, commission_per_unit REAL NOT NULL,
    commission REAL NOT NULL, match_type TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shift_share_windows(
    id TEXT PRIMARY KEY, cashier TEXT NOT NULL, shift_name TEXT, shift_type TEXT, segment_index INTEGER NOT NULL DEFAULT 1,
    total_segments INTEGER NOT NULL DEFAULT 1, cross_day INTEGER NOT NULL DEFAULT 0,
    shift_date TEXT NOT NULL, start_time TEXT NOT NULL,
    end_time TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, effective_from TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shift_share_windows_time ON shift_share_windows(enabled,start_at,end_at,effective_from);
  CREATE TABLE IF NOT EXISTS monthly_sales_targets(
    target_month TEXT PRIMARY KEY,
    target_sales REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sales_target_supplements(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplement_date TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sales_target_supplements_date ON sales_target_supplements(supplement_date);
  CREATE TABLE IF NOT EXISTS order_amount_allocations(
    order_id TEXT NOT NULL,
    line_key TEXT NOT NULL,
    allocated_amount REAL NOT NULL,
    note TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(order_id,line_key)
  );
  INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, datetime('now','localtime'));
`;

export class CommissionStore {
  /**
   * @param {{all:Function,get:Function,run:Function,exec:Function,batch?:Function}} adapter
   *   all/get/run 均为异步；exec 用于 DDL 与 PRAGMA。
   */
  constructor(adapter) {
    this.adapter = adapter;
    // 保持与原实现相同的调用形态（this.db.prepare(sql).get(...)），只是返回 Promise
    this.db = {
      prepare: (sql) => ({
        all: (...args) => this.adapter.all(sql, args),
        get: (...args) => this.adapter.get(sql, args),
        run: (...args) => this.adapter.run(sql, args),
      }),
      exec: (sql) => this.adapter.exec(sql),
    };
  }

  async initSchema() {
    await this.db.exec(SCHEMA_SQL);
  }

  async ensureColumn(tableName, columnName, definition) {
    const columns = (await this.db.prepare(`PRAGMA table_info(${tableName})`).all()).map((column) => column.name);
    if (!columns.includes(columnName)) await this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  /**
   * 批量执行写语句。
   * D1 单次 Worker 请求的子请求数有限（约 1000），逐行 execute 三千行必然超限，
   * 因此把语句攒起来用 batch 提交（每批 100 条，单个事务）。
   */
  async flushStatements(statements, size = 100) {
    if (!statements.length) return;
    if (typeof this.adapter.batch === "function") {
      for (let index = 0; index < statements.length; index += size) {
        await this.adapter.batch(statements.slice(index, index + size));
      }
      return;
    }
    for (const statement of statements) await this.adapter.run(statement.sql, statement.params);
  }

  /**
   * 预取规则集，返回"按时间点解析规则"的函数。
   * 逐行调用 ruleSetAt 会对每行发一次查询，导入一个月就是几千次往返。
   */
  async ruleResolver() {
    const sets = await this.db
      .prepare("SELECT id,effective_from,superseded_at FROM rule_sets ORDER BY effective_from DESC,id DESC")
      .all();
    const cache = new Map();
    return async (timestamp) => {
      const target = timestamp || "9999-12-31 23:59:59";
      for (const row of sets) {
        if (row.superseded_at === null && String(row.effective_from) <= target) {
          const id = Number(row.id);
          if (!cache.has(id)) cache.set(id, await this.rulesForSet(id));
          return { id, rules: cache.get(id) };
        }
      }
      return null;
    };
  }

  // ---------- 规则 ----------

  async insertRuleSet(rules, effectiveFrom, source) {
    const created = nowText();
    const result = await this.db
      .prepare("INSERT INTO rule_sets(effective_from,created_at,source) VALUES(?,?,?)")
      .run(effectiveFrom, created, source);
    const id = Number(result.lastRowId);
    const insert = this.db.prepare(
      "INSERT INTO rule_items(rule_set_id,rule_key,name,pack_price,carton_price,min_pack_price,min_carton_price,commission,source) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    for (const rule of normalizeRules(rules)) {
      await insert.run(id, rule.id, rule.name, rule.packPrice, rule.cartonPrice, rule.minPackPrice, rule.minCartonPrice, rule.commission, rule.source);
    }
    return id;
  }

  async ensureBaselineRules(rules) {
    const row = await this.db
      .prepare("SELECT id FROM rule_sets WHERE superseded_at IS NULL ORDER BY effective_from DESC,id DESC LIMIT 1")
      .get();
    return row ? Number(row.id) : this.insertRuleSet(rules, "1970-01-01 00:00:00", "历史迁移基线");
  }

  async rulesForSet(ruleSetId) {
    return this.db
      .prepare(
        "SELECT rule_key AS id,name,pack_price AS packPrice,carton_price AS cartonPrice,min_pack_price AS minPackPrice,min_carton_price AS minCartonPrice,commission,source FROM rule_items WHERE rule_set_id=? ORDER BY id",
      )
      .all(ruleSetId);
  }

  async ruleSetAt(timestamp) {
    const row = await this.db
      .prepare("SELECT id FROM rule_sets WHERE superseded_at IS NULL AND effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1")
      .get(timestamp || "9999-12-31 23:59:59");
    if (!row) return null;
    return { id: Number(row.id), rules: await this.rulesForSet(Number(row.id)) };
  }

  async currentRules() {
    const set = await this.ruleSetAt("9999-12-31 23:59:59");
    return set ? { ruleSetId: set.id, rules: set.rules } : { ruleSetId: null, rules: [] };
  }

  // ---------- 导入批次 ----------

  async createBatch({ targetMonth, sourceFilename, sourceSha256 = "", isMonthClose = false, status = "running" }) {
    const result = await this.db
      .prepare(`INSERT OR IGNORE INTO import_batches(target_month,source_filename,source_sha256,started_at,is_month_close,status)
      VALUES(?,?,?,?,?,?)`)
      .run(targetMonth, sourceFilename, sourceSha256, nowText(), isMonthClose ? 1 : 0, status);
    // 不依赖 last_row_id：INSERT OR IGNORE 命中唯一约束时，D1 可能回上一个 rowid。
    // 统一按唯一键回查，结果确定。
    const found = await this.db
      .prepare("SELECT id FROM import_batches WHERE target_month=? AND source_filename=? AND source_sha256=?")
      .get(targetMonth, sourceFilename, sourceSha256);
    if (found) return Number(found.id);
    return Number(result.lastRowId);
  }

  orderInsertStatement(prefix = "INSERT") {
    return this.db.prepare(`${prefix} INTO orders(
      line_key,store,order_id,payment_no,product_id,product_name,unit,original_quantity,quantity,quantity_basis,unit_price,amount,order_amount,refund,status,cashier,checkout_time,order_date,
      rule_set_id,rule_key,rule_name,commission_per_unit,commission,match_type,expected_amount,min_allowed_amount,actual_amount,discount_amount,discount_rate,price_status,commission_status,audit_status,audit_reason,
      first_seen_at,last_seen_at,source_batch_id
    ) VALUES(${Array(36).fill("?").join(",")})`);
  }

  async orderValues(item, ruleSetId, batchId, timestamp, preserveLegacy = false, resolver = null) {
    let calc;
    if (preserveLegacy) {
      calc = {
        ruleId: item.ruleId || "",
        ruleName: item.ruleName || "",
        commissionPerUnit: number(item.commissionPerUnit),
        commission: number(item.commission),
        matchType: item.matchType || "",
        expectedAmount: number(item.expectedAmount),
        minAllowedAmount: number(item.minAllowedAmount),
        actualAmount: number(item.actualAmount ?? item.amount),
        discountAmount: number(item.discountAmount),
        discountRate: number(item.discountRate),
        priceStatus: item.priceStatus || "",
        commissionStatus: item.commissionStatus || "",
        auditStatus: item.auditStatus || "",
        auditReason: item.auditReason || "",
      };
    } else {
      const resolve = resolver || ((value) => this.ruleSetAt(value));
      const set = (await resolve(item.checkoutTime || `${item.date} 23:59:59`)) || { id: ruleSetId, rules: [] };
      ruleSetId = set.id;
      calc = calculateCommission(item, set.rules);
    }
    return [
      item.lineKey, item.store || "", item.orderId || "", item.paymentNo || "", item.productId || "", item.productName || "", item.unit || "",
      number(item.originalQuantity), number(item.quantity), item.quantityBasis || "", number(item.unitPrice), number(item.amount), number(item.orderAmount ?? item.amount), number(item.refund), item.status || "", item.cashier || "",
      item.checkoutTime || "", item.date || String(item.checkoutTime || "").slice(0, 10), ruleSetId, calc.ruleId, calc.ruleName, calc.commissionPerUnit, calc.commission,
      calc.matchType, calc.expectedAmount, calc.minAllowedAmount, calc.actualAmount, calc.discountAmount, calc.discountRate, calc.priceStatus, calc.commissionStatus,
      calc.auditStatus, calc.auditReason, timestamp, timestamp, batchId,
    ];
  }

  async migrateLegacyPayload(payload) {
    const ruleSetId = await this.ensureBaselineRules(payload.rules || []);
    const batchId = await this.createBatch({
      targetMonth: String(payload.generatedAt || "").slice(0, 7) || "legacy",
      sourceFilename: "legacy-data.js",
      sourceSha256: "legacy",
      status: "success",
    });
    const insert = this.orderInsertStatement("INSERT OR IGNORE");
    const timestamp = String(payload.generatedAt || nowText());
    const statements = [];
    for (const item of stableOrderKeys(payload.orders || [])) {
      statements.push({ sql: null, params: null, kind: "legacy", item });
    }
    // 逐行取值后再批量提交（orderValues 是异步的，无法在 batch 里惰性求值）
    const filled = [];
    for (const row of statements) {
      const values = await this.orderValues(row.item, ruleSetId, batchId, timestamp, true);
      filled.push({ sql: `INSERT OR IGNORE INTO orders(
      line_key,store,order_id,payment_no,product_id,product_name,unit,original_quantity,quantity,quantity_basis,unit_price,amount,order_amount,refund,status,cashier,checkout_time,order_date,
      rule_set_id,rule_key,rule_name,commission_per_unit,commission,match_type,expected_amount,min_allowed_amount,actual_amount,discount_amount,discount_rate,price_status,commission_status,audit_status,audit_reason,
      first_seen_at,last_seen_at,source_batch_id
    ) VALUES(${Array(36).fill("?").join(",")})`, params: values });
    }
    await this.flushStatements(filled);
    await this.db
      .prepare("UPDATE import_batches SET completed_at=?,status='success',row_count=? WHERE id=?")
      .run(timestamp, (payload.orders || []).length, batchId);
    return this.getReport({ start: "0000-01-01", end: "9999-12-31", mode: "all" });
  }

  async importOrders({ targetMonth, sourceFilename, sourceSha256 = "", orders, isMonthClose = false, fallbackRules = [] }) {
    const fallbackSet = await this.ensureBaselineRules(fallbackRules);
    const batchId = await this.createBatch({ targetMonth, sourceFilename, sourceSha256, isMonthClose });
    const timestamp = nowText();

    const insertSql = `INSERT INTO orders(
      line_key,store,order_id,payment_no,product_id,product_name,unit,original_quantity,quantity,quantity_basis,unit_price,amount,order_amount,refund,status,cashier,checkout_time,order_date,
      rule_set_id,rule_key,rule_name,commission_per_unit,commission,match_type,expected_amount,min_allowed_amount,actual_amount,discount_amount,discount_rate,price_status,commission_status,audit_status,audit_reason,
      first_seen_at,last_seen_at,source_batch_id
    ) VALUES(${Array(36).fill("?").join(",")})`;
    const updateSql = `UPDATE orders SET store=?,payment_no=?,product_id=?,product_name=?,unit=?,original_quantity=?,quantity=?,quantity_basis=?,unit_price=?,amount=?,order_amount=?,refund=?,status=?,cashier=?,checkout_time=?,order_date=?,commission_per_unit=?,commission=?,match_type=?,expected_amount=?,min_allowed_amount=?,actual_amount=?,discount_amount=?,discount_rate=?,price_status=?,commission_status=?,audit_status=?,audit_reason=?,last_seen_at=?,source_batch_id=? WHERE line_key=?`;

    // 原实现在循环里逐行 SELECT 已存在行；改成一次预取整月，语义等价但只有一次往返
    const existingRows = await this.db
      .prepare(
        `SELECT o.line_key,o.rule_key,o.rule_name,o.commission_per_unit,o.match_type,ri.pack_price,ri.carton_price,ri.min_pack_price,ri.min_carton_price,ri.commission AS rule_commission
          FROM orders o LEFT JOIN rule_items ri ON ri.rule_set_id=o.rule_set_id AND ri.rule_key=o.rule_key WHERE o.order_date BETWEEN ? AND ?`,
      )
      .all(`${targetMonth}-01`, `${targetMonth}-31`);
    const existingMap = new Map(existingRows.map((row) => [row.line_key, row]));
    const resolver = await this.ruleResolver();

    const touchedOrderIds = new Set();
    const statements = [];
    let count = 0;
    for (const item of stableOrderKeys(orders || [])) {
      const existing = existingMap.get(item.lineKey);
      if (existing) {
        const frozenRule = existing.rule_key
          ? {
              id: existing.rule_key,
              name: existing.rule_name,
              packPrice: number(existing.pack_price),
              cartonPrice: number(existing.carton_price),
              minPackPrice: number(existing.min_pack_price) || number(existing.pack_price),
              minCartonPrice: number(existing.min_carton_price) || number(existing.carton_price),
              commission: number(existing.rule_commission ?? existing.commission_per_unit),
            }
          : null;
        const calc = calculateCommission(item, frozenRule ? [frozenRule] : []);
        statements.push({
          sql: updateSql,
          params: [
            item.store || "", item.paymentNo || "", item.productId || "", item.productName || "", item.unit || "", number(item.originalQuantity), number(item.quantity),
            item.quantityBasis || "", number(item.unitPrice), number(item.amount), number(item.orderAmount ?? item.amount), number(item.refund), item.status || "", item.cashier || "", item.checkoutTime || "",
            item.date || String(item.checkoutTime || "").slice(0, 10), calc.commissionPerUnit, calc.commission, calc.matchType,
            calc.expectedAmount, calc.minAllowedAmount, calc.actualAmount, calc.discountAmount, calc.discountRate, calc.priceStatus, calc.commissionStatus, calc.auditStatus, calc.auditReason,
            timestamp, batchId, item.lineKey,
          ],
        });
      } else {
        statements.push({
          sql: insertSql,
          params: await this.orderValues(item, fallbackSet, batchId, timestamp, false, resolver),
        });
      }
      if (item.orderId) touchedOrderIds.add(String(item.orderId));
      count += 1;
    }

    // 分批提交：单条请求内几千次 D1 调用会撞上子请求上限
    await this.flushStatements(statements);

    const eligibility = this.revalidateOrderEligibility([...touchedOrderIds]);
    await this.db
      .prepare("UPDATE import_batches SET completed_at=?,status='success',row_count=?,error_message=NULL WHERE id=?")
      .run(timestamp, count, batchId);
    return { batchId, rowCount: count, eligibility };
  }

  // 新价格规则已经逐行计算：满 10 包按条价、不足按包价，且超过 ±5% 时按差额 50% 奖扣。
  // 旧版这里会做“同订单合并资格校验”，并把部分行改为 0 提成；这会覆盖新规则的负提成/奖扣结果。
  // 保留该方法作为导入流程的幂等钩子，但不再二次改写订单行。
  revalidateOrderEligibility(orderIds) {
    const ids = [...new Set((orderIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    return { orders: ids.length, failedOrders: 0 };
  }

  async recordImportFailure({ targetMonth, sourceFilename, sourceSha256 = "", errorMessage }) {
    const batchId = await this.createBatch({ targetMonth, sourceFilename, sourceSha256, status: "failed" });
    await this.db
      .prepare("UPDATE import_batches SET completed_at=?,status='failed',error_message=? WHERE id=?")
      .run(nowText(), String(errorMessage || "未知错误").slice(0, 1000), batchId);
    return batchId;
  }

  async markMonthClosed({ targetMonth, sourceFilename, sourceSha256 = "", rowCount = 0 }) {
    const batchId = await this.createBatch({ targetMonth, sourceFilename, sourceSha256, isMonthClose: true, status: "success" });
    await this.db
      .prepare("UPDATE import_batches SET completed_at=?,is_month_close=1,status='success',row_count=?,error_message=NULL WHERE id=?")
      .run(nowText(), Number(rowCount) || 0, batchId);
    return batchId;
  }

  // ---------- 销售目标 ----------

  async saveMonthlySalesTarget(input = {}) {
    const { month, targetSales } = input;
    const targetMonth = validMonthText(month);
    if (targetSales === undefined || targetSales === null || (typeof targetSales === "string" && !targetSales.trim())) {
      throw new Error("销售目标金额必须大于或等于 0");
    }
    const value = number(targetSales, NaN);
    if (!Number.isFinite(value) || value < 0) throw new Error("销售目标金额必须大于或等于 0");
    const timestamp = nowText();
    await this.db
      .prepare(`INSERT INTO monthly_sales_targets(target_month,target_sales,created_at,updated_at)
      VALUES(?,?,?,?)
      ON CONFLICT(target_month) DO UPDATE SET target_sales=excluded.target_sales,updated_at=excluded.updated_at`)
      .run(targetMonth, value, timestamp, timestamp);
    return this.getMonthlySalesTarget(targetMonth);
  }

  async getMonthlySalesTarget(month) {
    const targetMonth = validMonthText(month);
    const row = await this.db
      .prepare(`SELECT target_month AS month,target_sales AS targetSales,created_at AS createdAt,updated_at AS updatedAt
      FROM monthly_sales_targets WHERE target_month=?`)
      .get(targetMonth);
    return row ? { ...row, targetSales: number(row.targetSales), source: "admin" } : null;
  }

  async listMonthlySalesTargets() {
    const rows = await this.db
      .prepare(`SELECT target_month AS month,target_sales AS targetSales,created_at AS createdAt,updated_at AS updatedAt
      FROM monthly_sales_targets ORDER BY target_month DESC`)
      .all();
    return rows.map((row) => ({ ...row, targetSales: number(row.targetSales), source: "admin" }));
  }

  normalizeSalesTargetSupplement(row) {
    return row
      ? {
          id: Number(row.id),
          date: row.date,
          month: String(row.date || "").slice(0, 7),
          amount: number(row.amount),
          note: row.note || "",
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      : null;
  }

  async addSalesTargetSupplement(input = {}) {
    const date = validSupplementDateText(input.date);
    if (input.amount === undefined || input.amount === null || (typeof input.amount === "string" && !input.amount.trim())) {
      throw new Error("补录销售额必须大于或等于 0");
    }
    const amount = number(input.amount, NaN);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("补录销售额必须大于或等于 0");
    const timestamp = nowText();
    const result = await this.db
      .prepare(`INSERT INTO sales_target_supplements(supplement_date,amount,note,created_at,updated_at)
      VALUES(?,?,?,?,?)`)
      .run(date, amount, String(input.note || "").trim().slice(0, 200), timestamp, timestamp);
    return this.getSalesTargetSupplement(Number(result.lastRowId));
  }

  async getSalesTargetSupplement(id) {
    const row = await this.db
      .prepare(`SELECT id,supplement_date AS date,amount,note,created_at AS createdAt,updated_at AS updatedAt
      FROM sales_target_supplements WHERE id=?`)
      .get(Number(id));
    return this.normalizeSalesTargetSupplement(row);
  }

  async listSalesTargetSupplements(month = "") {
    const targetMonth = String(month || "").trim();
    if (targetMonth) {
      const cleanMonth = validMonthText(targetMonth);
      const rows = await this.db
        .prepare(`SELECT id,supplement_date AS date,amount,note,created_at AS createdAt,updated_at AS updatedAt
        FROM sales_target_supplements WHERE supplement_date BETWEEN ? AND ? ORDER BY supplement_date DESC,id DESC`)
        .all(`${cleanMonth}-01`, `${cleanMonth}-31`);
      return rows.map((row) => this.normalizeSalesTargetSupplement(row));
    }
    const rows = await this.db
      .prepare(`SELECT id,supplement_date AS date,amount,note,created_at AS createdAt,updated_at AS updatedAt
      FROM sales_target_supplements ORDER BY supplement_date DESC,id DESC`)
      .all();
    return rows.map((row) => this.normalizeSalesTargetSupplement(row));
  }

  async deleteSalesTargetSupplement(id) {
    const result = await this.db.prepare("DELETE FROM sales_target_supplements WHERE id=?").run(Number(id));
    return result.changes > 0;
  }

  async salesTargetSupplementTotal(start, end) {
    const row = await this.db
      .prepare("SELECT COALESCE(SUM(amount),0) AS total FROM sales_target_supplements WHERE supplement_date BETWEEN ? AND ?")
      .get(start, end);
    return roundMoney(number(row?.total));
  }

  // ---------- 排班 ----------

  async saveShiftShareWindows(windows = []) {
    const clean = (Array.isArray(windows) ? windows : []).map(normalizeShiftWindow);
    const timestamp = nowText();
    const statements = [{ sql: "DELETE FROM shift_share_windows", params: [] }];
    for (const item of clean) {
      statements.push({
        sql: `INSERT INTO shift_share_windows(id,cashier,shift_name,shift_type,segment_index,total_segments,cross_day,shift_date,start_time,end_time,start_at,end_at,effective_from,enabled,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [item.id, item.cashier, item.shiftName, item.shiftType, item.segmentIndex, item.totalSegments, item.crossDay, item.date, item.startTime, item.endTime, item.startAt, item.endAt, item.effectiveFrom, item.enabled, timestamp, timestamp],
      });
    }
    // 删除+重建必须原子：D1 的 batch 是单个事务，语句集合已预先确定
    if (typeof this.adapter.batch === "function") {
      await this.adapter.batch(statements);
    } else {
      for (const statement of statements) await this.adapter.run(statement.sql, statement.params);
    }
    return this.listShiftShareWindows();
  }

  async listShiftShareWindows() {
    const rows = await this.db
      .prepare(`SELECT id,cashier,shift_name AS shiftName,shift_type AS shiftType,segment_index AS segmentIndex,total_segments AS totalSegments,
      cross_day AS crossDay,shift_date AS date,start_time AS startTime,end_time AS endTime,start_at AS startAt,end_at AS endAt,
      effective_from AS effectiveFrom,enabled,created_at AS createdAt,updated_at AS updatedAt FROM shift_share_windows ORDER BY start_at,cashier,id`)
      .all();
    return rows.map((item) => ({ ...item, enabled: Boolean(item.enabled), crossDay: Boolean(item.crossDay) }));
  }

  /**
   * 取全部启用中的班次窗口。getReport 对 3000+ 行逐行调用会变成 3000 次查询，
   * 这里一次取回、在内存里按原 SQL 的谓词过滤，结果与逐行查询完全等价。
   */
  async enabledShiftWindows() {
    return this.db
      .prepare("SELECT id,cashier,start_at AS startAt,end_at AS endAt,effective_from AS effectiveFrom FROM shift_share_windows WHERE enabled=1 ORDER BY id")
      .all();
  }

  onDutyCashiersFrom(windows, checkoutTime) {
    if (!hasConcreteCheckoutTime(checkoutTime)) return [];
    const result = [];
    const seen = new Set();
    for (const row of windows) {
      if (!(String(row.startAt) <= checkoutTime)) continue;
      if (!(String(row.endAt) > checkoutTime)) continue;
      if (!(String(row.effectiveFrom) <= checkoutTime)) continue;
      const cashier = cashierIdentity(row.cashier);
      if (!cashier || seen.has(cashier)) continue;
      seen.add(cashier);
      result.push(cashier);
    }
    return result;
  }

  async onDutyCashiersAt(checkoutTime) {
    return this.onDutyCashiersFrom(await this.enabledShiftWindows(), checkoutTime);
  }

  async isMonthClosed(targetMonth) {
    const row = await this.db
      .prepare("SELECT 1 FROM import_batches WHERE target_month=? AND is_month_close=1 AND status='success' LIMIT 1")
      .get(String(targetMonth));
    return Boolean(row);
  }

  async pendingCloseMonths(currentMonth) {
    const firstRow = await this.db.prepare("SELECT MIN(order_date) AS value FROM orders").get();
    let first = firstRow?.value;
    if (!first) {
      const batchRow = await this.db.prepare("SELECT MIN(target_month) AS value FROM import_batches WHERE status='success'").get();
      first = batchRow?.value;
    }
    if (!first || !/^\d{4}-\d{2}/.test(first) || !/^\d{4}-\d{2}$/.test(currentMonth)) return [];
    const result = [];
    let [year, month] = first.slice(0, 7).split("-").map(Number);
    while (`${year}-${String(month).padStart(2, "0")}` < currentMonth) {
      const value = `${year}-${String(month).padStart(2, "0")}`;
      if (!(await this.isMonthClosed(value))) result.push(value);
      month += 1;
      if (month === 13) {
        month = 1;
        year += 1;
      }
    }
    return result;
  }

  // ---------- 规则预览与保存 ----------

  async previewRules({ rules, effectiveDate }) {
    const clean = normalizeRules(rules);
    const effectiveFrom = effectiveText(effectiveDate);
    const current = (await this.currentRules()).rules;
    const oldMap = new Map(current.map((rule) => [rule.id, rule]));
    const newMap = new Map(clean.map((rule) => [rule.id, rule]));
    const fieldLabels = { name: "商品名/系列名", packPrice: "包价", cartonPrice: "条价", commission: "提成/包" };
    const changes = [];
    for (const id of new Set([...oldMap.keys(), ...newMap.keys()])) {
      const before = oldMap.get(id);
      const after = newMap.get(id);
      const fields = Object.entries(fieldLabels)
        .filter(([field]) => (before?.[field] ?? null) !== (after?.[field] ?? null))
        .map(([field, label]) => ({ field, label, before: before?.[field] ?? null, after: after?.[field] ?? null }));
      if (fields.length) {
        changes.push({
          id,
          name: after?.name || before?.name || "",
          type: before && after ? "modified" : before ? "deleted" : "added",
          fields,
          before: before || null,
          after: after || null,
          affectedOrders: 0,
        });
      }
    }
    const candidateRows = (await this.rowsFrom(effectiveFrom.slice(0, 10), "9999-12-31")).filter((row) =>
      row.sourceKind === "manual"
        ? hasConcreteCheckoutTime(row.checkoutTime)
          ? row.checkoutTime >= effectiveFrom
          : row.date >= effectiveFrom.slice(0, 10)
        : row.checkoutTime >= effectiveFrom,
    );
    const affectedRows = [];
    let totalBefore = 0;
    let totalAfter = 0;
    for (const row of candidateRows) {
      const after = calculateCommission(row, clean);
      const resultChanged =
        String(row.ruleId || "") !== String(after.ruleId || "") ||
        String(row.ruleName || "") !== String(after.ruleName || "") ||
        number(row.commissionPerUnit) !== number(after.commissionPerUnit) ||
        number(row.commission) !== number(after.commission) ||
        String(row.matchType || "") !== String(after.matchType || "");
      if (!resultChanged) continue;
      affectedRows.push({ row, after });
      totalBefore += number(row.commission);
      totalAfter += number(after.commission);
    }
    for (const change of changes) {
      change.affectedOrders = new Set(
        affectedRows.filter(({ row, after }) => row.ruleId === change.id || after.ruleId === change.id).map(({ row }) => row.orderId || row.lineKey),
      ).size;
    }
    const affected = {
      orders: new Set(affectedRows.map(({ row }) => row.orderId || row.lineKey)).size,
      lines: affectedRows.length,
      totalBefore: roundMoney(totalBefore),
      totalAfter: roundMoney(totalAfter),
      difference: roundMoney(totalAfter - totalBefore),
    };
    const requiresForce = affectedRows.length > 0;
    const confirmationToken = await sha256Hex(JSON.stringify({ rules: clean, effectiveFrom, changes, affected }));
    return { effectiveFrom, changes, affected, requiresForce, confirmationToken };
  }

  async saveRules({ rules, effectiveDate, force = false, confirmationToken = "" }) {
    const clean = normalizeRules(rules);
    if (!clean.length) throw new Error("至少需要一条有效规则");
    const ordinarySave = !force && !String(effectiveDate || "").trim();
    const preview = await this.previewRules({ rules: clean, effectiveDate: ordinarySave ? nowText() : effectiveDate });
    if (preview.requiresForce && !force && !ordinarySave) throw new RuleConflictError(preview);
    if (force && confirmationToken !== preview.confirmationToken) throw new Error("规则影响范围已变化，请重新预览后确认");

    const timestamp = nowText();
    await this.db
      .prepare("UPDATE rule_sets SET superseded_at=? WHERE superseded_at IS NULL AND effective_from>=?")
      .run(timestamp, preview.effectiveFrom);
    const ruleSetId = await this.insertRuleSet(clean, preview.effectiveFrom, "后台维护规则");
    await this.db
      .prepare("UPDATE rule_sets SET superseded_by=? WHERE superseded_at=? AND effective_from>=?")
      .run(ruleSetId, timestamp, preview.effectiveFrom);
    if (force) {
      const updateOrder = this.db.prepare(
        "UPDATE orders SET rule_set_id=?,rule_key=?,rule_name=?,commission_per_unit=?,commission=?,match_type=?,expected_amount=?,min_allowed_amount=?,actual_amount=?,discount_amount=?,discount_rate=?,price_status=?,commission_status=?,audit_status=?,audit_reason=? WHERE line_key=?",
      );
      const updateManual = this.db.prepare(
        "UPDATE manual_orders SET rule_set_id=?,rule_key=?,rule_name=?,commission_per_unit=?,commission=?,match_type=? WHERE id=?",
      );
      const recalcOrderIds = new Set();
      const rows = await this.db.prepare("SELECT * FROM orders WHERE checkout_time>=?").all(preview.effectiveFrom);
      for (const row of rows) {
        const calc = calculateCommission(
          { productName: row.product_name, unit: row.unit, originalQuantity: row.original_quantity, quantity: row.quantity, amount: row.amount, status: row.status },
          clean,
        );
        await updateOrder.run(
          ruleSetId, calc.ruleId, calc.ruleName, calc.commissionPerUnit, calc.commission, calc.matchType, calc.expectedAmount, calc.minAllowedAmount, calc.actualAmount, calc.discountAmount, calc.discountRate, calc.priceStatus, calc.commissionStatus, calc.auditStatus, calc.auditReason, row.line_key,
        );
        if (row.order_id) recalcOrderIds.add(String(row.order_id));
      }
      this.revalidateOrderEligibility([...recalcOrderIds]);
      const manualRows = await this.db.prepare("SELECT * FROM manual_orders WHERE order_date>=?").all(preview.effectiveFrom.slice(0, 10));
      for (const row of manualRows) {
        if (hasConcreteCheckoutTime(row.checkout_time) && row.checkout_time < preview.effectiveFrom) continue;
        const calc = calculateCommission(
          { productName: row.product_name, quantity: row.quantity, amount: number(row.unit_price) * number(row.quantity), status: row.status },
          clean,
        );
        await updateManual.run(ruleSetId, calc.ruleId, calc.ruleName, calc.commissionPerUnit, calc.commission, calc.matchType, row.id);
      }
    }
    return { ruleSetId, rules: clean, effectiveFrom: preview.effectiveFrom, affected: preview.affected };
  }

  // ---------- 手工补录 ----------

  async addManualOrder(entry) {
    const date = String(entry.date || "").slice(0, 10);
    if (!date || !entry.productName || !entry.cashier || number(entry.quantity) <= 0) throw new Error("手工记录缺少日期、商品、收银员或数量");
    const checkoutTime = String(entry.checkoutTime || "").trim() ? effectiveText(entry.checkoutTime) : "";
    const set =
      (await this.ruleSetAt(hasConcreteCheckoutTime(checkoutTime) ? checkoutTime : `${date} 23:59:59`)) || (await this.currentRules());
    const calc = calculateCommission(
      { productName: entry.productName, quantity: entry.quantity, amount: number(entry.unitPrice) * number(entry.quantity), status: "正常" },
      set.rules,
    );
    const id = String(entry.id || `manual-${Date.now()}-${randomHex(4)}`);
    await this.db
      .prepare(`INSERT OR IGNORE INTO manual_orders(id,order_date,checkout_time,product_name,unit_price,quantity,cashier,reason,status,rule_set_id,rule_key,rule_name,commission_per_unit,commission,match_type,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, date, checkoutTime, entry.productName, number(entry.unitPrice), number(entry.quantity), entry.cashier, entry.reason || "", "正常", set.id || set.ruleSetId,
        calc.ruleId, calc.ruleName, calc.commissionPerUnit, calc.commission, calc.matchType, entry.createdAt || nowText());
    return this.db
      .prepare(
        "SELECT id,order_date AS date,checkout_time AS checkoutTime,product_name AS productName,unit_price AS unitPrice,quantity,cashier,reason,rule_name AS ruleName,commission_per_unit AS commissionPerUnit,commission,match_type AS matchType,created_at AS createdAt FROM manual_orders WHERE id=?",
      )
      .get(id);
  }

  async listManualOrders() {
    return this.db
      .prepare(
        "SELECT id,order_date AS date,checkout_time AS checkoutTime,product_name AS productName,unit_price AS unitPrice,quantity,cashier,reason,rule_name AS ruleName,commission_per_unit AS commissionPerUnit,commission,match_type AS matchType,created_at AS createdAt FROM manual_orders ORDER BY order_date DESC,created_at DESC",
      )
      .all();
  }

  async deleteManualOrder(id) {
    const result = await this.db.prepare("DELETE FROM manual_orders WHERE id=?").run(String(id));
    return result.changes > 0;
  }

  // ---------- 行数据 ----------

  async rowsFrom(start, end, store = "") {
    const storeFilter = String(store || "").trim();
    const rows = await this.db
      .prepare(`SELECT 'auto' AS sourceKind,line_key AS lineKey,store,order_id AS orderId,payment_no AS paymentNo,product_id AS productId,product_name AS productName,unit,
      original_quantity AS originalQuantity,quantity,quantity_basis AS quantityBasis,unit_price AS unitPrice,amount,order_amount AS orderAmount,refund,status,cashier,checkout_time AS checkoutTime,order_date AS date,
      rule_key AS ruleId,rule_name AS ruleName,commission_per_unit AS commissionPerUnit,commission,match_type AS matchType,
      expected_amount AS expectedAmount,min_allowed_amount AS minAllowedAmount,actual_amount AS actualAmount,discount_amount AS discountAmount,discount_rate AS discountRate,
      price_status AS priceStatus,commission_status AS commissionStatus,audit_status AS auditStatus,audit_reason AS auditReason,'' AS manualReason
      FROM orders WHERE order_date BETWEEN ? AND ? AND (?='' OR store=?)
      UNION ALL
      SELECT 'manual',id,'',id,'','',product_name,'包',quantity,quantity,'手工补录',unit_price,unit_price*quantity,unit_price*quantity,0,status,cashier,
      COALESCE(NULLIF(checkout_time,''),order_date||' 手工录入'),order_date,
      rule_key,rule_name,commission_per_unit,commission,match_type,
      0,0,unit_price*quantity,0,0,'','','','',reason FROM manual_orders WHERE order_date BETWEEN ? AND ?`)
      .all(start, end, storeFilter, storeFilter, start, end);
    return rows.map((row) =>
      row.sourceKind === "manual" && !hasConcreteCheckoutTime(row.checkoutTime) ? { ...row, checkoutTime: `${row.date} 手工录入` } : row,
    );
  }

  annotateOrderDifferences(rows) {
    const groups = new Map();
    for (const row of rows) {
      const key = row.orderId || row.lineKey;
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const explicitOrderAmount = group.map((row) => number(row.orderAmount)).find((value) => value > 0);
      const orderAmount = roundMoney(explicitOrderAmount ?? group.reduce((sum, row) => sum + number(row.amount), 0));
      const commissioned = (row) => row.status === "正常" && number(row.commissionPerUnit) > 0;
      const commissionSalesAmount = roundMoney(group.reduce((sum, row) => sum + (commissioned(row) ? number(row.amount) : 0), 0));
      const namedNonCommissionRows = group.filter(
        (row) => row.status === "正常" && number(row.amount) > 0 && !isPlaceholderProduct(row.productName) && number(row.commissionPerUnit) <= 0,
      );
      const nonCommissionAmount = roundMoney(namedNonCommissionRows.reduce((sum, row) => sum + number(row.amount), 0));
      const orderDifference = roundMoney(orderAmount - commissionSalesAmount);
      const orderAdjustedAmount = roundMoney(orderAmount - nonCommissionAmount);
      const orderUnexplainedDifference = roundMoney(orderAdjustedAmount - commissionSalesAmount);
      const names = [...new Set(namedNonCommissionRows.map((row) => String(row.productName || "").trim()).filter(Boolean))];
      let orderDifferenceNote = "";
      if (Math.abs(orderDifference) >= 0.01) {
        if (names.length) {
          orderDifferenceNote = `含非提成商品：${names.join("、")}，已扣除¥${nonCommissionAmount.toFixed(2)}`;
          if (Math.abs(orderUnexplainedDifference) >= 0.01) orderDifferenceNote += `；扣除后仍差¥${orderUnexplainedDifference.toFixed(2)}，待核对`;
        } else {
          orderDifferenceNote = `订单实收与提成商品销售额差额¥${orderDifference.toFixed(2)}，待核对`;
        }
      }
      for (const row of group) {
        Object.assign(row, {
          orderAmount,
          commissionSalesAmount,
          nonCommissionAmount,
          orderDifference,
          orderAdjustedAmount,
          orderUnexplainedDifference,
          orderDifferenceFlag: Boolean(orderDifferenceNote),
          orderDifferenceNote,
        });
      }
    }
    return rows;
  }

  async allocationForOrder(orderId, rows = null) {
    const target = String(orderId || "").trim();
    const details = rows || (await this.rowsFrom("0000-01-01", "9999-12-31")).filter((row) => String(row.orderId || "") === target);
    this.annotateOrderDifferences(details);
    const quickRows = details.filter((row) => row.status === "正常" && isPlaceholderProduct(row.productName) && number(row.amount) > 0);
    const commissionRows = details.filter((row) => row.status === "正常" && number(row.commissionPerUnit) > 0);
    const otherNonCommissionRows = details.filter(
      (row) => row.status === "正常" && !isPlaceholderProduct(row.productName) && number(row.commissionPerUnit) <= 0 && number(row.amount) > 0,
    );
    const ambiguousCartonRows = commissionRows.filter((row) => {
      const quantity = number(row.quantity);
      const expected = number(row.expectedAmount);
      return quantity >= 10 && quantity % 10 === 0 && expected > 0 && Math.abs(number(row.amount) - expected) >= 0.01;
    });
    const saved = target
      ? await this.db
          .prepare("SELECT line_key AS lineKey,allocated_amount AS allocatedAmount,note,updated_at AS updatedAt FROM order_amount_allocations WHERE order_id=? ORDER BY line_key")
          .all(target)
      : [];
    const savedMap = new Map(saved.map((item) => [item.lineKey, item]));
    for (const row of details) {
      const manual = savedMap.get(row.lineKey);
      row.manualAllocatedAmount = manual ? number(manual.allocatedAmount) : null;
    }
    const note = saved.find((item) => String(item.note || "").trim())?.note || "";
    const explicitOrderAmount = details.map((row) => number(row.orderAmount)).find((value) => value > 0);
    const orderAmount = roundMoney(explicitOrderAmount ?? details.reduce((sum, row) => sum + number(row.amount), 0));
    const ambiguousLineKeys = new Set(ambiguousCartonRows.map((row) => row.lineKey));
    const defaultCommissionAmount = (row) =>
      ambiguousLineKeys.has(row.lineKey) && number(row.expectedAmount) > 0 ? number(row.expectedAmount) : number(row.amount);
    const item = (row, amount = null) => {
      const allocatedAmount = roundMoney(amount ?? number(row.amount));
      const expectedAmount = roundMoney(number(row.expectedAmount));
      const varianceAmount = expectedAmount > 0 ? roundMoney(allocatedAmount - expectedAmount) : 0;
      return {
        lineKey: row.lineKey,
        productName: row.productName,
        ruleName: row.ruleName || "",
        quantity: number(row.quantity),
        unit: row.unit || "",
        amount: allocatedAmount,
        expectedAmount,
        varianceAmount,
        varianceRate: expectedAmount > 0 ? roundMoney((varianceAmount / expectedAmount) * 100) : 0,
        manualAllocatedAmount: row.manualAllocatedAmount,
      };
    };
    const commissionItems = commissionRows.map((row) => item(row, row.manualAllocatedAmount ?? defaultCommissionAmount(row)));
    const commissionAmount = roundMoney(commissionItems.reduce((sum, row) => sum + number(row.amount), 0));
    const otherNonCommissionItems = otherNonCommissionRows.map((row) => item(row, row.manualAllocatedAmount ?? number(row.amount)));
    const otherNonCommissionAmount = roundMoney(otherNonCommissionItems.reduce((sum, row) => sum + number(row.amount), 0));
    const rawQuickAmount = roundMoney(quickRows.reduce((sum, row) => sum + number(row.amount), 0));
    const useResidualQuickAmount = quickRows.length > 0 && (saved.length > 0 || ambiguousCartonRows.length > 0);
    const quickAmount = useResidualQuickAmount ? roundMoney(orderAmount - commissionAmount - otherNonCommissionAmount) : rawQuickAmount;
    const quickItems = quickRows.map((row, index) => {
      if (row.manualAllocatedAmount != null) return item(row, row.manualAllocatedAmount);
      if (!useResidualQuickAmount || rawQuickAmount <= 0) return item(row);
      const allocated =
        index === quickRows.length - 1
          ? roundMoney(quickAmount - quickRows.slice(0, -1).reduce((sum, quickRow) => sum + roundMoney((quickAmount * number(quickRow.amount)) / rawQuickAmount), 0))
          : roundMoney((quickAmount * number(row.amount)) / rawQuickAmount);
      return item(row, allocated);
    });
    const allocatedTotal = roundMoney(commissionAmount + quickAmount + otherNonCommissionAmount);
    const breakdown = {
      totals: {
        orderAmount,
        commissionAmount,
        quickAmount,
        otherNonCommissionAmount,
        allocatedTotal,
        difference: roundMoney(orderAmount - allocatedTotal),
      },
      commissionItems,
      quickItems,
      otherNonCommissionItems,
    };
    return {
      required: saved.length > 0 || (quickRows.length > 0 && ambiguousCartonRows.length > 0),
      manual: saved.length > 0,
      orderId: target,
      reason:
        quickRows.length > 0 && ambiguousCartonRows.length > 0
          ? "整条/多条订单含快速收银且规则内实收与条价存在差异，建议管理员核对"
          : "普通混合订单已自动扣除非提成/快速收银金额",
      quickAmount,
      commissionAmount,
      nonCommissionAmount: otherNonCommissionAmount,
      breakdown,
      note,
      suggestions: [...commissionRows, ...quickRows, ...otherNonCommissionRows].map((row) => ({
        lineKey: row.lineKey,
        productName: row.productName,
        quantity: number(row.quantity),
        unit: row.unit || "",
        currentAmount: number(row.amount),
        expectedAmount: number(row.expectedAmount),
        suggestedAmount: isPlaceholderProduct(row.productName)
          ? (quickItems.find((item) => item.lineKey === row.lineKey)?.amount ?? number(row.amount))
          : number(row.commissionPerUnit) > 0
            ? defaultCommissionAmount(row)
            : number(row.amount),
        manualAllocatedAmount: savedMap.has(row.lineKey) ? number(savedMap.get(row.lineKey).allocatedAmount) : null,
      })),
    };
  }

  async saveOrderAllocation(orderId, allocations = [], note = "") {
    const target = String(orderId || "").trim();
    if (!target) throw new Error("缺少订单号");
    const rows = (await this.rowsFrom("0000-01-01", "9999-12-31")).filter((row) => String(row.orderId || "") === target);
    if (!rows.length) throw new Error("订单不存在");
    this.annotateOrderDifferences(rows);
    const allowed = new Set(rows.filter((row) => row.status === "正常").map((row) => row.lineKey));
    const clean = (Array.isArray(allocations) ? allocations : [])
      .map((item) => ({ lineKey: String(item.lineKey || "").trim(), amount: roundMoney(number(item.amount)) }))
      .filter((item) => item.lineKey && Number.isFinite(item.amount) && item.amount >= 0);
    if (!clean.length) throw new Error("缺少核对金额明细");
    for (const item of clean) if (!allowed.has(item.lineKey)) throw new Error("核对金额必须对应本订单内的商品、快速收银或其它非提成行");
    const orderAmount = roundMoney(rows.map((row) => number(row.orderAmount)).find((value) => value > 0) ?? rows.reduce((sum, row) => sum + number(row.amount), 0));
    const allocatedTotal = roundMoney(clean.reduce((sum, item) => sum + number(item.amount), 0));
    if (Math.abs(allocatedTotal - orderAmount) >= 0.01) throw new Error(`核对金额合计${allocatedTotal.toFixed(2)}必须等于订单实收${orderAmount.toFixed(2)}`);

    const timestamp = nowText();
    const statements = [{ sql: "DELETE FROM order_amount_allocations WHERE order_id=?", params: [target] }];
    for (const item of clean) {
      statements.push({
        sql: "INSERT INTO order_amount_allocations(order_id,line_key,allocated_amount,note,updated_at) VALUES(?,?,?,?,?)",
        params: [target, item.lineKey, item.amount, String(note || "").trim().slice(0, 200), timestamp],
      });
    }
    if (typeof this.adapter.batch === "function") await this.adapter.batch(statements);
    else for (const statement of statements) await this.adapter.run(statement.sql, statement.params);
    return this.allocationForOrder(target);
  }

  async getOrderDetails(orderId) {
    const target = String(orderId || "").trim();
    if (!target) return [];
    const rows = (await this.rowsFrom("0000-01-01", "9999-12-31")).filter((row) => String(row.orderId || "") === target);
    this.annotateOrderDifferences(rows);
    await this.allocationForOrder(target, rows);
    return rows.sort((a, b) => String(a.checkoutTime).localeCompare(String(b.checkoutTime)) || String(a.lineKey).localeCompare(String(b.lineKey)));
  }

  async exceptionRows({ start = "0000-01-01", end = "9999-12-31", cashier = "", type = "", status = "" } = {}) {
    const rows = this.annotateOrderDifferences(await this.rowsFrom(start, end));
    const isPriceVariance = (row) =>
      ["LOWER_THAN_MIN_PRICE", "UNDER_RECEIVED_PENALTY", "OVER_RECEIVED_BONUS"].includes(row.priceStatus) ||
      ["LOWER_THAN_MIN_PRICE", "UNDER_RECEIVED_PENALTY", "OVER_RECEIVED_BONUS"].includes(row.commissionStatus) ||
      row.auditStatus === "price_variance";
    return rows
      .filter((row) => {
        if (cashier && cashierIdentity(row.cashier) !== cashierIdentity(cashier)) return false;
        if (type && row.priceStatus !== type && row.commissionStatus !== type && row.auditStatus !== type) return false;
        if (status && row.auditStatus !== status && row.commissionStatus !== status) return false;
        const lowPrice = isPriceVariance(row);
        const mismatch = Boolean(row.orderDifferenceNote);
        const pending = row.auditStatus === "pending" || row.auditStatus === "price_variance";
        return lowPrice || mismatch || pending;
      })
      .sort((a, b) => String(b.checkoutTime).localeCompare(String(a.checkoutTime)));
  }

  async getExceptionReport({ start = "0000-01-01", end = "9999-12-31", cashier = "", type = "", status = "", page = 1, pageSize = 500 } = {}) {
    const rows = await this.exceptionRows({ start, end, cashier, type, status });
    const lowRows = rows.filter(
      (row) =>
        ["LOWER_THAN_MIN_PRICE", "UNDER_RECEIVED_PENALTY", "OVER_RECEIVED_BONUS"].includes(row.priceStatus) ||
        ["LOWER_THAN_MIN_PRICE", "UNDER_RECEIVED_PENALTY", "OVER_RECEIVED_BONUS"].includes(row.commissionStatus) ||
        row.auditStatus === "price_variance",
    );
    const size = Math.max(1, Math.min(1000, Number(pageSize) || 500));
    const currentPage = Math.max(1, Number(page) || 1);
    const cancelledCommission = roundMoney(lowRows.reduce((sum, row) => sum + number(row.quantity) * number(row.commissionPerUnit), 0));
    return {
      start,
      end,
      summary: {
        exceptionOrders: new Set(rows.map((row) => row.orderId || row.lineKey)).size,
        exceptionLines: rows.length,
        lowerThanMinPrice: new Set(lowRows.map((row) => row.orderId || row.lineKey)).size,
        orderAmountMismatch: new Set(rows.filter((row) => row.orderDifferenceNote).map((row) => row.orderId || row.lineKey)).size,
        totalLostAmount: roundMoney(lowRows.reduce((sum, row) => sum + Math.max(0, number(row.minAllowedAmount) - number(row.amount)), 0)),
        cancelledCommission,
      },
      rows: rows.slice((currentPage - 1) * size, currentPage * size),
      pagination: { page: currentPage, pageSize: size, total: rows.length },
    };
  }

  async getPeopleExceptionStats(options = {}) {
    const rows = await this.exceptionRows(options);
    const map = new Map();
    for (const row of rows) {
      const name = cashierIdentity(row.cashier) || "未记录";
      const item = map.get(name) || { name, exceptionOrders: new Set(), lowPriceOrders: new Set(), lostAmount: 0, cancelledCommission: 0, discountRates: [] };
      item.exceptionOrders.add(row.orderId || row.lineKey);
      if (
        ["LOWER_THAN_MIN_PRICE", "UNDER_RECEIVED_PENALTY", "OVER_RECEIVED_BONUS"].includes(row.priceStatus) ||
        ["LOWER_THAN_MIN_PRICE", "UNDER_RECEIVED_PENALTY", "OVER_RECEIVED_BONUS"].includes(row.commissionStatus) ||
        row.auditStatus === "price_variance"
      ) {
        item.lowPriceOrders.add(row.orderId || row.lineKey);
        item.lostAmount += Math.max(0, number(row.minAllowedAmount) - number(row.amount));
        item.cancelledCommission += number(row.quantity) * number(row.commissionPerUnit);
      }
      if (number(row.discountRate) > 0) item.discountRates.push(number(row.discountRate));
      map.set(name, item);
    }
    return [...map.values()]
      .map((item) => ({
        name: item.name,
        exceptionOrders: item.exceptionOrders.size,
        lowPriceOrders: item.lowPriceOrders.size,
        lostAmount: roundMoney(item.lostAmount),
        cancelledCommission: roundMoney(item.cancelledCommission),
        avgDiscountRate: item.discountRates.length ? roundMoney(item.discountRates.reduce((sum, value) => sum + value, 0) / item.discountRates.length) : 0,
      }))
      .sort((a, b) => b.exceptionOrders - a.exceptionOrders || b.cancelledCommission - a.cancelledCommission);
  }

  applyShiftSharing(windows, rows) {
    return rows.flatMap((row) => {
      if (row.status !== "正常" || number(row.commission) <= 0 || !hasConcreteCheckoutTime(row.checkoutTime)) return [row];
      const cashiers = this.onDutyCashiersFrom(windows, row.checkoutTime);
      const originalCashier = cashierIdentity(row.cashier);
      if (originalCashier && !cashiers.includes(originalCashier)) cashiers.push(originalCashier);
      if (cashiers.length < 2) return [row];
      const commissions = splitMoney(row.commission, cashiers.length);
      const quantities = splitMoney(row.quantity, cashiers.length);
      const originalQuantities = splitMoney(row.originalQuantity, cashiers.length);
      const amounts = splitMoney(row.amount, cashiers.length);
      return cashiers.map((cashier, index) => ({
        ...row,
        lineKey: `${row.lineKey}#shift-share-${index + 1}`,
        cashier,
        originalCashier: row.cashier,
        originalCommission: number(row.commission),
        originalQuantity: originalQuantities[index],
        quantity: quantities[index],
        amount: amounts[index],
        commission: commissions[index],
        splitCashiers: cashiers.join("、"),
        splitGroupSize: cashiers.length,
        splitIndex: index + 1,
      }));
    });
  }

  async salesTargetForReport(start, end, baseSales, supplementSales = 0) {
    const startMonth = String(start || "").slice(0, 7);
    const endMonth = String(end || "").slice(0, 7);
    const base = roundMoney(baseSales);
    const supplement = roundMoney(supplementSales);
    const actual = roundMoney(base + supplement);
    const currentMonth = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(startMonth) || startMonth !== endMonth) {
      return {
        month: "", targetSales: 0, baseSales: base, supplementSales: supplement, actualSales: actual, progressPercent: 0, remainingSales: 0, exceededSales: 0,
        configured: false, source: "", commissionMultiplier: 1, commissionPayoutRate: 100, commissionTierLabel: "未设置目标",
        commissionPolicyText: "未设置销售目标，提成按原规则全额计算", isCurrentMonth: false, appliesCommissionPayout: false,
      };
    }
    const isCurrentMonth = startMonth === currentMonth;
    const target = await this.getMonthlySalesTarget(startMonth);
    if (!target || number(target.targetSales) <= 0) {
      return {
        month: startMonth, targetSales: number(target?.targetSales), baseSales: base, supplementSales: supplement, actualSales: actual,
        progressPercent: 0, remainingSales: 0, exceededSales: 0, configured: Boolean(target), source: target ? "admin" : "",
        commissionMultiplier: 1, commissionPayoutRate: 100, commissionTierLabel: "未设置目标",
        commissionPolicyText: "未设置有效销售目标，提成按原规则全额计算", isCurrentMonth, appliesCommissionPayout: false,
      };
    }
    const targetSales = number(target.targetSales);
    const progressPercent = roundMoney((actual / targetSales) * 100);
    const payout = this.salesTargetCommissionPayout(progressPercent);
    const appliesCommissionPayout = !isCurrentMonth;
    const commissionPolicyText = appliesCommissionPayout
      ? `历史完整月份：当前达成率${progressPercent.toFixed(2)}%，属于${payout.commissionTierLabel}，按${payout.commissionPayoutRate}%发放`
      : `当前月只提示不正式调整：当前达成率${progressPercent.toFixed(2)}%，属于${payout.commissionTierLabel}；次月1日后查询本月才按最终档位调整`;
    return {
      month: startMonth, targetSales, baseSales: base, supplementSales: supplement, actualSales: actual, progressPercent,
      remainingSales: roundMoney(Math.max(0, targetSales - actual)), exceededSales: roundMoney(Math.max(0, actual - targetSales)),
      configured: true, source: "admin", ...payout, commissionPolicyText, isCurrentMonth, appliesCommissionPayout,
    };
  }

  salesTargetCommissionPayout(progressPercent) {
    const progress = number(progressPercent);
    if (progress < 60) return { commissionMultiplier: 0, commissionPayoutRate: 0, commissionTierLabel: "不足60%档", commissionPolicyText: "实际销售金额不足目标金额的60%，所有提成清零" };
    if (progress < 81) return { commissionMultiplier: 0.7, commissionPayoutRate: 70, commissionTierLabel: "60%-80%档", commissionPolicyText: "实际销售金额达到60.00%-80%，按70%档发放" };
    if (progress < 91) return { commissionMultiplier: 0.9, commissionPayoutRate: 90, commissionTierLabel: "81%-90%档", commissionPolicyText: "实际销售金额达到81%-90%，按90%发放" };
    if (progress < 111) return { commissionMultiplier: 1, commissionPayoutRate: 100, commissionTierLabel: "91%-110%档", commissionPolicyText: "实际销售金额达到91%-110%，按100%发放" };
    if (progress < 131) return { commissionMultiplier: 1.1, commissionPayoutRate: 110, commissionTierLabel: "111%-130%档", commissionPolicyText: "实际销售金额达到111%-130.00%，按110%发放" };
    if (progress <= 150) return { commissionMultiplier: 1.2, commissionPayoutRate: 120, commissionTierLabel: "131%-150%档", commissionPolicyText: "实际销售金额达到131%-150%，按120%发放" };
    return { commissionMultiplier: 1.3, commissionPayoutRate: 130, commissionTierLabel: "超过150%档", commissionPolicyText: "实际销售金额超过150%，按130%发放" };
  }

  async getReport({ start = "0000-01-01", end = "9999-12-31", cashier = "", search = "", mode = "commission", page = 1, pageSize = 500, store = "" } = {}) {
    const windows = await this.enabledShiftWindows();
    let rows = this.applyShiftSharing(windows, this.annotateOrderDifferences(await this.rowsFrom(start, end, store)));
    const needle = String(search || "").trim().toLowerCase();
    rows = rows.filter((row) => {
      if (cashier && cashierIdentity(row.cashier) !== cashierIdentity(cashier)) return false;
      if (needle && !`${row.productName} ${row.orderId} ${row.paymentNo} ${row.ruleName} ${row.cashier} ${row.originalCashier || ""} ${row.splitCashiers || ""} ${row.manualReason} ${row.orderDifferenceNote || ""}`.toLowerCase().includes(needle)) return false;
      const commissioned = number(row.commissionPerUnit) > 0 && row.status === "正常";
      const unmatched = !isPlaceholderProduct(row.productName) && !row.ruleName;
      return mode === "all" || (mode === "unmatched" ? unmatched : commissioned);
    });
    rows.sort((a, b) => String(b.checkoutTime).localeCompare(String(a.checkoutTime)));
    const commissioned = rows.filter((row) => number(row.commissionPerUnit) > 0 && row.status === "正常");
    const uniqueOrders = new Set(commissioned.map((row) => row.orderId));
    const originalTotalCommission = roundMoney(commissioned.reduce((sum, row) => sum + number(row.commission), 0));
    const summary = {
      originalTotalCommission,
      totalCommission: originalTotalCommission,
      totalQuantity: roundMoney(commissioned.reduce((sum, row) => sum + number(row.quantity), 0)),
      totalSales: roundMoney(commissioned.reduce((sum, row) => sum + number(row.amount), 0)),
      orderCount: uniqueOrders.size,
      commissionRows: commissioned.length,
      unmatchedCount: rows.filter((row) => !isPlaceholderProduct(row.productName) && !row.ruleName).length,
    };
    const group = (key) => {
      const map = new Map();
      for (const row of commissioned) {
        const name = typeof key === "function" ? key(row) : row[key];
        const item = map.get(name) || { name: name || "未记录", quantity: 0, commission: 0, sales: 0, orders: new Set() };
        item.quantity += number(row.quantity);
        item.commission += number(row.commission);
        item.sales += number(row.amount);
        item.orders.add(row.orderId);
        map.set(name, item);
      }
      return [...map.values()]
        .map((item) => ({ name: item.name, quantity: roundMoney(item.quantity), commission: roundMoney(item.commission), sales: roundMoney(item.sales), orderCount: item.orders.size }))
        .sort((a, b) => b.commission - a.commission);
    };
    const size = Math.max(1, Math.min(1000, Number(pageSize) || 500));
    const currentPage = Math.max(1, Number(page) || 1);
    const supplementSales = await this.salesTargetSupplementTotal(start, end);
    const salesTarget = await this.salesTargetForReport(start, end, summary.totalSales, supplementSales);
    const multiplier = salesTarget.appliesCommissionPayout ? number(salesTarget.commissionMultiplier, 1) : 1;
    if (multiplier !== 1) {
      for (const row of commissioned) {
        row.originalCommission = number(row.originalCommission || row.commission);
        row.commission = roundMoney(number(row.originalCommission) * multiplier);
      }
      summary.totalCommission = roundMoney(originalTotalCommission * multiplier);
    }
    return {
      start, end, summary, salesTarget,
      people: group((row) => cashierIdentity(row.cashier)),
      products: group((row) => row.ruleName || row.productName),
      daily: group("date"),
      rows: rows.slice((currentPage - 1) * size, currentPage * size),
      pagination: { page: currentPage, pageSize: size, total: rows.length },
    };
  }

  async listStores() {
    const rows = await this.db.prepare("SELECT DISTINCT store FROM orders WHERE store<>'' ORDER BY store").all();
    return rows.map((row) => row.store);
  }

  // 员工提成排行榜：本月提成沿用 getReport 口径（班次均分 + 历史月达成率阶梯发放），
  // 累计总提成为自首月起逐月按同一口径汇总。手工补录单无门店字段，门店筛选时仍计入本店。
  async getLeaderboard({ month = "", store = "" } = {}) {
    const periods = await this.listPeriods();
    const months = periods.months || [];
    const cleanStore = String(store || "").trim();
    const stores = await this.listStores();
    if (cleanStore && !stores.includes(cleanStore)) throw new Error("门店不存在");
    const selectedMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month)) ? String(month) : months.at(-1) || "";
    if (!selectedMonth) {
      return { month: "", store: cleanStore, stores, employees: [], summary: null, months };
    }
    const monthReport = (value) => {
      const bounds = monthBounds(value);
      return this.getReport({ start: bounds.start, end: bounds.end, mode: "commission", page: 1, pageSize: 1, store: cleanStore });
    };
    const current = await monthReport(selectedMonth);
    const cumulative = new Map();
    for (const value of months.filter((item) => item <= selectedMonth)) {
      const report = value === selectedMonth ? current : await monthReport(value);
      for (const person of report.people || []) {
        const item = cumulative.get(person.name) || { commission: 0 };
        item.commission += number(person.commission);
        cumulative.set(person.name, item);
      }
    }
    const monthIndex = months.indexOf(selectedMonth);
    let previousPeriodCommission = null;
    if (monthIndex > 0) previousPeriodCommission = number((await monthReport(months[monthIndex - 1])).summary?.totalCommission);
    const targetSales = number(current.salesTarget?.targetSales);
    const targetConfigured = Boolean(current.salesTarget?.configured) && targetSales > 0;
    const employees = (current.people || [])
      .map((person) => ({
        employeeId: person.name,
        name: person.name,
        currentPeriodCommission: roundMoney(person.commission),
        cumulativeCommission: roundMoney(cumulative.get(person.name)?.commission ?? person.commission),
        sales: roundMoney(person.sales),
        quantity: roundMoney(person.quantity),
        orderCount: person.orderCount,
        progressPercent: targetConfigured ? roundMoney((number(person.sales) / targetSales) * 100) : null,
      }))
      .sort((a, b) => b.currentPeriodCommission - a.currentPeriodCommission || String(a.employeeId).localeCompare(String(b.employeeId), "zh-CN"))
      .map((person, index) => ({ ...person, rank: index + 1 }));
    const periodTotal = number(current.summary?.totalCommission);
    return {
      month: selectedMonth,
      store: cleanStore,
      stores,
      months,
      employees,
      summary: {
        periodTotalCommission: roundMoney(periodTotal),
        previousPeriodCommission: previousPeriodCommission === null ? null : roundMoney(previousPeriodCommission),
        changePercent: previousPeriodCommission ? roundMoney(((periodTotal - previousPeriodCommission) / previousPeriodCommission) * 100) : null,
        orderCount: current.summary?.orderCount || 0,
        totalQuantity: roundMoney(current.summary?.totalQuantity),
        targetConfigured,
        periodTargetSales: targetConfigured ? roundMoney(targetSales) : 0,
        periodActualSales: roundMoney(current.salesTarget?.actualSales),
        periodProgressPercent: targetConfigured ? number(current.salesTarget?.progressPercent) : null,
        remainingTarget: targetConfigured ? number(current.salesTarget?.remainingSales) : null,
        exceededTarget: targetConfigured ? number(current.salesTarget?.exceededSales) : null,
        targetMonth: current.salesTarget?.month || selectedMonth,
        commissionPolicyText: current.salesTarget?.commissionPolicyText || "",
      },
    };
  }

  async listPeriods() {
    const rows = await this.db
      .prepare(`SELECT order_date AS date FROM orders UNION ALL SELECT order_date FROM manual_orders UNION ALL SELECT supplement_date FROM sales_target_supplements ORDER BY date`)
      .all();
    const dates = rows.map((row) => row.date).filter(Boolean);
    return { minDate: dates[0] || "", maxDate: dates.at(-1) || "", months: [...new Set(dates.map((date) => date.slice(0, 7)))].sort() };
  }

  async health() {
    const batch =
      (await this.db.prepare("SELECT completed_at,status,error_message,target_month,row_count FROM import_batches ORDER BY id DESC LIMIT 1").get()) || {};
    const lastSuccess =
      (await this.db
        .prepare("SELECT completed_at,target_month,row_count FROM import_batches WHERE status='success' ORDER BY completed_at DESC,id DESC LIMIT 1")
        .get()) || {};
    const ageMs = lastSuccess.completed_at ? Date.now() - new Date(String(lastSuccess.completed_at).replace(" ", "T") + "+08:00").getTime() : Infinity;
    return { ok: true, database: "ok", lastImport: batch, lastSuccess, stale: ageMs > 7 * 3600 * 1000 };
  }

  async integrityCheck() {
    try {
      const row = await this.db.prepare("PRAGMA integrity_check").get();
      return row?.integrity_check || "ok";
    } catch {
      return "unsupported";
    }
  }
}

