/**
 * 方案 A · 同域反代（过渡形态，非容灾）
 * ---------------------------------------------------------------
 * 路由：/autotc/api/*  →  https://aininja365.xyz/autotc/api/*
 *
 * 为什么需要这一层：
 *   app.js:1 与 leaderboard.js:2 的 apiBase 都是相对路径 "/autotc/api"，
 *   看板的主渲染路径是 loadReport() → api("/report")，不是读 data.js。
 *   因此「把静态文件传到 Pages 就能用」不成立；必须在本域上提供同路径接口。
 *
 * 代价（验收与汇报时不得回避）：
 *   新通道运行期硬依赖旧主机在线。旧平板死机时本 Function 返回 502，
 *   前端数据区报错。这不是双活，只是多一个入口。彻底解耦是方案 B（Worker + D1）。
 *
 * 边界：
 *   1. 本 Function 只做透传，不解析业务逻辑，不注入/改写响应体。
 *   2. 二期（2026-10-31）起放行写方法并转发 Cookie，以便后台管理页在新通道可用：
 *      - 允许 GET/HEAD/POST/PUT/PATCH/DELETE
 *      - 透传 Cookie（commission_admin_session，Path=/autotc，天然覆盖 /autotc/api/*）
 *      - 逐条透传 Set-Cookie（登录/登出）
 *      鉴权仍由上游 server.js 判定，未登录的写请求照样 401。
 *   3. 上游 CORS 与本站无关（server.js 的 MXIPOS_ORIGIN_RE 只放行 *.mxipos.com），
 *      同域反代因此天然规避跨域，不需要改动旧主机任何配置。
 */

const UPSTREAM_ORIGIN = "https://aininja365.xyz";
const API_PREFIX = "/autotc/api";

/** 透传给上游的请求头白名单 */
const FORWARD_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "x-requested-with",
  // 后台管理需要登录态：server.js 下发的 commission_admin_session 是 Path=/autotc 的
  // HttpOnly Cookie，浏览器在访问 /autotc/api/* 时会自动带上，必须原样透传
  "cookie",
];

/** 需要从上游响应中剔除的头（由 Workers 运行时重新计算，透传会导致响应体截断） */
const STRIP_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
];

const ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

function jsonError(status, message, detail) {
  const payload = { ok: false, message, via: "pages-proxy" };
  if (detail) payload.detail = detail;
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  // 防呆：手机 token 接收端若被挪到 /autotc/api/ 下，必须先排除再代理，
  // 否则 catch-all 会把上报静默转发去旧主机，新 KV 永远收不到。
  // 当前接收端挂在 /api/mxipos-session（见 functions/api/mxipos-session.js），此判断是护栏。
  if (url.pathname === `${API_PREFIX}/mxipos-session`) {
    return jsonError(404, "该路径不由反代处理，请改用 /api/mxipos-session");
  }

  if (!ALLOWED_METHODS.includes(method)) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: ALLOWED_METHODS.join(", "), "cache-control": "no-store" },
    });
  }

  const target = `${UPSTREAM_ORIGIN}${url.pathname}${url.search}`;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const init = { method, headers, redirect: "manual" };
  if (method !== "GET" && method !== "HEAD") {
    const body = await request.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }

  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    // 旧主机不可达（平板死机 / Tunnel 断开 / Wi-Fi 掉线）
    return jsonError(
      502,
      "上游旧通道不可达，新通道数据区暂不可用",
      String((error && error.message) || error),
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const name of STRIP_RESPONSE_HEADERS) responseHeaders.delete(name);
  // Set-Cookie 必须逐条追加：Headers 构造时可能把多条合并，浏览器会解析失败
  responseHeaders.delete("set-cookie");
  const cookies = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
  for (const cookie of cookies) responseHeaders.append("set-cookie", cookie);
  // 与 nginx `add_header Cache-Control no-store always` 保持同一策略
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-proxy-via", "legacy-aininja365");
  responseHeaders.set("x-proxy-elapsed-ms", String(Date.now() - startedAt));

  const bodyless = method === "HEAD" || upstream.status === 204 || upstream.status === 304;
  return new Response(bodyless ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
