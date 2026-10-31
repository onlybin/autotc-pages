/**
 * 手机 token 接收端（决策 4-A：新域名 + Cloudflare KV）
 * ---------------------------------------------------------------
 * 路由：POST /api/mxipos-session
 *
 * 契约与旧通道 server.js 的 /api/mxipos-session 保持一致：
 *   - OPTIONS 预检 → 204 + CORS
 *   - CORS 只放行 *.mxipos.com（正则与 server.js 的 MXIPOS_ORIGIN_RE 完全相同，
 *     与本站域名无关，换域名不用改——这点容易被误判）
 *   - X-Session-Key 口令校验（口令来自 Pages Secret，不落盘、不进仓库）
 *
 * 与旧实现的差异（3 处，都是 Pages 平台的强制约束）：
 *   1. 没有文件系统 → 写 KV（key: mxipos_session），value 与 mxipos_api_session.json 同构。
 *   2. 不能 spawn 子进程 → 不直接触发拉单，改为 Actions cron 轮询 KV 的 timestamp 变化。
 *   3. 口令不存在文件里 → 读 env.MXIPOS_SESSION_KEY（wrangler secret put 写入）。
 *
 * 安全定级：口令只防接口滥发，不防手机持有者。手机书架/书签里的明文口令
 * 是书签方案的固有特性，P5 第 9 项「无凭据泄露」的检查范围不含手机端本地书签。
 */

const MXIPOS_ORIGIN_RE = /^https?:\/\/([a-z0-9-]+\.)*mxipos\.com(:\d+)?$/i;
const KV_KEY = "mxipos_session";
const TOKEN_RE = /^[0-9a-zA-Z]{16,128}$/;

function corsHeaders(origin) {
  if (origin && MXIPOS_ORIGIN_RE.test(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Session-Key",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }
  return { Vary: "Origin" };
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(extra || {}),
    },
  });
}

/** 定长比较，避免按字符提前返回泄露口令长度与字符分布 */
function safeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/** 北京时间字符串，格式与远端 mxipos_api_session.json 的 updatedAt 一致 */
function beijingTimestamp(date) {
  const shifted = new Date((date ? date.getTime() : Date.now()) + 8 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`,
  ].join(" ");
}

function pickText(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max || 256);
}

export function onRequestOptions(context) {
  const origin = String(context.request.headers.get("origin") || "");
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = String(request.headers.get("origin") || "");
  const cors = corsHeaders(origin);

  const expected = String((env && env.MXIPOS_SESSION_KEY) || "").trim();
  if (!expected) {
    // 与 server.js 同语义：未配置口令一律拒绝，绝不降级放行
    return json({ ok: false, message: "服务端未配置接收口令" }, 503, cors);
  }
  if (!safeEqual(String(request.headers.get("x-session-key") || "").trim(), expected)) {
    return json({ ok: false, message: "口令不正确" }, 401, cors);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: "请求体不是合法 JSON" }, 400, cors);
  }
  if (!payload || typeof payload !== "object") {
    return json({ ok: false, message: "请求体格式不正确" }, 400, cors);
  }

  const session = {
    loginId: pickText(payload.loginId, 32),
    mchntCd: pickText(payload.mchntCd, 64),
    token: pickText(payload.token, 128),
    timestamp: pickText(payload.timestamp, 16),
    singleShopId: pickText(payload.singleShopId, 64),
  };

  if (!session.loginId || !session.mchntCd || !session.token || !session.timestamp) {
    return json(
      { ok: false, message: "缺少 loginId / mchntCd / token / timestamp" },
      400,
      cors,
    );
  }
  if (!TOKEN_RE.test(session.token)) {
    return json({ ok: false, message: "token 格式不正确" }, 400, cors);
  }
  if (!/^\d{10,16}$/.test(session.timestamp)) {
    return json({ ok: false, message: "timestamp 应为 10~16 位毫秒时间戳" }, 400, cors);
  }

  const store = env && env.MXIPOS_SESSION;
  if (!store || typeof store.put !== "function") {
    return json({ ok: false, message: "KV 绑定 MXIPOS_SESSION 未配置" }, 503, cors);
  }

  const record = {
    ...session,
    source: "mobile-bookmarklet",
    updatedAt: beijingTimestamp(),
  };

  try {
    await store.put(KV_KEY, JSON.stringify(record, null, 2), {
      // metadata 让 Actions 能只读列表就判断新鲜度，省一次 value 读取
      metadata: { timestamp: session.timestamp, updatedAt: record.updatedAt },
    });
  } catch (error) {
    return json(
      { ok: false, message: "写入 KV 失败", detail: String((error && error.message) || error) },
      500,
      cors,
    );
  }

  return json(
    {
      ok: true,
      updated: true,
      loginId: session.loginId,
      // 平台不能 spawn 子进程，拉单由 Actions cron 轮询 KV 的 timestamp 变化触发
      fetchTriggered: false,
      mode: "kv-poll",
      updatedAt: record.updatedAt,
    },
    200,
    cors,
  );
}

export function onRequestGet() {
  return json({ ok: false, message: "请使用 POST 上报会话" }, 405, {
    allow: "POST, OPTIONS",
  });
}
