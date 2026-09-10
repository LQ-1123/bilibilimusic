/* #23 Phase 1：跨端播放会话（只读展示 + 打开即续播）
 *
 * 服务端（app/services/session_bus.py）维护一份按账号隔离的权威会话快照：谁在放、
 * 放到哪、队列是什么。本文件负责：
 *   - 设备注册（localStorage.bmDeviceId，同浏览器多标签算一台）；
 *   - 上报本机状态（切歌/播放暂停/每 5 秒心跳/切回前台）；
 *   - 「设备」页（#view-devices）实时渲染：各设备在放什么、遥控在放的设备、
 *     把播放串流到本机（#26：设备 UI 已从播放队列面板迁到独立页）；
 *   - Android 端展示局域网内可连接的电脑后端（扫描/连接/断开）。
 */
(function () {
  "use strict";

  var DEVICE_KEY = "bmDeviceId";
  var HEARTBEAT_MS = 5000;
  var HANDOFF_FADE_MS = 350;   // #23 Phase 3：交接交叉淡入淡出时长（两端同一窗口，中间不留静音缝）
  var $ = function (id) { return document.getElementById(id); };

  /** 音量线性淡入/淡出，返回 Promise（交叉淡入用；比 WebAudio 简单，够用且不影响既有的本地交叉淡入）。 */
  function fade(media, to, ms) {
    return new Promise(function (resolve) {
      if (!media || typeof media.volume !== "number") { resolve(); return; }
      var from = media.volume, steps = Math.max(4, Math.round(ms / 40)), i = 0;
      var timer = setInterval(function () {
        i += 1;
        try { media.volume = Math.max(0, Math.min(1, from + (to - from) * (i / steps))); } catch (e) {}
        if (i >= steps) {
          clearInterval(timer);
          try { media.volume = to; } catch (e) {}
          resolve();
        }
      }, Math.max(16, Math.round(ms / steps)));
    });
  }

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
  var NATIVE = window.BiliMusicNative || null;   // Android 原生桥（#26 局域网发现只有手机端有）
  var REMOTE_BACKEND = NATIVE && !/^(127\.0\.0\.1|localhost)$/.test(location.hostname || "");
  var backends = [];        // #26 最近一次扫描到的局域网电脑后端 [{url,name,loggedIn}]
  var snapshot = null;      // 最近一次快照 {session, devices}
  var lastReport = "";      // 上次上报指纹（去重）
  var lastReportAt = 0;
  var wasActive = false;    // 上一次快照里本机是否 active（判断「被接管」）
  var pending = null;       // 进行中的移交 {queue,index,position,startedAt,live}
  var liveTransferAt = 0;   // 收到发送端「现报进度」的时刻
  var needGesture = false;  // 需要用户点一下才能出声（自动播放被拦 / canplay 失败）
  var yielding = false;     // 正在把播放让给别的设备（淡出期间不能再说自己在播）

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
      playing: yielding ? false : !!(P.isPlaying && P.isPlaying()),
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
    if (pageOn()) renderPage();
  }

  function pageOn() {
    var v = $("view-devices");
    return !!(v && v.classList.contains("on"));
  }

  /** 让出播放（点移交 / 被抢占都走这里）：#23 Phase 3 交叉淡出——接收端此时正好在淡入，
   *  两端的音量斜坡落在同一个窗口里，中间不留静音缝。 */
  function handOverLocally(session) {
    var media = window.BiliPlayer && BiliPlayer.activeMedia ? BiliPlayer.activeMedia() : null;
    if (!media || media.paused) return;
    yielding = true;   // 立刻对自己的上报口径生效：淡出期间别再声明 playing（否则会把会话抢回来）
    var back = typeof media.volume === "number" ? media.volume : 1;
    fade(media, 0, HANDOFF_FADE_MS).then(function () {
      try { media.pause(); media.volume = back; } catch (e) {}
      yielding = false;
      if (window.__toast) {
        window.__toast(session && session.activeDeviceName
          ? "已在「" + session.activeDeviceName + "」上继续播放" : "已在另一台设备上继续播放");
      }
    });
  }

  function pct(session) {
    var dur = Number(session && session.song && session.song.duration) || 0;
    if (!dur) return 0;
    return Math.min(100, Math.max(0, Math.round((livePosition(session) / dur) * 100)));
  }

  /** 会话 active 在别的设备上（在放或暂停都算）→ 本机是控制器态。 */
  function remoteActive() {
    var s = snapshot && snapshot.session;
    if (!s || !s.activeDeviceId || s.activeDeviceId === ME) return null;
    return s;
  }

  function adopting() { return !!(window.BiliPlayer && BiliPlayer.isPlaying && BiliPlayer.isPlaying()); }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  var esc = escapeHtml;

  // ---------- 设备页渲染（#26：从播放队列面板迁出的整页版） ----------

  function devRow(d) {
    var me = d.id === ME;
    var session = snapshot && snapshot.session;
    var isActive = d.active && session && session.activeDeviceId === d.id;
    var state;
    if (isActive && session && session.playing) state = "正在播放";
    else if (isActive && session) state = "已暂停";
    else if (d.playing) state = "在线 · 未接管";
    else state = d.online ? "空闲" : (d.idleFor != null ? "离线 · " + Math.round(d.idleFor / 60) + " 分钟前" : "离线");
    return '<div class="dv-row' + (me ? " me" : "") + (d.online ? "" : " off") + '">' +
      '<span class="dot' + (isActive ? " on" : "") + '"></span>' +
      '<span class="nm">' + esc(d.name || d.kind) + (me ? "（本机）" : "") + "</span>" +
      '<span class="st">' + esc(state) + "</span></div>";
  }

  function controllerCard(session) {
    var song = session.song || {};
    var playing = !!session.playing;
    return '<div class="dv-sec"><div class="dv-title">正在播放 · ' +
        esc(session.activeDeviceName || "其他设备") + (playing ? "" : " · 已暂停") + '</div>' +
      '<div class="dv-now">' +
        (song.coverUrl ? '<img class="dv-cover" src="' + esc(song.coverUrl) + '" alt="" referrerpolicy="no-referrer">' : '<div class="dv-cover dv-nocov">♪</div>') +
        '<div class="dv-main">' +
          '<div class="dv-song">' + esc(song.title || "—") + '</div>' +
          '<div class="dv-artist">' + esc(song.artist || "") + '</div>' +
          '<div class="dv-bar" id="dv-bar" title="点一下让对端跳到对应位置"><i style="width:' + pct(session) + '%"></i></div>' +
          '<div class="dv-times"><span>' + fmtTime(livePosition(session)) + "</span><span>" + fmtTime(song.duration || 0) + "</span></div>" +
          '<div class="dv-ctl">' +
            '<button type="button" data-cmd="prev" title="上一首">⏮</button>' +
            '<button type="button" data-cmd="toggle" class="big" title="播放/暂停">' + (playing ? "⏸" : "▶") + "</button>" +
            '<button type="button" data-cmd="next" title="下一首">⏭</button>' +
          "</div>" +
        "</div>" +
      "</div>" +
      '<button type="button" class="dv-stream" id="dv-stream">⇢ 串流到本机播放</button>' +
      "</div>";
  }

  function renderBackends() {
    if (!NATIVE || !NATIVE.scanBackends) return "";
    var html = '<div class="dv-sec"><div class="dv-title">局域网 · 电脑端</div>';
    if (REMOTE_BACKEND) {
      html += '<div class="dv-note">当前连接 <b>' + esc(location.hostname) + '</b> —— 界面与曲库来自电脑后端，播放从本机出声。</div>' +
        '<button type="button" class="dv-scan" id="dv-use-embedded">断开，回到手机本机</button>';
    } else if (backends.length) {
      backends.slice(0, 6).forEach(function (b, i) {
        html += '<div class="dv-row lan"><span class="dot on"></span>' +
          '<span class="nm">' + esc(b.name || b.url) + '</span>' +
          '<button type="button" class="dv-link" data-bem="' + i + '">连接</button></div>';
      });
      html += '<button type="button" class="dv-scan" id="dv-scan">重新扫描局域网</button>';
    } else {
      html += '<div class="dv-note">没扫到电脑端——确认电脑 BiliMusic 正在运行、手机与电脑连同一 Wi-Fi。</div>' +
        '<button type="button" class="dv-scan" id="dv-scan">扫描局域网</button>';
    }
    return html + "</div>";
  }

  function renderPage() {
    var body = $("dev-body");
    if (!body) return;
    var devices = (snapshot && snapshot.devices) || [];
    var session = snapshot && snapshot.session;
    var remote = remoteActive();
    var html = "";

    if (remote) {
      html += controllerCard(remote);
    } else if (session && session.activeDeviceId === ME) {
      var mine = session.song || {};
      html += '<div class="dv-sec"><div class="dv-title">正在播放 · 本机</div>' +
        '<div class="dv-row me"><span class="dot on"></span><span class="nm">' + esc(mine.title || "—") + "</span>" +
        '<span class="st">' + (session.playing ? "播放中" : "已暂停") + "</span></div></div>";
    } else if (adopting()) {
      html += '<div class="dv-sec"><div class="dv-title">正在播放 · 本机</div>' +
        '<div class="dv-row me"><span class="dot on"></span><span class="nm">本机</span><span class="st">播放中</span></div></div>';
    } else {
      html += '<div class="dv-sec"><div class="dv-empty">没有设备在播放。<br>任一设备开始播放后，可以在这里遥控它，或把播放串流到本机。</div></div>';
    }

    if (devices.length) {
      html += '<div class="dv-sec"><div class="dv-title">此账号的设备</div>' +
        devices.map(devRow).join("") + "</div>";
    }

    html += renderBackends();

    if (needGesture && pending) {
      html += '<div class="dv-sec"><button type="button" class="dv-stream" id="dv-needgesture">点一下继续播放</button></div>';
    }

    body.innerHTML = html;
    bindPage(body);
  }

  function bindPage(body) {
    var bar = $("dv-bar");
    if (bar) bar.addEventListener("click", function (ev) {
      var s2 = snapshot && snapshot.session;
      var dur = Number(s2 && s2.song && s2.song.duration) || 0;
      if (!dur) return;
      var r = bar.getBoundingClientRect();
      var ratio = Math.min(1, Math.max(0, (ev.clientX - r.left) / Math.max(1, r.width)));
      sendCommand("seek", { position: Math.round(dur * ratio) });
    });
    [].slice.call(body.querySelectorAll("[data-cmd]")).forEach(function (b) {
      b.addEventListener("click", function () { sendCommand(b.dataset.cmd); });
    });
    var stream = $("dv-stream");
    if (stream) stream.addEventListener("click", startTransfer);
    var ng = $("dv-needgesture");
    if (ng) ng.addEventListener("click", function () { claimNow(); });
    bindBackends(body);
  }

  // ---------- 局域网电脑端（Android 原生扫描，#26） ----------

  function bindBackends(body) {
    if (!NATIVE || !NATIVE.scanBackends) return;
    var scan = $("dv-scan");
    if (scan) scan.addEventListener("click", function () {
      scan.textContent = "扫描中…"; scan.disabled = true;
      NATIVE.scanBackends();
      setTimeout(function () { if (document.body.contains(scan)) { scan.textContent = "重新扫描局域网"; scan.disabled = false; } }, 3000);
    });
    var emb = $("dv-use-embedded");
    if (emb) emb.addEventListener("click", function () { NATIVE.useEmbeddedBackend(); });
    [].slice.call(body.querySelectorAll("[data-bem]")).forEach(function (b) {
      b.addEventListener("click", function () {
        var item = backends[Number(b.dataset.bem)];
        if (item && NATIVE.connectBackend) { window.__toast && window.__toast("正在连接 " + (item.name || item.url) + "…"); NATIVE.connectBackend(item.url); }
      });
    });
  }

  // 原生扫描完成（MainActivity.pushBackends → evaluateJavascript）
  window.__bmBackendsFound = function (list) {
    backends = Array.isArray(list) ? list : [];
    if (pageOn()) renderPage();
  };

  /** 程序化切到设备页（needGesture 兜底按钮出现在这里）。 */
  function showDevicesView() {
    if (!window.switchView) return;
    switchView("devices");
    [].slice.call(document.querySelectorAll(".side-nav .side-item")).forEach(function (b) {
      b.classList.toggle("on", b.dataset.nav === "devices");
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

  /** 串流：请对方把播放交到本机（对方现报进度 → 本机预加载 → canplay → claimed）。 */
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

  /** 我是接收端（#23 Phase 2+3）：**立刻开始预加载**（用已知进度），canplay 后把落点纠到发送端
   *  现报的精确进度 → 音量从 0 淡入并 claimed（与发送端淡出同一窗口，消除交接那不到 1 秒的缝）。 */
  function onTransferIn(d) {
    if (!d || d.toDeviceId !== ME || !window.BiliPlayer || !BiliPlayer.prepare) return;
    pending = pending || { startedAt: Date.now() };
    pending.queue = d.queue || [];
    pending.index = d.index || 0;
    pending.position = Math.max(pending.position || 0, Number(d.position) || 0);
    if (pending.preparing) return;
    pending.preparing = true;
    window.__toast && window.__toast("正在接管播放…");
    BiliPlayer.prepare(pending.queue, pending.index, pending.position)
      .then(function () {
        // 预加载期间现报的精确进度通常已经到了；没到就再等一会儿（最多 600ms）
        var t0 = Date.now();
        return new Promise(function (res) {
          (function poll() {
            if (!pending || pending.live || Date.now() - t0 > 600) return res();
            setTimeout(poll, 40);
          })();
        });
      })
      .then(function () {
        var media = BiliPlayer.activeMedia ? BiliPlayer.activeMedia() : null;
        var at = pending ? pending.position : 0;
        if (media && at > 1) {
          // 只在偏差明显时纠偏（缓冲区里的 seek 很快，±0.7s 以内不值得再动一次）
          try { if (Math.abs((media.currentTime || 0) - at) > 0.7) media.currentTime = at; } catch (e) {}
        }
        if (media && typeof media.volume === "number") media.volume = 0;   // 从静音起步，交给淡入
        return BiliPlayer.resume();      // 用户点按钮触发 → 算手势
      })
      .then(function () {
        return post("/api/session/claimed", { deviceId: ME, position: pending ? pending.position : 0 });
      })
      .then(function (res) {
        if (res && res.__err) {
          window.__toast && window.__toast("接管失败，请重试");
          pending = null;
          needGesture = false;
          return;
        }
        var media = BiliPlayer.activeMedia ? BiliPlayer.activeMedia() : null;
        fade(media, 1, HANDOFF_FADE_MS);   // #23 Phase 3：交叉淡入
        pending = null;
        needGesture = false;
        window.__toast && window.__toast("已在本机继续播放");
      })
      .catch(function () {
        // canplay 超时 / 自动播放被拦：发送端继续播，这里给一个「点一下继续」
        if (pending) pending.preparing = false;
        showResumeFallback();
      });
  }

  function showResumeFallback() {
    needGesture = true;
    showDevicesView();   // 兜底按钮长在设备页：把用户带过去
    renderPage();
  }

  /** 用户点「点一下继续播放」：这一次点击就是手势，play 与 claimed 一起完成。 */
  function claimNow() {
    var at = pending ? pending.position : 0;
    var media = BiliPlayer.activeMedia ? BiliPlayer.activeMedia() : null;
    if (media && typeof media.volume === "number") media.volume = 0;
    BiliPlayer.resume().then(function () {
      return post("/api/session/claimed", { deviceId: ME, position: at });
    }).then(function (res) {
      if (res && res.__err) {
        needGesture = false; pending = null; renderPage();
        window.__toast && window.__toast("接管已超时，请再点一次「串流到本机」");
        return;
      }
      needGesture = false;
      pending = null;
      fade(media, 1, HANDOFF_FADE_MS);
      renderPage();
      window.__toast && window.__toast("已在本机继续播放");
    }).catch(function () { window.__toast && window.__toast("仍然无法播放，请重试"); });
  }

  /** 打开即续播：把远端队列搬到本机，从同一进度开始（点击即用户手势，不会被拦自动播放）。 */
  function resumeHere() {
    var remote = remoteActive();
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
    var idleTick = 0;
    setInterval(function () {
      var s = localState();
      if (s && s.playing) report(false);
      // #26 设备页主界面化：空闲（未播放）也要保活在位状态，否则 30s 后其他端把本机显示成离线
      else if ((idleTick = (idleTick + 1) % 4) === 0) report(false);
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
    // 设备页可见时每秒重画一次（进度外推），不可见不动
    setInterval(function () { if (pageOn()) renderPage(); }, 1000);
    window.__sessionSync = {
      deviceId: ME, name: NAME, snapshot: function () { return snapshot; },
      report: report, hello: hello, resumeHere: resumeHere,
      sendCommand: sendCommand, startTransfer: startTransfer, pending: function () { return pending; },
      needGesture: function () { return needGesture; },
      renderPage: renderPage,
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
