/**
 * autotc-api —— 新通道后端（Cloudflare Worker + D1）
 *
 * 由旧主机的 backend/server.js（374 行、28 条路由）逐条移植，
 * 路径、方法、响应结构与状态码保持一致，前端一行都不用改。
 *
 * 与旧实现的差异只有三处，都是平台约束：
 *   1. 会话从内存 Map 改为 D1 表 admin_sessions（Worker 实例之间不共享内存）
 *   2. 静态文件不再由本服务提供（Pages 负责）
 *   3. 分摊确认密码从硬编码改为环境变量（原 server.js 里是明文常量）
 */
import { CommissionStore, RuleConflictError } from "./store.js";
import { d1Adapter } from "./adapters/d1.js";
import { DEFAULT_SHIFT_TEMPLATES, PEAK_WINDOWS } from "./schedule_core.js";

const COOKIE_NAME = "commission_admin_session";
const SESSION_TTL_MS = 8 * 3600 * 1000;
const API_PREFIX = "/autotc/api";

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function cookieMap(request) {
  const raw = request.headers.get("cookie") || "";
  const map = {};
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    map[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return map;
}

function safeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function readBody(request) {
  const text = await request.text();
  if (!text) return {};
  if (text.length > 8 * 1024 * 1024) throw new Error("请求内容过大");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("请求 JSON 格式不正确");
  }
}

function setCookie(value, maxAge) {
  return { "set-cookie": `${COOKIE_NAME}=${value}; Path=/autotc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname.replace(/^\/api/, "");
    const apiPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const method = request.method.toUpperCase();

    try {
      const store = new CommissionStore(d1Adapter(env.DB));

      const currentSession = async () => {
        const token = cookieMap(request)[COOKIE_NAME] || "";
        if (!token) return "";
        const row = await env.DB.prepare("SELECT created_at FROM admin_sessions WHERE token=?").bind(token).first();
        if (!row) return "";
        if (Date.now() - Number(row.created_at) > SESSION_TTL_MS) {
          await env.DB.prepare("DELETE FROM admin_sessions WHERE token=?").bind(token).run();
          return "";
        }
        return token;
      };

      // ---------- 内部接口（CI 调用，Bearer 鉴权） ----------
      if (apiPath === "/internal/rules" && method === "GET") {
        const expected = String(env.IMPORT_TOKEN || "");
        const provided = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        if (!expected) return json({ ok: false, message: "服务端未配置导入令牌" }, 503);
        if (!safeEqual(provided, expected)) return json({ ok: false, message: "导入令牌不正确" }, 401);
        const current = await store.currentRules();
        return json({ ok: true, ruleSetId: current.ruleSetId, rules: current.rules });
      }

      if (method === "POST" && apiPath === "/internal/import") {
        const expected = String(env.IMPORT_TOKEN || "");
        const provided = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        if (!expected) return json({ ok: false, message: "服务端未配置导入令牌" }, 503);
        if (!safeEqual(provided, expected)) return json({ ok: false, message: "导入令牌不正确" }, 401);
        const body = await readBody(request);
        const imported = await store.importOrders({
          targetMonth: body.targetMonth,
          sourceFilename: body.sourceFilename || "ci-import",
          sourceSha256: body.sourceSha256 || "",
          orders: body.orders || [],
          fallbackRules: body.fallbackRules || [],
        });
        return json({ ok: true, ...imported });
      }

      // ---------- 只读接口 ----------
      if (method === "GET" && apiPath === "/health") return json(await store.health());
      if (method === "GET" && apiPath === "/report/periods") return json({ ok: true, ...(await store.listPeriods()) });

      if (method === "GET" && apiPath.startsWith("/order-details/")) {
        const orderId = decodeURIComponent(apiPath.slice("/order-details/".length));
        const rows = await store.getOrderDetails(orderId);
        return json({ ok: true, orderId, rows, allocation: await store.allocationForOrder(orderId, rows) });
      }

      if (method === "GET" && apiPath === "/report") {
        const report = await store.getReport({
          start: validDate(url.searchParams.get("start"), "0000-01-01"),
          end: validDate(url.searchParams.get("end"), "9999-12-31"),
          cashier: url.searchParams.get("cashier") || "",
          search: url.searchParams.get("search") || "",
          mode: ["all", "commission", "unmatched"].includes(url.searchParams.get("mode")) ? url.searchParams.get("mode") : "commission",
          page: Number(url.searchParams.get("page") || 1),
          pageSize: Number(url.searchParams.get("pageSize") || 500),
        });
        return json({ ok: true, ...report, freshness: await store.health() });
      }

      if (method === "GET" && apiPath === "/exceptions") {
        const report = await store.getExceptionReport({
          start: validDate(url.searchParams.get("start"), "0000-01-01"),
          end: validDate(url.searchParams.get("end"), "9999-12-31"),
          cashier: url.searchParams.get("cashier") || "",
          type: url.searchParams.get("type") || "",
          status: url.searchParams.get("status") || "",
          page: Number(url.searchParams.get("page") || 1),
          pageSize: Number(url.searchParams.get("pageSize") || 500),
        });
        return json({ ok: true, ...report, freshness: await store.health() });
      }

      if (method === "GET" && apiPath === "/exceptions/people") {
        const people = await store.getPeopleExceptionStats({
          start: validDate(url.searchParams.get("start"), "0000-01-01"),
          end: validDate(url.searchParams.get("end"), "9999-12-31"),
          cashier: url.searchParams.get("cashier") || "",
          type: url.searchParams.get("type") || "",
          status: url.searchParams.get("status") || "",
        });
        return json({ ok: true, people, freshness: await store.health() });
      }

      if (method === "GET" && apiPath === "/leaderboard") {
        try {
          const data = await store.getLeaderboard({ month: url.searchParams.get("month") || "", store: url.searchParams.get("store") || "" });
          return json({ ok: true, ...data, freshness: await store.health() });
        } catch (error) {
          return json({ ok: false, message: error.message || "排行榜查询失败" }, 400);
        }
      }

      // ---------- 登录态 ----------
      if (method === "GET" && apiPath === "/session") return json({ ok: true, authenticated: Boolean(await currentSession()) });

      if (method === "POST" && apiPath === "/login") {
        const body = await readBody(request);
        const password = String(env.ADMIN_PASSWORD || "");
        if (!password) return json({ ok: false, message: "服务端未配置后台密码" }, 503);
        if (!safeEqual(body.password || "", password)) return json({ ok: false, authenticated: false, message: "密码错误" }, 401);
        const token = randomToken();
        await env.DB.prepare("INSERT INTO admin_sessions(token,created_at) VALUES(?,?)").bind(token, Date.now()).run();
        await env.DB.prepare("DELETE FROM admin_sessions WHERE created_at<?").bind(Date.now() - 7 * 24 * 3600 * 1000).run();
        return json({ ok: true, authenticated: true }, 200, setCookie(token, 28800));
      }

      if (method === "POST" && apiPath === "/logout") {
        const token = cookieMap(request)[COOKIE_NAME] || "";
        if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token=?").bind(token).run();
        return json({ ok: true }, 200, setCookie("", 0));
      }

      // ---------- 以下接口需要登录 ----------
      const guarded = ["/rules", "/manual-orders", "/order-allocations", "/shift-shares", "/sales-targets", "/sales-target-supplements"];
      if (guarded.some((prefix) => apiPath.startsWith(prefix))) {
        if (!(await currentSession())) return json({ ok: false, message: "请先登录后台" }, 401);
      }

      if (method === "GET" && apiPath === "/rules") {
        const current = await store.currentRules();
        return json({ ok: true, source: "版本化规则台账", hasCustomRules: true, ruleSetId: current.ruleSetId, rules: current.rules });
      }
      if (method === "POST" && apiPath === "/rules/preview") {
        const body = await readBody(request);
        return json({ ok: true, ...(await store.previewRules({ rules: body.rules, effectiveDate: body.effectiveDate })) });
      }
      if (method === "PUT" && apiPath === "/rules") {
        const body = await readBody(request);
        try {
          return json({ ok: true, source: "版本化规则台账", ...(await store.saveRules(body)) });
        } catch (error) {
          if (error instanceof RuleConflictError) return json({ ok: false, code: error.code, message: error.message, ...error.preview }, 409);
          throw error;
        }
      }

      if (method === "GET" && apiPath === "/manual-orders") return json({ ok: true, entries: await store.listManualOrders() });
      if (method === "POST" && apiPath === "/manual-orders") {
        const body = await readBody(request);
        const list = (Array.isArray(body.entries) ? body.entries : [body]).filter(Boolean);
        const entries = [];
        for (const entry of list) entries.push(await store.addManualOrder(entry));
        return json({ ok: true, imported: entries.length, entries: await store.listManualOrders() });
      }
      if (method === "DELETE" && apiPath.startsWith("/manual-orders/")) {
        const id = decodeURIComponent(apiPath.slice("/manual-orders/".length));
        return json({ ok: true, deleted: await store.deleteManualOrder(id) });
      }

      if (method === "PUT" && apiPath.startsWith("/order-allocations/")) {
        const orderId = decodeURIComponent(apiPath.slice("/order-allocations/".length));
        const expect = String(env.ALLOCATION_CONFIRM_PASSWORD || "");
        if (!expect) return json({ ok: false, message: "服务端未配置分摊确认密码" }, 503);
        try {
          const body = await readBody(request);
          if (!safeEqual(String(body.confirmPassword || ""), expect)) return json({ ok: false, message: "确认密码错误" }, 403);
          return json({ ok: true, allocation: await store.saveOrderAllocation(orderId, body.allocations, body.note) });
        } catch (error) {
          return json({ ok: false, message: error.message || "保存分摊失败" }, 400);
        }
      }

      if (method === "GET" && apiPath === "/shift-shares") {
        return json({ ok: true, windows: await store.listShiftShareWindows(), templates: DEFAULT_SHIFT_TEMPLATES, peaks: PEAK_WINDOWS });
      }
      if (method === "PUT" && apiPath === "/shift-shares") {
        const body = await readBody(request);
        const windows = await store.saveShiftShareWindows(body.windows || []);
        return json({ ok: true, windows });
      }

      if (method === "GET" && apiPath === "/sales-targets") {
        try {
          const month = url.searchParams.get("month") || "";
          const targets = month ? [(await store.getMonthlySalesTarget(month))].filter(Boolean) : await store.listMonthlySalesTargets();
          return json({ ok: true, targets });
        } catch (error) {
          const message = salesTargetValidationMessage(error);
          if (message) return json({ ok: false, message }, 400);
          throw error;
        }
      }
      if (method === "PUT" && apiPath === "/sales-targets") {
        try {
          const body = await readBody(request);
          const target = await store.saveMonthlySalesTarget({ month: body.month, targetSales: body.targetSales });
          return json({ ok: true, target });
        } catch (error) {
          const message = salesTargetValidationMessage(error);
          if (message) return json({ ok: false, message }, 400);
          throw error;
        }
      }
      if (method === "GET" && apiPath === "/sales-target-supplements") {
        try {
          const month = url.searchParams.get("month") || "";
          return json({ ok: true, supplements: await store.listSalesTargetSupplements(month) });
        } catch (error) {
          const message = salesTargetValidationMessage(error);
          if (message) return json({ ok: false, message }, 400);
          throw error;
        }
      }
      if (method === "POST" && apiPath === "/sales-target-supplements") {
        try {
          const body = await readBody(request);
          const supplement = await store.addSalesTargetSupplement({ date: body.date, amount: body.amount, note: body.note });
          return json({ ok: true, supplement });
        } catch (error) {
          const message = salesTargetValidationMessage(error);
          if (message) return json({ ok: false, message }, 400);
          throw error;
        }
      }
      if (method === "DELETE" && apiPath.startsWith("/sales-target-supplements/")) {
        const id = decodeURIComponent(apiPath.slice("/sales-target-supplements/".length));
        return json({ ok: true, deleted: await store.deleteSalesTargetSupplement(id) });
      }

      return json({ ok: false, message: "接口不存在" }, 404);
    } catch (error) {
      return json({ ok: false, message: "服务器错误", detail: String(error?.message || error).slice(0, 300) }, 500);
    }
  },
};
