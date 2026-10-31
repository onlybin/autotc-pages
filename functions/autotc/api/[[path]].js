/**
 * 同域反代（目标后端已切到 Cloudflare Worker + D1）
 * ---------------------------------------------------------------
 * 路由：/autotc/api/*  →  https://autotc-api.<subdomain>.workers.dev/autotc/api/*
 *
 * 为什么保留这一层：
 *   app.js / leaderboard.js / manual_page.js 的 apiBase 都是 "/autotc/api"，
 *   前端一行都不用改；另外 workers.dev 域名在国内被墙，浏览器直连不通，
 *   经本站边缘节点转发则不受影响。
 *
 * 与一期（方案 A）的本质区别：
 *   过去反代到旧主机，旧平板一断电新通道就废；
 *   现在反代到 D1 后端，**旧主机断电、断网、被搬走都不影响新通道**。
 *   旧通道（aininja365.xyz/autotc/）仍跑它自己的 nginx + SQLite，两套互不依赖。
 *
 * 边界：
 *   1. 只做透传，不解析业务逻辑，不注入/改写响应体。
 *   2. 放行 GET/HEAD/POST/PUT/PATCH/DELETE，透传 Cookie 并逐条回传 Set-Cookie，
 *      以便后台管理页在新通道可用；鉴权由上游 Worker 判定。
 *   3. 同域，无跨域问题。
 */

const UPSTREAM_ORIGIN = "https://autotc-api.tel18207595.workers.dev";
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
      "上游 D1 后端不可达，请稍后重试",
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
  responseHeaders.set("x-proxy-via", "d1-worker");
  responseHeaders.set("x-proxy-elapsed-ms", String(Date.now() - startedAt));

  const bodyless = method === "HEAD" || upstream.status === 204 || upstream.status === 304;
  return new Response(bodyless ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
