const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { promises: fs } = require("node:fs");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { CommissionStore, RuleConflictError } = require("./lib/commission_db");
const { DEFAULT_SHIFT_TEMPLATES, PEAK_WINDOWS } = require("./lib/schedule_core");

const COOKIE_NAME = "commission_admin_session";

// ---- 手机书签上报 MXIPOS 会话 ----
// 会话对象与 Cookie 数组分开存放：fetch_orders_and_update.mjs 已占用 mxipos_session.json。
const ROOT_DIR = __dirname;
const DATA_DIR = process.env.COMMISSION_DATA_DIR || path.join(os.homedir(), ".local", "share", "commission_tool");
const MXIPOS_SESSION_FILE = process.env.MXIPOS_API_SESSION_FILE || path.join(DATA_DIR, "mxipos_api_session.json");
const MXIPOS_KEY_FILE = process.env.MXIPOS_SESSION_KEY_FILE || path.join(DATA_DIR, "mxipos_session.key");
const MXIPOS_ORIGIN_RE = /^https?:\/\/([a-z0-9-]+\.)*mxipos\.com(:\d+)?$/i;

function corsHeaders(origin) {
  if (origin && MXIPOS_ORIGIN_RE.test(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Session-Key",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin",
    };
  }
  return { Vary: "Origin" };
}

let sessionKeyCache = { value: "", at: 0 };
async function readSessionKey() {
  if (sessionKeyCache.value && Date.now() - sessionKeyCache.at < 5000) return sessionKeyCache.value;
  let value = "";
  try {
    value = (await fs.readFile(MXIPOS_KEY_FILE, "utf8")).trim();
  } catch {
    value = "";
  }
  sessionKeyCache = { value, at: Date.now() };
  return value;
}

function triggerMxiposFetch() {
  try {
    const child = spawn("python3", [path.join(ROOT_DIR, "scripts", "mxipos_http_fetch.py")], {
      cwd: ROOT_DIR,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch (error) {
    console.error("[mxipos] 触发拉单失败", error);
    return false;
  }
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) reject(new Error("请求内容过大"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error("请求 JSON 格式不正确")); }
    });
    req.on("error", reject);
  });
}

function cookieMap(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  return left.length === right.length && timingSafeEqual(left, right);
}

function validDate(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : fallback;
}

function salesTargetValidationMessage(error) {
  const message = String(error?.message || "");
  if (message.includes("目标月份格式")) return "目标月份格式不正确";
  if (message.includes("销售目标金额")) return "销售目标金额必须大于或等于 0";
  if (message.includes("补录日期格式")) return "补录日期格式不正确";
  if (message.includes("补录销售额")) return "补录销售额必须大于或等于 0";
  if (message.includes("请求 JSON 格式") || message.includes("请求内容过大")) return message;
  return "";
}

function createCommissionServer({ store, password, staticRoot = "" }) {
  if (!store) throw new Error("CommissionStore is required");
  if (!password) throw new Error("COMMISSION_ADMIN_PASSWORD is required");
  const sessions = new Map();

  function token(req) {
    const value = cookieMap(req)[COOKIE_NAME] || "";
    return sessions.has(value) ? value : "";
  }

  function requireAuth(req, res) {
    if (token(req)) return true;
    json(res, 401, { ok: false, message: "请先登录后台" });
    return false;
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname.replace(/^\/autotc\/api/, "/api");

    // ---- 手机书签上报 MXIPOS 会话（跨域） ----
    const origin = String(req.headers.origin || "");
    if (req.method === "OPTIONS" && pathname === "/api/mxipos-session") {
      res.writeHead(204, corsHeaders(origin));
      return res.end();
    }
    if (req.method === "POST" && pathname === "/api/mxipos-session") {
      const cors = corsHeaders(origin);
      const expected = await readSessionKey();
      if (!expected) {
        return json(res, 503, { ok: false, message: "服务端未配置接收口令" }, cors);
      }
      if (!safeEqual(String(req.headers["x-session-key"] || ""), expected)) {
        return json(res, 401, { ok: false, message: "口令不正确" }, cors);
      }
      const body = await readBody(req);
      const session = {
        loginId: String(body.loginId || "").trim(),
        mchntCd: String(body.mchntCd || "").trim(),
        token: String(body.token || "").trim(),
        timestamp: String(body.timestamp || "").trim(),
        singleShopId: String(body.singleShopId || "").trim(),
      };
      if (!session.loginId || !session.mchntCd || !session.token || !session.timestamp) {
        return json(res, 400, { ok: false, message: "缺少 loginId / mchntCd / token / timestamp" }, cors);
      }
      if (!/^[0-9a-zA-Z]{16,128}$/.test(session.token)) {
        return json(res, 400, { ok: false, message: "token 格式不正确" }, cors);
      }
      await fs.mkdir(path.dirname(MXIPOS_SESSION_FILE), { recursive: true });
      const now = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      const record = {
        ...session,
        source: "mobile-bookmarklet",
        updatedAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      };
      await fs.writeFile(MXIPOS_SESSION_FILE, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      const fetchStarted = triggerMxiposFetch();
      console.log(`[mxipos] 会话已更新 loginId=${session.loginId} 拉单触发=${fetchStarted}`);
      return json(res, 200, { ok: true, updated: true, loginId: session.loginId, fetchStarted }, cors);
    }

    if (req.method === "GET" && pathname === "/api/health") return json(res, 200, store.health());
    if (req.method === "GET" && pathname === "/api/report/periods") return json(res, 200, { ok: true, ...store.listPeriods() });
    if (req.method === "GET" && pathname.startsWith("/api/order-details/")) {
      const orderId = decodeURIComponent(pathname.slice("/api/order-details/".length));
      const rows = store.getOrderDetails(orderId);
      return json(res, 200, { ok: true, orderId, rows, allocation: store.allocationForOrder(orderId, rows) });
    }
    if (req.method === "GET" && pathname === "/api/report") {
      const report = store.getReport({
        start: validDate(url.searchParams.get("start"), "0000-01-01"),
        end: validDate(url.searchParams.get("end"), "9999-12-31"),
        cashier: url.searchParams.get("cashier") || "",
        search: url.searchParams.get("search") || "",
        mode: ["all", "commission", "unmatched"].includes(url.searchParams.get("mode")) ? url.searchParams.get("mode") : "commission",
        page: Number(url.searchParams.get("page") || 1),
        pageSize: Number(url.searchParams.get("pageSize") || 500),
      });
      return json(res, 200, { ok: true, ...report, freshness: store.health() });
    }
    if (req.method === "GET" && pathname === "/api/exceptions") {
      const report = store.getExceptionReport({
        start: validDate(url.searchParams.get("start"), "0000-01-01"),
        end: validDate(url.searchParams.get("end"), "9999-12-31"),
        cashier: url.searchParams.get("cashier") || "",
        type: url.searchParams.get("type") || "",
        status: url.searchParams.get("status") || "",
        page: Number(url.searchParams.get("page") || 1),
        pageSize: Number(url.searchParams.get("pageSize") || 500),
      });
      return json(res, 200, { ok: true, ...report, freshness: store.health() });
    }
    if (req.method === "GET" && pathname === "/api/exceptions/people") {
      const people = store.getPeopleExceptionStats({
        start: validDate(url.searchParams.get("start"), "0000-01-01"),
        end: validDate(url.searchParams.get("end"), "9999-12-31"),
        cashier: url.searchParams.get("cashier") || "",
        type: url.searchParams.get("type") || "",
        status: url.searchParams.get("status") || "",
      });
      return json(res, 200, { ok: true, people, freshness: store.health() });
    }
    if (req.method === "GET" && pathname === "/api/leaderboard") {
      try {
        const data = store.getLeaderboard({ month: url.searchParams.get("month") || "", store: url.searchParams.get("store") || "" });
        return json(res, 200, { ok: true, ...data, freshness: store.health() });
      } catch (error) {
        return json(res, 400, { ok: false, message: error.message || "排行榜查询失败" });
      }
    }
    if (req.method === "GET" && pathname === "/api/session") return json(res, 200, { ok: true, authenticated: Boolean(token(req)) });
    if (req.method === "POST" && pathname === "/api/login") {
      const body = await readBody(req);
      if (!safeEqual(body.password || "", password)) return json(res, 401, { ok: false, authenticated: false, message: "密码错误" });
      const value = randomBytes(32).toString("hex");
      sessions.set(value, { createdAt: Date.now() });
      return json(res, 200, { ok: true, authenticated: true }, { "Set-Cookie": `${COOKIE_NAME}=${value}; Path=/autotc; HttpOnly; SameSite=Lax; Max-Age=28800` });
    }
    if (req.method === "POST" && pathname === "/api/logout") {
      const value = token(req);
      if (value) sessions.delete(value);
      return json(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE_NAME}=; Path=/autotc; HttpOnly; SameSite=Lax; Max-Age=0` });
    }

    if (pathname.startsWith("/api/rules") || pathname.startsWith("/api/manual-orders") || pathname.startsWith("/api/order-allocations") || pathname.startsWith("/api/shift-shares") || pathname.startsWith("/api/sales-targets") || pathname.startsWith("/api/sales-target-supplements")) {
      if (!requireAuth(req, res)) return;
    }
    if (req.method === "GET" && pathname === "/api/rules") {
      const current = store.currentRules();
      return json(res, 200, { ok: true, source: "版本化规则台账", hasCustomRules: true, ruleSetId: current.ruleSetId, rules: current.rules });
    }
    if (req.method === "POST" && pathname === "/api/rules/preview") {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...store.previewRules({ rules: body.rules, effectiveDate: body.effectiveDate }) });
    }
    if (req.method === "PUT" && pathname === "/api/rules") {
      const body = await readBody(req);
      try {
        return json(res, 200, { ok: true, source: "版本化规则台账", ...store.saveRules(body) });
      } catch (error) {
        if (error instanceof RuleConflictError) return json(res, 409, { ok: false, code: error.code, message: error.message, ...error.preview });
        throw error;
      }
    }
    if (req.method === "GET" && pathname === "/api/manual-orders") return json(res, 200, { ok: true, entries: store.listManualOrders() });
    if (req.method === "POST" && pathname === "/api/manual-orders") {
      const body = await readBody(req);
      const entries = (Array.isArray(body.entries) ? body.entries : [body]).filter(Boolean).map((entry) => store.addManualOrder(entry));
      return json(res, 200, { ok: true, imported: entries.length, entries: store.listManualOrders() });
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/manual-orders/")) {
      const id = decodeURIComponent(pathname.slice("/api/manual-orders/".length));
      return json(res, 200, { ok: true, deleted: store.deleteManualOrder(id) });
    }
    if (req.method === "PUT" && pathname.startsWith("/api/order-allocations/")) {
      const orderId = decodeURIComponent(pathname.slice("/api/order-allocations/".length));
      try {
        const body = await readBody(req);
        if (!safeEqual(String(body.confirmPassword || ""), "123123")) return json(res, 403, { ok: false, message: "确认密码错误" });
        return json(res, 200, { ok: true, allocation: store.saveOrderAllocation(orderId, body.allocations, body.note) });
      } catch (error) {
        return json(res, 400, { ok: false, message: error.message || "保存分摊失败" });
      }
    }
    if (req.method === "GET" && pathname === "/api/shift-shares") {
      return json(res, 200, { ok: true, windows: store.listShiftShareWindows(), templates: DEFAULT_SHIFT_TEMPLATES, peaks: PEAK_WINDOWS });
    }
    if (req.method === "PUT" && pathname === "/api/shift-shares") {
      const body = await readBody(req);
      const windows = store.saveShiftShareWindows(body.windows || []);
      return json(res, 200, { ok: true, windows });
    }
    if (req.method === "GET" && pathname === "/api/sales-targets") {
      try {
        const month = url.searchParams.get("month") || "";
        const targets = month ? [store.getMonthlySalesTarget(month)].filter(Boolean) : store.listMonthlySalesTargets();
        return json(res, 200, { ok: true, targets });
      } catch (error) {
        const message = salesTargetValidationMessage(error);
        if (message) return json(res, 400, { ok: false, message });
        throw error;
      }
    }
    if (req.method === "PUT" && pathname === "/api/sales-targets") {
      try {
        const body = await readBody(req);
        const target = store.saveMonthlySalesTarget({ month: body.month, targetSales: body.targetSales });
        return json(res, 200, { ok: true, target });
      } catch (error) {
        const message = salesTargetValidationMessage(error);
        if (message) return json(res, 400, { ok: false, message });
        throw error;
      }
    }
    if (req.method === "GET" && pathname === "/api/sales-target-supplements") {
      try {
        const month = url.searchParams.get("month") || "";
        return json(res, 200, { ok: true, supplements: store.listSalesTargetSupplements(month) });
      } catch (error) {
        const message = salesTargetValidationMessage(error);
        if (message) return json(res, 400, { ok: false, message });
        throw error;
      }
    }
    if (req.method === "POST" && pathname === "/api/sales-target-supplements") {
      try {
        const body = await readBody(req);
        const supplement = store.addSalesTargetSupplement({ date: body.date, amount: body.amount, note: body.note });
        return json(res, 200, { ok: true, supplement });
      } catch (error) {
        const message = salesTargetValidationMessage(error);
        if (message) return json(res, 400, { ok: false, message });
        throw error;
      }
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/sales-target-supplements/")) {
      const id = decodeURIComponent(pathname.slice("/api/sales-target-supplements/".length));
      return json(res, 200, { ok: true, deleted: store.deleteSalesTargetSupplement(id) });
    }
    if (staticRoot && req.method === "GET" && url.pathname.startsWith("/autotc/") && !url.pathname.startsWith("/autotc/api/")) {
      const relative = decodeURIComponent(url.pathname.slice("/autotc/".length)) || "index.html";
      const root = path.resolve(staticRoot);
      const filename = path.resolve(root, relative);
      if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) return json(res, 403, { ok: false, message: "禁止访问" });
      try {
        const body = await fs.readFile(filename);
        const extension = path.extname(filename);
        const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
        res.writeHead(200, { "Content-Type": types[extension] || "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-store" });
        return res.end(body);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return json(res, 404, { ok: false, message: "接口不存在" });
  }

  return http.createServer((req, res) => route(req, res).catch((error) => {
    console.error(error);
    json(res, 500, { ok: false, message: "服务器错误" });
  }));
}

if (require.main === module) {
  const filename = process.env.COMMISSION_DB_PATH || path.join(os.homedir(), ".local", "share", "commission_tool", "commission.sqlite3");
  const password = process.env.COMMISSION_ADMIN_PASSWORD;
  const host = process.env.COMMISSION_API_HOST || "127.0.0.1";
  const port = Number(process.env.COMMISSION_API_PORT || process.env.PORT || 3015);
  if (!password) throw new Error("COMMISSION_ADMIN_PASSWORD must be provided by the service environment");
  const store = new CommissionStore(filename);
  const server = createCommissionServer({ store, password, staticRoot: process.env.COMMISSION_STATIC_ROOT || "" });
  server.listen(port, host, () => console.log(`Commission API listening on http://${host}:${port}`));
  const close = () => server.close(() => { store.close(); process.exit(0); });
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

module.exports = { createCommissionServer };
