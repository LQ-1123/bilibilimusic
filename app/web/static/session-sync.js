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
  var wasActive = false;    // 上一次快照里本机是否 active（判断「被接管」）
  var pending = null;       // 进行中的移交 {queue,index,position,startedAt,live}
  var liveTransferAt = 0;   // 收到发送端「现报进度」的时刻
  var needGesture = false;  // 需要用户点一下才能出声（自动播放被拦 / canplay 失败）

  function post(path, body) {
    return fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}), cache: "no-store",
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.ok) return d;
        return { __err: r.status, detail: (d && d.detail) || "" };
      });
    });
  }

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
    var session = snap.session || null;
    var nowActive = !!(session && session.activeDeviceId === ME);
    // 本机原本在放、现在会话归别人了（被移交走 或 被抢占）→ 淡出暂停，别两头出声
    if (wasActive && !nowActive) handOverLocally(session);
    wasActive = nowActive;
    snapshot = { session: session, transfer: snap.transfer || null,
                 devices: snap.devices || (snapshot && snapshot.devices) || [] };
    render();
  }

  /** 让出播放：300ms 淡出后暂停（点移交/被抢占都走这里）。 */
  function handOverLocally(session) {
    var media = window.BiliPlayer && BiliPlayer.activeMedia ? BiliPlayer.activeMedia() : null;
    if (!media || media.paused) return;
    var from = media.volume == null ? 1 : media.volume;
    var steps = 8, i = 0;
    var timer = setInterval(function () {
      i += 1;
      try { media.volume = Math.max(0, from * (1 - i / steps)); } catch (e) {}
      if (i >= steps) {
        clearInterval(timer);
        try { media.pause(); media.volume = from; } catch (e) {}
        if (window.__toast) {
          window.__toast(session && session.activeDeviceName
            ? "已在「" + session.activeDeviceName + "」上继续播放" : "已在另一台设备上继续播放");
        }
      }
    }, 38);
  }

  function pct(session) {
    var dur = Number(session && session.song && session.song.duration) || 0;
    if (!dur) return 0;
    return Math.min(100, Math.max(0, Math.round((livePosition(session) / dur) * 100)));
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

    var extra = "";
    var remote = remotePlaying();
    if (remote) {
      var song2 = remote.song || {};
      // 控制器态：能看到对方在放什么、放到哪，并能直接控制它
      extra += '<div class="q-remote">' +
        '<div class="q-remote-line">' + escapeHtml(song2.title || "—") + "</div>" +
        '<div class="q-remote-bar" id="q-remote-bar" title="点一下让对端跳到对应位置"><i style="width:' + pct(remote) + '%"></i></div>' +
        '<div class="q-remote-times"><span>' + fmtTime(livePosition(remote)) + "</span><span>" +
        fmtTime(song2.duration || 0) + "</span></div>" +
        '<div class="q-remote-ctl">' +
        '<button type="button" data-cmd="prev" title="上一首">⏮</button>' +
        '<button type="button" data-cmd="toggle" title="播放/暂停">' + (remote.playing ? "⏸" : "▶") + "</button>" +
        '<button type="button" data-cmd="next" title="下一首">⏭</button>' +
        "</div>" +
        '<button type="button" class="q-resume" id="q-transfer">转到此设备播放</button>' +
        "</div>";
    } else if (!adopting()) {
      extra += '<button type="button" class="q-resume" id="q-resume" hidden></button>';
    }
    if (needGesture && pending) {
      extra += '<button type="button" class="q-resume" id="q-needgesture">点一下继续播放</button>';
    }
    box.innerHTML = '<div class="q-dev-title">设备 · 同账号跨端</div>' + rows.join("") + extra;
    var btn = $("q-resume");
    if (btn) btn.addEventListener("click", function () { resumeHere(); });
    var tr = $("q-transfer");
    if (tr) tr.addEventListener("click", startTransfer);
    var ng = $("q-needgesture");
    if (ng) ng.addEventListener("click", function () { claimNow(); });
    var bar = $("q-remote-bar");
    if (bar) bar.addEventListener("click", function (ev) {
      var s2 = snapshot && snapshot.session;
      var dur = Number(s2 && s2.song && s2.song.duration) || 0;
      if (!dur) return;
      var r = bar.getBoundingClientRect();
      var ratio = Math.min(1, Math.max(0, (ev.clientX - r.left) / Math.max(1, r.width)));
      sendCommand("seek", { position: Math.round(dur * ratio) });
    });
    [].slice.call(box.querySelectorAll("[data-cmd]")).forEach(function (b) {
      b.addEventListener("click", function () { sendCommand(b.dataset.cmd); });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /** 控制器：把命令发给当前 active 的那台设备（经服务端 SSE 转发）。 */
  function sendCommand(type, payload) {
    var s = snapshot && snapshot.session;
    if (!s || !s.activeDeviceId || s.activeDeviceId === ME) return Promise.resolve(null);
    return post("/api/session/command", {
      deviceId: ME, type: type, payload: payload || {}, revision: s.revision,
    }).then(function (res) {
      if (res && res.__err === 409) return hello();               // 版本过期：拉最新快照
      if (res && res.accepted === false && res.reason === "target-offline" && window.__toast) {
        window.__toast("设备未响应");
      }
      return res;
    });
  }

  /** 移交：请对方把播放交到本机（对方现报进度 → 本机预加载 → canplay → claimed）。 */
  function startTransfer() {
    var s = snapshot && snapshot.session;
    if (pending) { window.__toast && window.__toast("正在接管中…"); return Promise.resolve(null); }
    pending = { queue: null, index: 0, position: s ? livePosition(s) : 0, startedAt: Date.now(), live: false };
    return post("/api/session/transfer", {
      fromDeviceId: (s && s.activeDeviceId) || "", toDeviceId: ME,
    }).then(function (res) {
      if (res && res.__err) {
        pending = null;
        window.__toast && window.__toast(res.__err === 409 ? "设备未响应或没有可播会话" : "发起移交失败");
      }
    });
  }

  /** 我是发送端：现场读进度现报（规则①），并**先不暂停**——等 claimed（规则②）。 */
  function onTransferRequest(d) {
    if (!d || d.toDeviceId === ME) return;
    var media = window.BiliPlayer && BiliPlayer.activeMedia ? BiliPlayer.activeMedia() : null;
    var pos = media && isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0;
    post("/api/session/position", { deviceId: ME, position: pos }).catch(function () {});
  }

  /** 我是接收端：等发送端现报（最多 800ms）→ 预加载 seek → canplay → 出声 → claimed。 */
  function onTransferIn(d) {
    if (!d || d.toDeviceId !== ME || !window.BiliPlayer || !BiliPlayer.prepare) return;
    pending = pending || { startedAt: Date.now() };
    pending.queue = d.queue || [];
    pending.index = d.index || 0;
    pending.position = Math.max(pending.position || 0, Number(d.position) || 0);
    var waitLive = setInterval(function () {
      if (pending && pending.live) { clearInterval(waitLive); go(); }
    }, 60);
    setTimeout(function () { clearInterval(waitLive); go(); }, 800);
    var started = false;
    function go() {
      if (started || !pending) return;
      started = true;
      window.__toast && window.__toast("正在接管播放…");
      BiliPlayer.prepare(pending.queue, pending.index, pending.position)
        .then(function () { return BiliPlayer.resume(); })   // 用户点按钮触发 → 算手势
        .then(function () {
          return post("/api/session/claimed", { deviceId: ME, position: pending ? pending.position : 0 });
        })
        .then(function (res) {
          if (res && res.__err) { window.__toast && window.__toast("接管失败，请重试"); pending = null; needGesture = false; return; }
          pending = null;
          needGesture = false;
          window.__toast && window.__toast("已在本机继续播放");
        })
        .catch(function () {
          // canplay 超时 / 自动播放被拦：发送端继续播，这里给一个「点一下继续」
          showResumeFallback();
        });
    }
  }

  function showResumeFallback() {
    needGesture = true;
    render();   // 走渲染而不是 appendChild：设备区每秒重画，append 出来的按钮会被冲掉
  }

  /** 用户点「点一下继续播放」：这一次点击就是手势，play 与 claimed 一起完成。 */
  function claimNow() {
    var at = pending ? pending.position : 0;
    BiliPlayer.resume().then(function () {
      return post("/api/session/claimed", { deviceId: ME, position: at });
    }).then(function (res) {
      if (res && res.__err) {
        needGesture = false; pending = null; render();
        window.__toast && window.__toast("接管已超时，请再点一次「转到此设备播放」");
        return;
      }
      needGesture = false;
      pending = null;
      render();
      window.__toast && window.__toast("已在本机继续播放");
    }).catch(function () { window.__toast && window.__toast("仍然无法播放，请重试"); });
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
    document.addEventListener("bm:sessionChanged", function (e) { applySnapshot(e.detail || {}); });
    document.addEventListener("bm:sessionCommand", function (e) {
      var d = e.detail || {};
      if (d.targetDeviceId !== ME) return;                 // 命令是给 active 那台设备的
      var P = window.BiliPlayer;
      if (!P) return;
      if (d.type === "toggle") P.toggle();
      else if (d.type === "play") { if (!P.isPlaying()) P.toggle(); }
      else if (d.type === "pause") { if (P.isPlaying()) P.toggle(); }
      else if (d.type === "next") P.skip(1);
      else if (d.type === "prev") P.skip(-1);
      else if (d.type === "seek") {
        var media = P.activeMedia ? P.activeMedia() : null;
        if (media && d.payload && isFinite(d.payload.position)) media.currentTime = Math.max(0, d.payload.position);
      }
      setTimeout(function () { report(true); }, 400);
    });
    document.addEventListener("bm:transferRequest", function (e) { onTransferRequest(e.detail || {}); });
    document.addEventListener("bm:transferIn", function (e) { onTransferIn(e.detail || {}); });
    document.addEventListener("bm:transferPosition", function (e) {
      if (pending && e.detail && isFinite(e.detail.position)) { pending.position = e.detail.position; pending.live = true; }
    });
    // 面板打开时每秒重画一次（进度外推），平时不动
    setInterval(function () {
      var qp = $("queue-panel");
      if (qp && !qp.classList.contains("hidden")) render();
    }, 1000);
    window.__sessionSync = {
      deviceId: ME, name: NAME, snapshot: function () { return snapshot; },
      report: report, hello: hello, resumeHere: resumeHere,
      sendCommand: sendCommand, startTransfer: startTransfer, pending: function () { return pending; },
      needGesture: function () { return needGesture; },
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
