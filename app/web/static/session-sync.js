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
  var snapshot = null;      // 最近一次快照 {session, devices}
  var lastReport = "";      // 上次上报指纹（去重）
  var lastReportAt = 0;
  var wasActive = false;    // 上一次快照里本机是否 active（判断「被接管」）
  var pending = null;       // 进行中的移交 {queue,index,position,startedAt,live}
  var liveTransferAt = 0;   // 收到发送端「现报进度」的时刻
  var needGesture = false;  // 需要用户点一下才能出声（自动播放被拦 / canplay 失败）
  var yielding = false;     // 正在把播放让给别的设备（淡出期间不能再说自己在播）
  var claimFrom = 0;        // 本机这次接管的起点（快照不带版本号时的兜底宽限窗用）
  var claimRev = 0;         // 接管成功时会话的 revision：比它更旧的快照都是「接管之前生成的」
  var CLAIM_GRACE_MS = 8000; // 兜底宽限窗：接管（含预加载）期间的旧快照一律作废

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
    if (!P) return null;
    // #29 第二轮：试听（未收藏的推荐/最近播放）也当成一套队列上报，否则「未收藏的歌」在别台设备上
    // 看不到、也接不走（用户实测：串流态点推荐歌本机自己响、电脑那边毫无反应）。
    var trial = P.trialState ? P.trialState() : null;
    var song = trial ? trial.items[trial.index] : (P.currentSong ? P.currentSong() : null);
    if (!song) return null;
    var media = P.activeMedia ? P.activeMedia() : null;
    var pos = trial ? null : (P.position ? P.position() : null);
    var q = trial ? trial.items : (P.queue ? P.queue() : []);
    return {
      deviceId: ME, name: NAME, kind: KIND,
      playing: yielding ? false : (trial ? !!trial.playing : !!(P.isPlaying && P.isPlaying())),
      position: trial ? Math.max(0, Number(trial.position) || 0)
                      : (media && isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0),
      volume: media && typeof media.volume === "number" ? Math.round(media.volume * 100) : 100,
      index: trial ? trial.index : (pos && pos.index ? pos.index - 1 : 0),
      queue: q,
      repeat: localStorage.getItem("bmPlayMode") || "off",
      shuffle: false,
    };
  }

  function report(force) {
    var state = localState();
    if (!state) return Promise.resolve(null);
    var fp = JSON.stringify([state.playing, state.index, state.queue.length,
      state.queue[state.index] ? state.queue[state.index].bvid : "", Math.round(state.position), state.volume]);
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
    if (!nowActive) {
      // 接管期间 SSE 与上报响应是两条独立通道，会送来「接管之前生成」的旧快照（active 仍指着上一台
      // 设备）。照单全收会让刚出声的设备误判「我被抢走了」→ 淡出暂停，表现为「点了串流到本设备，
      // 本机却没声音」（#27 端到端 ④ 的真凶）。判据用会话版本号：比接管时更旧的一律作废；
      // 快照不带版本号（或会话已清空）时用接管宽限窗兜底。
      var rev = session && session.revision != null ? Number(session.revision) : null;
      var stale = (rev != null && claimRev > 0) ? (rev < claimRev) : (Date.now() - claimFrom < CLAIM_GRACE_MS);
      if (stale) return;
    }
    // 本机原本在放、现在会话归别人了（被移交走 或 被抢占）→ 淡出暂停，别两头出声
    if (wasActive && !nowActive) handOverLocally(session);
    wasActive = nowActive;
    snapshot = { session: session, transfer: snap.transfer || null,
                 devices: snap.devices || (snapshot && snapshot.devices) || [] };
    syncBar();
    if (pickOpen()) renderPick();
  }

  /** 播放条：别人在放→镜像它（中键=⇢ 串流到本设备）；否则回到本机态。 */
  function syncBar() {
    if (!window.BiliBarMirror) return;
    var remote = remoteActive();
    if (remote && remote.song && remote.song.bvid) {
      BiliBarMirror.on(remote);
      BiliBarMirror.setAction(needGesture ? "resume" : "toggle");
    } else {
      // 本机已是 active（或没有会话）：接管手势态作废，中键回到普通播放/暂停
      if (!pending) needGesture = false;
      BiliBarMirror.off();
    }
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
      // 用户口径「串流我不要任何提示」（#29 第三轮）：让出播放不再弹 toast——播放条会立刻切成镜像 + 粉光，
      // 状态变化本身就是反馈。只有**失败**（对面没接、队列拿不到、自动播放被拦）才出声。
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

  // ---------- 串流浮层（#29）：长按播放条中键弹出 → 手指滑到哪台设备，松手就串流到哪台 ----------
  // 交互定稿：
  //   手机 —— ① 中键短按＝那台设备的播放/暂停；② 长按中键＝本浮层（按住滑动跟手高亮，松手即切）；
  //          ③ 把播放条往上拖＝条子缩成一颗小团跟手、背景糊掉、松手落在哪台就串到哪台；往下拉＝回到本机播放。
  //   桌面 —— 点播放条上的设备图标打开同一份设备列表（长按在桌面不合理，不绑）。
  // 点空白或 Esc 关闭。
  var DRAG_UP = 22;         // 上拖多少像素算「要选设备」
  var DRAG_DOWN = 26;       // 下拖多少像素算「回到本机播放」
  var MOBILE = null;        // 手机布局（<=900px，与 style.css 的断点同口径）；initMobile() 里算
  var slidingDev = "";      // 滑动中高亮的设备 id（按 id 记：快照重绘会换掉行元素，重绘后要能复原）
  var volTouchAt = 0;       // 拖远端音量时别让快照重绘把滑条换掉
  var pickAnchor = null;    // 桌面列表由谁发起（设备图标）——> 浮层从它上方冒出来
  var ballMode = false;     // 手机端：球阵（页面中央的圆球），不是列表

  function initMobile() {
    try { MOBILE = window.matchMedia("(max-width: 900px)").matches; } catch (e) { MOBILE = window.innerWidth <= 900; }
  }
  initMobile();

  function pickOpen() { var s = $("dev-pick"); return !!(s && !s.hidden); }
  function openPick(anchor) {
    var s = $("dev-pick");
    if (!s) return;
    ballMode = !!MOBILE;                        // 手机＝球阵；桌面＝列表
    pickAnchor = anchor || $("btn-toggle");
    s.hidden = false;
    s.classList.toggle("balls", ballMode);
    if (!ballMode) positionPick();
    renderPick();
  }
  function closePick() { var s = $("dev-pick"); if (s) s.hidden = true; clearHi(); }

  /** 浮层从「发起的那颗键」位置冒出来：横向锚它、纵向贴它的上沿；四周留 10px 不越出屏幕。 */
  function positionPick() {
    var s = $("dev-pick"), bar = $("player-bar"), btn = pickAnchor || $("btn-toggle");
    if (!s) return;
    var vw = window.innerWidth || document.documentElement.clientWidth || 390;
    var w = Math.min(320, Math.max(200, vw - 28));   // 与 .dp-panel 的 width 同口径
    var cx = vw / 2, bottom = 96;
    if (bar && !bar.classList.contains("hidden")) {
      bottom = Math.max(80, Math.round(window.innerHeight - bar.getBoundingClientRect().top + 10));
    }
    var b = btn ? btn.getBoundingClientRect() : null;
    if (b && b.width) {
      cx = b.left + b.width / 2;
      bottom = Math.max(80, Math.round(window.innerHeight - b.top + 8));   // 紧贴播放键上沿
    }
    var left = Math.min(Math.max(cx, w / 2 + 10), Math.max(w / 2 + 10, vw - w / 2 - 10));
    s.style.setProperty("--dp-bottom", bottom + "px");
    s.style.setProperty("--dp-left", Math.round(left) + "px");
    s.style.setProperty("--dp-origin-x", Math.round(((cx - (left - w / 2)) / w) * 100) + "%");
  }

  function isActiveDevice(d) {
    var s = snapshot && snapshot.session;
    return !!(s && s.activeDeviceId === d.id && s.song && s.song.bvid);
  }
  function devState(d) {
    var s = snapshot && snapshot.session;
    if (isActiveDevice(d)) return s.playing ? "正在播放" : "已暂停";
    if (d.playing) return "在线 · 未接管";
    if (d.online) return "空闲";
    return d.idleFor != null ? "离线 · " + Math.round(d.idleFor / 60) + " 分钟前" : "离线";
  }
  /** 排序：在放的 → 本机 → 在线 → 离线（手指往下滑的距离最短）。 */
  function devRank(d) {
    if (isActiveDevice(d)) return 0;
    if (d.id === ME) return 1;
    return d.online ? 2 : 3;
  }
  function sortedDevices() {
    return ((snapshot && snapshot.devices) || []).slice().sort(function (a, b) {
      return devRank(a) - devRank(b) || String(a.name || "").localeCompare(String(b.name || ""));
    });
  }
  function pickRow(d) {
    var me = d.id === ME;
    return '<button type="button" class="dp-row' + (me ? " me" : "") + (isActiveDevice(d) ? " cur" : "") +
      (d.online ? "" : " off") + '" data-dev="' + esc(d.id) + '">' +
      '<span class="dot' + (isActiveDevice(d) ? " on" : "") + '"></span>' +
      '<span class="nm">' + esc(d.name || d.kind || "设备") + (me ? "（本机）" : "") + "</span>" +
      '<span class="st">' + esc(devState(d)) + "</span></button>";
  }
  /** 手机端球阵：页面中央只放圆球（本机不出现——「回到本机」是往下拖那颗球）。 */
  function ballHtml() {
    var devs = sortedDevices().filter(function (d) { return d.id !== ME; });
    if (!devs.length) return '<div class="dp-empty">还没有别的设备<br><em>同一账号的设备打开后会自动出现</em></div>';
    return '<div class="dp-balls">' + devs.map(function (d) {
      var cur = isActiveDevice(d);
      return '<button type="button" class="dp-ball' + (cur ? " cur" : "") + (d.online ? "" : " off") +
        '" data-dev="' + esc(d.id) + '">' +
        '<span class="bc"><svg aria-hidden="true"><use href="#i-devices"/></svg></span>' +
        '<span class="bn">' + esc(d.name || d.kind || "设备") + "</span>" +
        '<span class="bs">' + esc(cur ? (d.playing ? "正在播放" : "已暂停") : (d.online ? "空闲" : "离线")) + "</span></button>";
    }).join("") + "</div>";
  }
  function volHtml(remote) {
    if (!remote) return "";
    var vol = Number(remote.volume);
    return '<div class="dp-volrow"><span class="lb">' + esc(remote.activeDeviceName || "远端") +
      ' 的音量</span><input type="range" id="dp-vol" min="0" max="100" step="1" value="' +
      (isFinite(vol) ? Math.round(vol) : 100) + '" aria-label="远端音量"></div>';
  }

  function renderPick() {
    var body = $("dev-body");
    if (!body || !pickOpen()) return;
    if (Date.now() - volTouchAt < 900 && $("dp-vol")) return;   // 拖远端音量中：先不重画
    var remote = remoteActive();
    if (ballMode) {                                   // 手机：球阵 + 底部一条远端音量/自动连接
      body.innerHTML = ballHtml() + '<div class="dp-low">' + volHtml(remote) + renderLink() + "</div>";
      restoreHi();
      bindPick(body);
      return;
    }
    var hint = $("dp-hint");
    if (hint) hint.textContent = "点一台设备即切换";
    var devices = sortedDevices();
    var title = $("dp-title");
    if (title) title.textContent = remote ? "正在 " + (remote.activeDeviceName || "另一台设备") + " 上播放" : "串流到";
    var html = devices.length ? devices.map(pickRow).join("")
      : '<div class="dp-status"><span class="txt">还没发现别的设备——同一账号的设备打开后会自动出现在这里。</span></div>';
    if (remote) html += '<div class="dp-sep"></div>' + volHtml(remote);
    body.innerHTML = html + renderLink();
    restoreHi();          // 拖拽中重绘：把跟手高亮按设备 id 补回来
    bindPick(body);
  }

  function bindPick(body) {
    [].slice.call(body.querySelectorAll("[data-dev]")).forEach(function (row) {
      row.addEventListener("click", function () { pickTo(row.dataset.dev); });
    });
    var dv = $("dp-vol");
    if (dv) dv.addEventListener("input", function () { volTouchAt = Date.now(); setRemoteVolume(Number(dv.value)); });
    var local = $("dp-local");
    if (local) local.addEventListener("click", function () {
      if (NATIVE && NATIVE.setAutoConnect) NATIVE.setAutoConnect(false);   // 用户明确要回本机：别过 20 秒又连回去
      if (NATIVE && NATIVE.useEmbeddedBackend) { window.__toast && window.__toast("已回到本机"); NATIVE.useEmbeddedBackend(); }
    });
    var off = $("dp-auto-off");
    if (off) off.addEventListener("click", function () {
      if (NATIVE && NATIVE.setAutoConnect) NATIVE.setAutoConnect(false);
      autoState = { enabled: false };
      renderPick();
      window.__toast && window.__toast("已关闭自动连接");
    });
    var on = $("dp-auto-on");
    if (on) on.addEventListener("click", function () {
      if (NATIVE && NATIVE.setAutoConnect) NATIVE.setAutoConnect(true);
      autoState = { enabled: true };
      renderPick();
      autoTick(true);
    });
  }

  /** 点/滑到某台设备：本机＝把播放拉过来，别的设备＝把播放推过去。 */
  function pickTo(id) {
    if (!id) return;
    var s = snapshot && snapshot.session;
    if (s && s.activeDeviceId === id && !needGesture) {
      closePick();   // #29 第三轮：丢回正在播放的那台＝静默收起（用户口径：串流时不要弹提示）
      return;
    }
    if (id === ME) {
      closePick();
      if (needGesture) claimNow(); else startTransfer();
      return;
    }
    closePick();
    transferTo(id);
  }

  function clearHi() {
    [].slice.call(document.querySelectorAll(".dp-row.hi")).forEach(function (r) { r.classList.remove("hi"); });
    slidingDev = "";
  }
  /** 重绘设备行后把高亮补回来（拖拽期间快照刷新不能把跟手高亮刷掉）。 */
  function restoreHi() {
    if (!slidingDev) return;
    var rows = document.querySelectorAll("#dev-body .dp-row,#dev-body .dp-ball");
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset.dev === slidingDev) { rows[i].classList.add("hi"); return; }
    }
  }
  function highlightAt(x, y) {
    var el = document.elementFromPoint(x, y);
    var row = el && el.closest ? el.closest(".dp-row,.dp-ball") : null;
    var dev = row ? row.dataset.dev : "";
    if (dev === slidingDev) return;
    clearHi();
    if (row) { row.classList.add("hi"); slidingDev = dev; }
  }

  /** 手机端：把播放条往上拖＝选设备（条子缩成一颗小团跟手、背景糊掉），往下拉＝回到本机播放。 */
  function bindBarDrag() {
    var bar = $("player-bar");
    if (!bar || !MOBILE) return;
    var start = null, mode = "", pid = null, homeX = 0, homeY = 0;

    function reset() {
      bar.classList.remove("dragging", "want-local");
      bar.style.removeProperty("--drag-x");
      bar.style.removeProperty("--drag-y");
      bar.style.removeProperty("--drag-down");
      var p = $("dev-pick");
      if (p) p.classList.remove("blur");
      clearHi();
      if (pid != null) { try { bar.releasePointerCapture(pid); } catch (e) {} }
      pid = null; start = null; mode = "";
    }
    /** 缩成小球：先（无过渡地）变球，再量球的静止位置，随后把它平移到手指按下处——
     *  整个过程没有位移过渡，所以第一帧小球就出现在手指位置，不会从旁边飘过来。 */
    function enter(ev) {
      var t = $("puck-title");
      var src = $("player-title");
      if (t) t.textContent = src ? src.textContent : "";
      bar.classList.add("dragging");
      var r = bar.getBoundingClientRect();
      homeX = r.left + r.width / 2;
      homeY = r.top + r.height / 2;
      var p = $("dev-pick");
      if (p) p.classList.add("blur");
      openPick($("btn-toggle"));
      if (pid != null) { try { bar.setPointerCapture(pid); } catch (e) {} }
      follow(ev);
    }
    function follow(ev) {
      bar.style.setProperty("--drag-x", Math.round(ev.clientX - homeX) + "px");
      bar.style.setProperty("--drag-y", Math.round(ev.clientY - homeY) + "px");
      highlightAt(ev.clientX, ev.clientY);
    }
    bar.addEventListener("pointerdown", function (ev) {
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
      if (ev.target.closest("button,input,.p-acts,.p-time,.volhost")) return;   // 控件自己的手势不抢
      start = { x: ev.clientX, y: ev.clientY }; pid = ev.pointerId; mode = "";
    });
    bar.addEventListener("pointermove", function (ev) {
      if (!start) return;
      var dy = ev.clientY - start.y;
      if (!mode) {
        if (dy <= -DRAG_UP) { mode = "up"; enter(ev); }
        else if (dy >= DRAG_DOWN) { mode = "down"; bar.classList.add("want-local"); }
        return;
      }
      if (mode === "up") { ev.preventDefault(); follow(ev); }
      else if (dy < DRAG_DOWN - 8) { mode = ""; bar.classList.remove("want-local"); bar.style.removeProperty("--drag-down"); }
      else bar.style.setProperty("--drag-down", Math.min(14, Math.round(dy - DRAG_DOWN) + 8) + "px");
    });
    bar.addEventListener("pointerup", function () {
      var m = mode, dev = mode === "up" ? slidingDev : "";
      reset();
      if (m === "up") { if (dev) pickTo(dev); else closePick(); }
      else if (m === "down") pickTo(ME);          // 往下拉＝回到本机播放
    });
    bar.addEventListener("pointercancel", function () {
      if (mode === "up") closePick();
      reset();
    });
  }

  /** 浮层打开时每秒只刷设备状态文案（整块重画会打断正在拖的音量条）。 */
  function tickPick() {
    if (!pickOpen()) return;
    var body = $("dev-body");
    if (!body || !snapshot) return;
    var devices = sortedDevices();
    var rows = body.querySelectorAll("[data-dev]");
    if (rows.length !== devices.length) { renderPick(); return; }
    for (var i = 0; i < rows.length; i++) {
      var st = rows[i].querySelector(".st");
      if (st) st.textContent = devState(devices[i]);
    }
  }

  // ---------- Android：自动发现并连接「同一账号」的电脑后端（#29，取代手动扫描 + 点连接） ----------
  // 手机内置后端与电脑后端各自独立，只有连到同一后端才会共享播放会话。这里交给原生扫局域网：
  // 命中同一 mid 的后端就自动切过去；本机正在出声时不切（避免打断）；可在浮层里关掉。

  var autoState = null;     // 原生回报 {enabled, connected, name, found, msg}
  var autoAt = 0;           // 上次触发扫描的时刻（节流）

  function autoOn() { return !autoState || autoState.enabled !== false; }

  function autoTick(force) {
    if (!NATIVE || !NATIVE.autoConnect) return;
    if (REMOTE_BACKEND) return;                                        // 已经连在电脑后端上
    if (!force && !autoOn()) return;
    if (window.BiliPlayer && BiliPlayer.isPlaying && BiliPlayer.isPlaying()) return;  // 本机正在放：先别打断
    var now = Date.now();
    if (!force && now - autoAt < 15000) return;
    autoAt = now;
    try { NATIVE.autoConnect(MID); } catch (e) {}
  }

  function renderLink() {
    if (!NATIVE || !NATIVE.autoConnect) return "";
    if (REMOTE_BACKEND) {
      return '<div class="dp-sep"></div><div class="dp-status"><span class="txt">已连接电脑端 ' + esc(location.hostname) +
        '（自动 · 曲库与登录来自电脑）</span><button type="button" id="dp-local">回到本机</button></div>';
    }
    if (autoOn()) {
      return '<div class="dp-sep"></div><div class="dp-status"><span class="txt">' +
        esc((autoState && autoState.msg) || "正在自动查找同一账号的电脑端…") +
        '</span><button type="button" id="dp-auto-off">关闭</button></div>';
    }
    return '<div class="dp-sep"></div><div class="dp-status"><span class="txt">自动连接电脑端：已关闭</span>' +
      '<button type="button" id="dp-auto-on">开启</button></div>';
  }

  /** 原生回报自动连接状态（MainActivity.pushAutoState）。 */
  window.__bmAutoState = function (o) { autoState = o || {}; if (pickOpen()) renderPick(); };

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

  function remoteCommand(type) { return sendCommand(type); }
  function remoteSeek(seconds) { return sendCommand("seek", { position: Math.max(0, Math.round(seconds || 0)) }); }

  /** 串流态点歌（#29 第二轮）：本机只是控制器时，点歌＝把「这套队列 + 这首」推给在放的那台设备，
   *  由它 adopt 并上报会话；本机不出声、不抢会话。返回 null＝不在串流态（调用方照常本地播）；
   *  返回 Promise<boolean>：true＝对面接了，false＝对面不可用（调用方回退本地播放）。 */
  function playOnRemote(queue, index, position) {
    var s = snapshot && snapshot.session;
    if (!s || !s.activeDeviceId || s.activeDeviceId === ME) return null;
    if (!s.song || !s.song.bvid) return null;                 // 对面没歌：没什么可推的
    if (!queue || !queue.length) return null;
    var body = { queue: queue, index: Math.max(0, index | 0), position: Math.max(0, Number(position) || 0) };
    function attempt(retry) {
      var rev = snapshot && snapshot.session ? snapshot.session.revision : undefined;
      return post("/api/session/command", { deviceId: ME, type: "play", payload: body, revision: rev })
        .then(function (res) {
          if (res && res.accepted) return true;   // 静默：串流态点歌是常规操作，不弹提示
          if (res && res.__err === 409 && retry > 0) return hello().then(function () { return attempt(retry - 1); });
          if (res && res.reason === "target-offline") {
            window.__toast && window.__toast("在放的那台设备没响应，改在本机播放");
          }
          return false;
        });
    }
    return attempt(1);
  }

  /** 播放条中键（#29）：短按＝遥控对面播放/暂停；自动播放被拦时＝补一次手势把播放接过来。 */
  function barAction() {
    if (needGesture) return claimNow();
    return sendCommand("toggle");
  }

  // 远端音量：拖滑条会连发，250ms 合并一次（服务端不因音量改动 revision）
  var volPending = null, volTimer = 0, volLastSent = -1;
  function setRemoteVolume(v) {
    volPending = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    if (volTimer) return;
    flushVolume();
    volTimer = setTimeout(function () {
      volTimer = 0;
      if (volPending != null && volPending !== volLastSent) flushVolume();
    }, 250);
  }
  function flushVolume() {
    if (volPending == null) return;
    var v = volPending; volPending = null;
    if (v === volLastSent) return;
    volLastSent = v;
    sendCommand("volume", { volume: v });
  }

  /** 把在放的那台设备的声音搬到 target（本机＝拉过来，别的设备＝推过去）。 */
  function transferTo(targetId) {
    var s = snapshot && snapshot.session;
    var active = s && s.activeDeviceId;
    if (!s || !active) { window.__toast && window.__toast("没有可搬运的播放会话"); return Promise.resolve(null); }
    if (active === targetId) return Promise.resolve(null);
    if (targetId === ME) return startTransfer();
    needGesture = false; pending = null;   // 把播放推去别台：本机这次「点一下继续播放」作废
    return post("/api/session/transfer", { fromDeviceId: active, toDeviceId: targetId }).then(function (res) {
      if (res && res.__err) { window.__toast && window.__toast("设备未响应或没有可播会话"); return null; }
      setTimeout(closePick, 400);   // 静默成功：切换结果由播放条（镜像 + 粉光）体现
      return res;
    });
  }

  /** 串流：请对方把播放交到本机（对方现报进度 → 本机预加载 → canplay → claimed）。 */
  function startTransfer() {
    var s = snapshot && snapshot.session;
    if (pending) return Promise.resolve(null);   // 已在接管中：静默忽略（串流不弹提示）
    needGesture = false;   // 新的一次接管请求：旧的「点一下继续播放」作废
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
    claimFrom = Date.now();   // 宽限窗从「开始接管」就生效：在途的旧快照不能把这次接管打断
    pending = pending || { startedAt: Date.now() };
    pending.queue = d.queue || [];
    pending.index = d.index || 0;
    pending.position = Math.max(pending.position || 0, Number(d.position) || 0);
    if (pending.preparing) return;
    pending.preparing = true;
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
        // 接管成功：记下此刻的会话版本号，比它旧的快照都当作「接管之前生成的」
        claimFrom = Date.now();
        if (res && res.session && res.session.revision != null) claimRev = Number(res.session.revision);
        fade(media, 1, HANDOFF_FADE_MS);   // #23 Phase 3：交叉淡入
        pending = null;
        needGesture = false;
      })
      .catch(function () {
        // canplay 超时 / 自动播放被拦：发送端继续播，这里给一个「点一下继续」
        if (pending) pending.preparing = false;
        showResumeFallback();
      });
  }

  function showResumeFallback() {
    needGesture = true;
    syncBar();           // 播放条中键变成「点一下继续播放」（浏览器要求手势才能出声）
    renderPick();
    window.__toast && window.__toast("浏览器拦了自动播放，点一下播放键继续");
  }

  /** 用户点「点一下继续播放」：这一次点击就是手势，play 与 claimed 一起完成。 */
  function claimNow() {
    var at = pending ? pending.position : 0;
    claimFrom = Date.now();                // 补手势这条路径同理：从现在起旧快照作废
    var media = BiliPlayer.activeMedia ? BiliPlayer.activeMedia() : null;
    if (media && typeof media.volume === "number") media.volume = 0;
    BiliPlayer.resume().then(function () {
      return post("/api/session/claimed", { deviceId: ME, position: at });
    }).then(function (res) {
      if (res && res.__err) {
        needGesture = false; pending = null; syncBar(); renderPick();
        window.__toast && window.__toast("接管已超时，请再点一次「串流到本机」");
        return;
      }
      needGesture = false;
      pending = null;
      claimFrom = Date.now();                // 接管成功：记下版本号（旧快照作废的判据）
      if (res && res.session && res.session.revision != null) claimRev = Number(res.session.revision);
      fade(media, 1, HANDOFF_FADE_MS);
      syncBar(); renderPick();
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
        if (!ok) window.__toast && window.__toast("接续失败，请重试");
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
      else if (d.type === "play") {
        // 控制器点歌：带队列的 play＝把这套队列搬过来从这首开始放（#29 第二轮）；否则就是「继续播放」
        var pl = d.payload || {};
        if (pl.queue && pl.queue.length && P.adopt) { needGesture = false; P.adopt(pl.queue, pl.index | 0, pl.position || 0); }
        else if (!P.isPlaying()) P.toggle();
      }
      else if (d.type === "pause") { if (P.isPlaying()) P.toggle(); }
      else if (d.type === "next") P.skip(1);
      else if (d.type === "prev") P.skip(-1);
      else if (d.type === "seek") {
        var media = P.activeMedia ? P.activeMedia() : null;
        if (media && d.payload && isFinite(d.payload.position)) media.currentTime = Math.max(0, d.payload.position);
      }
      else if (d.type === "volume") {
        // #27 别的设备在调「我这台」的音量：落到播放器与音量条上
        var v = d.payload && Number(d.payload.volume);
        if (isFinite(v)) {
          var m2 = P.activeMedia ? P.activeMedia() : null;
          if (m2 && typeof m2.volume === "number") m2.volume = Math.max(0, Math.min(1, v / 100));
          var volEl = $("vol");
          if (volEl) { volEl.value = String(v); volEl.style.setProperty("--p", v + "%"); }
        }
      }
      setTimeout(function () { report(true); }, 400);
    });
    document.addEventListener("bm:transferRequest", function (e) { onTransferRequest(e.detail || {}); });
    document.addEventListener("bm:transferIn", function (e) { onTransferIn(e.detail || {}); });
    document.addEventListener("bm:transferPosition", function (e) {
      if (pending && e.detail && isFinite(e.detail.position)) { pending.position = e.detail.position; pending.live = true; }
    });
    // #29：手机＝把播放条往上拖（缩成球、球阵选设备）／往下拉（回到本机）；中键就是普通播放/暂停。
    //      桌面＝播放条上的设备图标打开设备列表。
    bindBarDrag();
    var pick = $("dev-pick");
    if (pick) pick.addEventListener("click", function (ev) { if (ev.target.closest("[data-dp-close]")) closePick(); });
    var devBtn = $("btn-device");
    if (devBtn) devBtn.addEventListener("click", function (ev) { ev.stopPropagation(); openPick(devBtn); });
    document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closePick(); });
    window.addEventListener("resize", function () { initMobile(); if (pickOpen()) positionPick(); });
    // Android：启动即自动找「同一账号」的电脑端，不再要求用户先点「连接」
    if (NATIVE && NATIVE.autoConnect) {
      setTimeout(function () { autoTick(true); }, 1500);
      setInterval(autoTick, 20000);
      document.addEventListener("visibilitychange", function () { if (!document.hidden) autoTick(); });
    }
    // 本机音量的变化（用户拖动音量条 / 系统音量）也上报，别的设备才看得到
    ["audio", "audio2"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("volumechange", function () { report(true); });
    });
    // 抽屉可见时每秒只刷新进度（整块重画会打断拖拽）
    setInterval(tickPick, 1000);
    window.__sessionSync = {
      deviceId: ME, name: NAME, snapshot: function () { return snapshot; },
      report: report, hello: hello, resumeHere: resumeHere,
      sendCommand: sendCommand, startTransfer: startTransfer, pending: function () { return pending; },
      needGesture: function () { return needGesture; },
      barAction: barAction, remoteCommand: remoteCommand, remoteSeek: remoteSeek,
      playOnRemote: playOnRemote,
      setRemoteVolume: setRemoteVolume, transferTo: transferTo,
      openPick: openPick, closePick: closePick, pickTo: pickTo, syncBar: syncBar,
      mobile: function () { return MOBILE; },
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
