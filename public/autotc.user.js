// ==UserScript==
// @name         MXIPOS 台账自动上报
// @namespace    https://auto.aininja365.xyz/
// @version      2.0.0
// @description  在 MXIPOS 登录后自动把登录凭证报给台账服务器，不用点任何东西
// @author       aininja365
// @match        https://*.mxipos.com/*
// @match        http://*.mxipos.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // 口令不写死在脚本里，也不在部署期注入 —— 否则公网产物里就又出现明文口令，
  // 与 P5-9「Pages 产物无 6 位口令」冲突。改为首次上报时弹一次输入框，
  // 之后存在本机 localStorage（每台手机各自保存，口令本身由店主单独发放）。
  var KEY_STORE = "__autotc_session_key";
  var KEY = "";
  try { KEY = localStorage.getItem(KEY_STORE) || ""; } catch (e) { KEY = ""; }
  var API = "https://auto.aininja365.xyz/api/mxipos-session";
  var LAST = "__autotc_last_token";
  var nextAt = 0;

  function ensureKey() {
    if (KEY) return true;
    var input = "";
    try {
      input = window.prompt("首次上报需要口令（6 位数字，由店主发放，只需输入一次）", "");
    } catch (e) { input = ""; }
    input = String(input || "").trim();
    if (input.length < 4) {
      nextAt = Date.now() + 10 * 60 * 1000; // 10 分钟内不再打扰
      return false;
    }
    KEY = input;
    try { localStorage.setItem(KEY_STORE, KEY); } catch (e) { /* 隐私模式忽略 */ }
    return true;
  }

  function toast(msg, ok) {
    try {
      var d = document.createElement("div");
      d.textContent = msg;
      d.style.cssText = [
        "position:fixed", "right:12px", "bottom:80px", "z-index:2147483647",
        "max-width:78vw", "padding:11px 15px", "border-radius:10px",
        "font:14px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif",
        "color:#fff", "box-shadow:0 4px 18px rgba(0,0,0,.28)",
        "background:" + (ok ? "#12894f" : "#b5342c"),
        "opacity:0", "transition:opacity .25s", "pointer-events:none"
      ].join(";");
      document.body.appendChild(d);
      requestAnimationFrame(function () { d.style.opacity = "1"; });
      setTimeout(function () {
        d.style.opacity = "0";
        setTimeout(function () { d.remove(); }, 400);
      }, ok ? 3200 : 6000);
    } catch (e) { /* 忽略 */ }
  }

  function pick(re, v) {
    var m = v.match(re);
    return m ? m[1] : "";
  }

  function readToken() {
    var stores = [window.localStorage, window.sessionStorage];
    for (var s = 0; s < stores.length; s++) {
      var st = stores[s];
      if (!st) continue;
      for (var i = 0; i < st.length; i++) {
        var v = String(st.getItem(st.key(i)) || "");
        if (v.indexOf("token") < 0) continue;
        var t = v.match(/"token"\s*:\s*"([0-9a-zA-Z]{16,128})"/);
        if (!t) continue;
        return {
          token: t[1],
          timestamp: pick(/"timestamp"\s*:\s*"?(\d{10,16})/, v),
          loginId: pick(/"loginId"\s*:\s*"([^"]{3,32})"/, v),
          mchntCd: pick(/"mchntCd"\s*:\s*"([0-9A-Za-z]{6,32})"/, v),
          singleShopId: pick(/"singleShopId"\s*:\s*"?(\d+)/, v)
        };
      }
    }
    return null;
  }

  function alreadySent(tok) {
    try { return window.localStorage.getItem(LAST) === tok; } catch (e) { return false; }
  }

  function markSent(tok) {
    try { window.localStorage.setItem(LAST, tok); } catch (e) { /* 忽略 */ }
  }

  var busy = false;

  function tick() {
    if (busy || Date.now() < nextAt) return;
    var o = readToken();
    if (!o || !o.token) return;
    if (!o.loginId || !o.mchntCd || !o.timestamp) return;
    if (alreadySent(o.token)) return;
    if (!ensureKey()) return;

    busy = true;
    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Key": KEY },
      body: JSON.stringify(o)
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (res) {
      busy = false;
      var b = res.body || {};
      if (b.ok) {
        markSent(o.token);
        toast("台账已更新（" + o.loginId + "），数据约 15 分钟内同步", true);
      } else {
        nextAt = Date.now() + 30000;
        toast("上报失败：" + (b.message || res.status), false);
      }
    }).catch(function () {
      busy = false;
      nextAt = Date.now() + 30000;
    });
  }

  window.setTimeout(tick, 1200);
  window.setInterval(tick, 5000);
})();
