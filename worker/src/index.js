/**
 * autotc-cron —— 用 Cloudflare Cron Trigger 替代 GitHub 自带的 schedule
 *
 * 为什么需要它：
 *   GitHub 的 schedule 在本仓库实测完全不触发（连续多个 slot 全空，另建探针也空，
 *   而仓库侧条件全部正常）。手机点书签后没人触发流水线，等于"自动更新"不成立。
 *   Cloudflare 的 Cron 准时且免费，用它读 KV 判断是否有新上报，再调 GitHub 的
 *   workflow_dispatch 触发拉单。
 *
 * 判定逻辑（与 pipeline/scripts/ci_session.py 的门禁保持一致）：
 *   1. KV 无会话            → 跳过（等手机上报）
 *   2. 距上次触发 < 10 分钟  → 跳过（防连点）
 *   3. 最近一次运行仍在跑    → 跳过（不排队）
 *   4. 最近一次运行失败且 <60 分钟 → 跳过（失败退避，避免 96 次/天报错）
 *   5. 有未处理的 updatedAt  → 触发（force=false，走门禁正常路径）
 *   6. 距上次触发 ≥ 6 小时   → 触发（force=true，兜底刷新，对齐旧主机 6 小时节奏）
 *
 * 权限：GH_TRIGGER_TOKEN 是细粒度 PAT，仅 autotc-pages 一个仓库、仅「操作：读写」。
 */

const KV_SESSION = "mxipos_session";
const KV_PROCESSED = "session_processed";
const KV_LAST = "worker_last_dispatch";

const COOLDOWN_MS = 10 * 60 * 1000;        // 防连点
const FAIL_BACKOFF_MS = 60 * 60 * 1000;    // 失败退避
const FORCE_REFRESH_MS = 6 * 60 * 60 * 1000; // 兜底刷新

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GH_TRIGGER_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "autotc-cron-worker",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function latestRun(env) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/runs?per_page=1`;
  const response = await fetch(url, { headers: ghHeaders(env) });
  if (!response.ok) return { error: `http ${response.status}` };
  const payload = await response.json();
  const run = (payload.workflow_runs || [])[0];
  if (!run) return { run: null };
  return {
    run: {
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      startedAt: run.run_started_at,
      ageMs: run.run_started_at ? Date.now() - new Date(run.run_started_at).getTime() : null,
    },
  };
}

async function dispatch(env, force) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;
  return fetch(url, {
    method: "POST",
    headers: ghHeaders(env),
    body: JSON.stringify({
      ref: env.GH_REF || "main",
      inputs: { force: force ? "true" : "false", backfill_months: "1" },
    }),
  });
}

async function decide(env) {
  const now = Date.now();

  const raw = await env.MXIPOS_SESSION.get(KV_SESSION);
  if (!raw) {
    return { action: "skip", reason: "KV 中还没有会话，等手机上报" };
  }

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return { action: "skip", reason: "KV 会话不是合法 JSON" };
  }

  const report = String(session.updatedAt || "");
  const processed = String((await env.MXIPOS_SESSION.get(KV_PROCESSED)) || "").trim();
  const last = Number((await env.MXIPOS_SESSION.get(KV_LAST)) || 0);
  const sinceLast = last ? now - last : Number.POSITIVE_INFINITY;

  if (sinceLast < COOLDOWN_MS) {
    return { action: "skip", reason: `距上次触发仅 ${(sinceLast / 60000).toFixed(0)} 分钟，冷却中` };
  }

  const latest = await latestRun(env);
  if (latest.error) {
    return { action: "skip", reason: `查最近运行失败：${latest.error}`, report, processed };
  }
  const run = latest.run;
  if (run && (run.status === "queued" || run.status === "in_progress" || run.status === "waiting")) {
    return { action: "skip", reason: `已有运行在进行中（${run.status}）`, report, processed };
  }
  if (run && run.conclusion === "failure" && run.ageMs !== null && run.ageMs < FAIL_BACKOFF_MS) {
    return {
      action: "skip",
      reason: `最近一次运行失败于 ${Math.round(run.ageMs / 60000)} 分钟前，退避中（多为 token 过期，需手机重新登录上报）`,
      report,
      processed,
    };
  }

  const stale = Boolean(report) && report !== processed;
  if (stale) {
    return { action: "dispatch", force: false, reason: `新上报 ${report}（已处理=${processed || "无"}）`, report, processed };
  }

  if (sinceLast >= FORCE_REFRESH_MS) {
    const hours = Number.isFinite(sinceLast) ? Math.round(sinceLast / 3600000) : "∞";
    return { action: "dispatch", force: true, reason: `兜底刷新：距上次触发 ${hours} 小时`, report, processed };
  }

  return { action: "skip", reason: `本次上报已处理（${report}），无新数据`, report, processed };
}

async function run(env, { dryRun = false } = {}) {
  const decision = await decide(env);
  if (decision.action !== "dispatch" || dryRun) {
    return { ...decision, dispatched: false, dryRun };
  }

  const response = await dispatch(env, decision.force);
  if (response.status === 204) {
    await env.MXIPOS_SESSION.put(KV_LAST, String(Date.now()));
    return { ...decision, dispatched: true, dryRun };
  }
  const detail = (await response.text()).slice(0, 300);
  return { ...decision, dispatched: false, dryRun, error: `http ${response.status}`, detail };
}

export default {
  async scheduled(event, env, ctx) {
    const result = await run(env);
    console.log("[autotc-cron]", JSON.stringify(result));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dry") === "1";
    const result = await run(env, { dryRun });
    return new Response(JSON.stringify({ ok: true, now: new Date().toISOString(), ...result }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
