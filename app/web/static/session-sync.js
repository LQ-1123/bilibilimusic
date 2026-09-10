/* #23 Phase 1：跨端播放会话（只读展示 + 打开即续播）
 *
 * 服务端（app/services/session_bus.py）维护一份按账号隔离的权威会话快照：谁在放、
 * 放到哪、队列是什么。本文件负责：
 *   - 设备注册（localStorage.bmDeviceId，同浏览器多标签算一台）；
 *   - 上报本机状态（切歌/播放暂停/每 5 秒心跳/切回前台）；
 *   - 在播放队列面板里展示各设备在放什么（进度实时外推，±1s）；
 *   - 「从别台设备的进度继续」——把远端队列搬到本机并从同一进度开始。
 *
 * Phase 2 的命令通道（远端 play/pause/next/seek）与移交握手不在这里。
 */
(function () {
  "use strict";

  var DEVICE_KEY = "bmDeviceId";
  var HEARTBEAT_MS = 5000;
  var $ = function (id) { return document.getElementById(id); };

  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    } catch (e) {}
    return "d" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);
  }
  function deviceId() {
    var v = null;
    try { v = localStorage.getItem(DEVICE_KEY); } catch (e) {}
    if (!v || !/^[A-Za-z0-9_-]{6,64}$/.test(v)) {
      v = uuid();
      try { localStorage.setItem(DEVICE_KEY, v); } catch (e) {}
    }
    return v;
  }
  function deviceKind() {
    if (window.BiliMusicNative) return "android";           // Android 壳（含 Chaquopy 后端）
    if (window.__TAURI__ || window.__TAURI_INTERNALS__) return "tauri";
    return "browser";
  }
  function deviceName() {
    var ua = navigator.userAgent || "";
    if (/Android/i.test(ua)) return "Android";
    if (/iPhone/i.test(ua)) return "iPhone";
    if (/iPad/i.test(ua)) return "iPad";
    if (/Mac OS X|Macintosh/i.test(ua)) return "Mac";
    if (/Windows/i.test(ua)) return "Windows";
    if (/Linux/i.test(ua)) return "Linux";
    return "浏览器";
  }

  var MID = document.body.dataset.mid || "";
  var ME = deviceId();
  var NAME = deviceName();
  var KIND = deviceKind();
  var snapshot = null;      // 最近一次快照 {session, devices}
  var lastReport = "";      // 上次上报指纹（去重）
  var lastReportAt = 0;

  // ---------- 本机状态 ----------

  function localState() {
    var P = window.BiliPlayer;
    if (!P || !P.currentSong) return null;
    var song = P.currentSong();
    if (!song) return null;
    var media = P.activeMedia ? P.activeMedia() : null;
    var pos = P.position ? P.position() : null;
    var q = P.queue ? P.queue() : [];
    return {
      deviceId: ME, name: NAME, kind: KIND,
      playing: !!(P.isPlaying && P.isPlaying()),
      position: media && isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0,
      index: pos && pos.index ? pos.index - 1 : 0,
      queue: q,
      repeat: localStorage.getItem("bmPlayMode") || "off",
      shuffle: false,
    };
  }

  function report(force) {
    var state = localState();
    if (!state) return Promise.resolve(null);
    var fp = JSON.stringify([state.playing, state.index, state.queue.length,
      state.queue[state.index] ? state.queue[state.index].bvid : "", Math.round(state.position)]);
    var now = Date.now();
    if (!force && fp === lastReport && now - lastReportAt < HEARTBEAT_MS) return Promise.resolve(null);
    lastReport = fp;
    lastReportAt = now;
    return fetch("/api/session", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
      cache: "no-store",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.preemptedDeviceId) {
          // 本机把别台设备挤下去了：对端会收到 sessionChanged 提示一次
        }
        if (data && data.session) applySnapshot({ session: data.session, devices: snapshot ? snapshot.devices : [] });
        return data;
      })
      .catch(function () { return null; });
  }

  // ---------- 远端快照 ----------

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" + s : s);
  }

  function livePosition(session) {
    if (!session) return 0;
    var pos = Number(session.position) || 0;
    if (session.playing && session.updatedAgo != null) pos += Number(session.updatedAgo) || 0;
    return pos;
  }

  function applySnapshot(snap) {
    if (!snap) return;
    snapshot = { session: snap.session || null, devices: snap.devices || snapshot && snapshot.devices || [] };
    render();
  }

  function remotePlaying() {
    var s = snapshot && snapshot.session;
    if (!s || !s.playing) return null;
    if (s.activeDeviceId === ME) return null;   // 本机就是那个在放的设备
    return s;
  }

  function adopting() { return !!(window.BiliPlayer && BiliPlayer.isPlaying && BiliPlayer.isPlaying()); }

  function render() {
    var box = $("q-devices");
    if (!box) return;
    var devices = (snapshot && snapshot.devices) || [];
    var session = snapshot && snapshot.session;
    if (!devices.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;

    var rows = devices.map(function (d) {
      var me = d.id === ME;
      var isActive = d.active && session && session.activeDeviceId === d.id;
      var state;
      if (isActive && session && session.playing) {
        var song = session.song || {};
        state = "正在播放 · " + (song.title || "—") + " · " + fmtTime(livePosition(session));
      } else if (isActive && session) {
        var s2 = session.song || {};
        state = "已暂停 · " + (s2.title || "—") + " · " + fmtTime(livePosition(session));
      } else if (d.playing) {
        state = "在线 · 未接管";   // 非 active 设备的上报不改会话，别显示成「正在播放」误导
      } else {
        state = d.online ? "空闲" : (d.idleFor != null ? "离线 · " + Math.round(d.idleFor / 60) + " 分钟前" : "离线");
      }
      return '<div class="q-dev' + (me ? " me" : "") + (d.online ? "" : " off") + '" data-device="' + d.id + '">' +
        '<span class="dot"></span>' +
        '<span class="nm">' + escapeHtml(d.name || d.kind) + (me ? "（本机）" : "") + "</span>" +
        '<span class="st">' + escapeHtml(state) + "</span>" +
        "</div>";
    });

    var resume = "";
    var remote = remotePlaying();
    if (remote && !adopting()) {
      var song2 = remote.song || {};
      resume = '<button type="button" class="q-resume" id="q-resume">从 ' +
        escapeHtml(remote.activeDeviceName || "另一台设备") + " 的 " + fmtTime(livePosition(remote)) + " 继续</button>";
    }
    box.innerHTML = '<div class="q-dev-title">设备 · 同账号跨端</div>' + rows.join("") + resume;
    var btn = $("q-resume");
    if (btn) btn.addEventListener("click", function () { resumeHere(); });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /** 打开即续播：把远端队列搬到本机，从同一进度开始（点击即用户手势，不会被拦自动播放）。 */
  function resumeHere() {
    var remote = remotePlaying();
    if (!remote || !window.BiliPlayer || !BiliPlayer.adopt) return;
    fetch("/api/session", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var s = data && data.session;
        if (!s || !s.queue || !s.queue.length) { window.__toast && window.__toast("拿不到对方的播放队列"); return; }
        var ok = BiliPlayer.adopt(s.queue, s.index || 0, livePosition(s));
        if (ok) window.__toast && window.__toast("已从 " + (s.activeDeviceName || "另一台设备") + " 的进度继续");
        else window.__toast && window.__toast("接续失败，请重试");
        setTimeout(function () { report(true); }, 800);
      })
      .catch(function () { window.__toast && window.__toast("网络错误，接续失败"); });
  }

  // ---------- 启动 ----------

  function hello() {
    return fetch("/api/devices/hello", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: ME, name: NAME, kind: KIND }),
      cache: "no-store",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (snap) { applySnapshot(snap); return snap; })
      .catch(function () { return null; });
  }

  function start() {
    if (!document.body.dataset.auth || document.body.dataset.auth !== "1") return; // 未登录不参与
    hello().then(function () { report(true); });
    setInterval(function () {
      var s = localState();
      if (s && s.playing) report(false);
    }, HEARTBEAT_MS);
    ["audio", "audio2"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      ["play", "pause", "ended", "seeked"].forEach(function (ev) {
        el.addEventListener(ev, function () { report(true); });
      });
    });
    var titleEl = $("player-title");
    if (titleEl && window.MutationObserver) {
      new MutationObserver(function () { report(true); }).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { hello().then(function () { report(true); }); }   // 回前台补报 + 拉最新
    });
    window.addEventListener("beforeunload", function () { report(true); });
    // 远端变化：v3.js 把 SSE 的 sessionChanged 转成 DOM 事件（避免第二条 EventSource）
    document.addEventListener("bm:sessionChanged", function (e) {
      var d = e.detail || {};
      applySnapshot(d);
      var pre = d.preemptedDeviceId;
      if (pre && pre === ME && window.__toast) window.__toast("已在另一台设备上继续播放");
    });
    // 面板打开时每秒重画一次（进度外推），平时不动
    setInterval(function () {
      var qp = $("queue-panel");
      if (qp && !qp.classList.contains("hidden")) render();
    }, 1000);
    window.__sessionSync = {
      deviceId: ME, name: NAME, snapshot: function () { return snapshot; },
      report: report, hello: hello, resumeHere: resumeHere,
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
