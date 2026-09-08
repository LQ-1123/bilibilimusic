/* BiliMusic Web 前端逻辑：播放器 + Media Session + 扫码登录（导出见 export.js） */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  function accountKey(name) {
    return name + ":" + (document.body.dataset.mid || "guest");
  }

  // ---------- 轻量弹窗兜底（v3.js 加载后会被带样式的同名实现覆盖） ----------
  // Android WebView 的 prompt()/confirm() 返回 null（壳内未实现对应回调），且
  // v3.js 一旦整体失效 __promptModal 即缺失 → 建歌单等路径静默失败（#7）。这里先垫底。
  if (!window.__promptModal) {
    window.__promptModal = function (title, opts) {
      opts = opts || {};
      return new Promise(function (resolve) {
        var wrap = $("mini-modal"), box = $("mini-modal-box");
        if (!wrap || !box) { resolve(window.prompt(title) || null); return; }
        box.innerHTML = '<h3 style="margin-bottom:12px">' + title + "</h3>" +
          '<input id="mm-input" type="text" style="width:100%;height:42px;padding:0 14px" value="' +
          String(opts.value || "").replace(/"/g, "&quot;") + '" placeholder="' + (opts.placeholder || "") + '">' +
          '<div class="modal-actions"><button id="mm-cancel">取消</button><button id="mm-ok">确定</button></div>';
        wrap.classList.remove("hidden");
        var input = $("mm-input");
        input.focus();
        var done = function (v) { wrap.classList.add("hidden"); resolve(v); };
        $("mm-ok").onclick = function () { done(input.value.trim() || null); };
        $("mm-cancel").onclick = function () { done(null); };
      });
    };
  }
  if (!window.__confirmModal) {
    window.__confirmModal = function (title, text) {
      return new Promise(function (resolve) {
        var wrap = $("mini-modal"), box = $("mini-modal-box");
        if (!wrap || !box) { resolve(window.confirm(title + "\n" + text)); return; }
        box.innerHTML = '<h3 style="margin-bottom:10px">' + title + "</h3>" +
          '<p style="font-size:12.5px;line-height:1.8;opacity:.75">' + text + "</p>" +
          '<div class="modal-actions"><button id="mm-cancel">取消</button><button id="mm-ok">确定</button></div>';
        wrap.classList.remove("hidden");
        var done = function (v) { wrap.classList.add("hidden"); resolve(v); };
        $("mm-ok").onclick = function () { done(true); };
        $("mm-cancel").onclick = function () { done(false); };
      });
    };
  }
  // 双轨播放器：audio 始终指向「当前承载播放」的元素（active 指针），过渡时轮换
  var audioA = $("audio");
  var audioB = $("audio2");
  var audio = audioA;
  var audioCtx = null, gains = null; // gains: {audioA: GainNode, audioB: GainNode}
  var transitionState = null;        // 进行中的过渡 {mainEl, timer}
  var naturalPlan = null;            // 自然播放结束前的预规划
  var analysisCache = {};            // songId -> TrackAnalysis
  var analysisPending = {};

  // ---------- 歌词状态 ----------
  var lyricLines = [];    // [{t: 秒（-1 = 无轴行）, text}]
  var lyricTimed = false; // 是否带时间轴（无轴则静态展示不滚动）
  var lyricSongId = null; // 当前歌词对应的歌（防切歌竞态）
  var lyricIdx = -1;      // 当前高亮行索引

  // ---------- 播放器 ----------
  var playlist = []; // [{id,title,artist,qualityLabel,audioUrl,coverUrl,duration}]
  var current = -1;
  var currentQuery = ""; // 播放队列跟随当前搜索筛选

  // 播放顺序 = 自动决策链：按过渡得分把队列贪心排序（智能过渡关闭时 = 原顺序）
  var chainOrder = [];      // songId 序列，起点为当前歌
  var queueDisplayItems = []; // 队列面板当前展示的曲目（与 data-idx 对应）
  var repeatOne = localStorage.getItem("bmRepeatOne") === "1";

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderQueue() {
    var list = $("queue-list");
    if (!list) return;
    $("queue-count").textContent = playlist.length ? "共 " + playlist.length + " 首" : "";
    var playingId = playlist[current] ? playlist[current].id : null;
    var display = queueDisplay();
    queueDisplayItems = display;
    list.innerHTML = display.map(function (s, i) {
      var cls = s.id === playingId ? ' class="active"' : "";
      return "<li" + cls + ' data-idx="' + i + '" title="' + escapeHtml(s.title) + '">' +
        '<span class="q-name">' + escapeHtml(s.title) + "</span>" +
        '<span class="q-artist">' + escapeHtml(s.artist) + "</span>" +
        '<span class="q-dur">' + fmt(s.duration) + "</span></li>";
    }).join("") || '<li class="q-empty">播放列表为空</li>';
    var active = list.querySelector("li.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  // 队列展示顺序 = 自动决策链（智能过渡关闭时 = 原顺序）
  function queueDisplay() {
    if (!smartEnabled() || !chainOrder.length) return playlist.slice();
    var byId = {};
    playlist.forEach(function (s) { byId[s.id] = s; });
    var out = [];
    chainOrder.forEach(function (id) {
      if (byId[id]) { out.push(byId[id]); delete byId[id]; }
    });
    playlist.forEach(function (s) { if (byId[s.id]) out.push(s); }); // 链外兜底
    return out;
  }

  // 自动决策排序：从当前歌出发，贪心挑选「过渡得分最高」的下一首，
  // 直到排完整条队列。分析未就绪的歌按原顺序排在已分析歌之后，分析到位后自动重排。
  function planChain() {
    if (!playlist.length) { chainOrder = []; renderQueue(); return; }
    if (!smartEnabled()) {
      chainOrder = playlist.map(function (s) { return s.id; });
      renderQueue();
      return;
    }
    var cur = playlist[current] || null;
    var lastId = cur ? cur.id : null;
    var chain = [];
    if (lastId !== null) chain.push(lastId);
    var pool = playlist
      .filter(function (s) { return s.id !== lastId; })
      .map(function (s) { return s.id; });
    while (pool.length) {
      var la = lastId !== null ? analysisCache[lastId] : null;
      var bestId = null, bestScore = -1, bestIdx = -1;
      for (var i = 0; i < pool.length; i++) {
        var ca = analysisCache[pool[i]];
        if (!ca || !la) continue; // 未分析的稍后按原顺序补
        var s = window.SmartTransition.scorePair(la, ca, repExit(la), repEntry(ca));
        if (s > bestScore) { bestScore = s; bestId = pool[i]; bestIdx = i; }
      }
      if (bestId === null) {
        chain.push(pool[0]);
        lastId = pool[0];
        pool.shift();
        continue;
      }
      chain.push(bestId);
      pool.splice(bestIdx, 1);
      lastId = bestId;
    }
    chainOrder = chain;
    renderQueue();
    markPlayingCard(playlist[current] ? playlist[current].id : null);
  }

  function repExit(a) {
    return a.exitPoints && a.exitPoints.length
      ? a.exitPoints[0].t
      : Math.max(0, (a.duration || 0) - 3);
  }
  function repEntry(b) {
    return b.entryPoints && b.entryPoints.length ? b.entryPoints[0].t : 0;
  }

  // 播放模式：order 顺序（到队尾停）/ loop 列表循环 / random 随机（歌词页模式钮切换）
  function playMode() {
    return localStorage.getItem("bmPlayMode") || "order";
  }

  // 链上的上/下一首；order 模式到队尾/队首即止，loop 环绕
  function chainNextIndex(dir) {
    if (!chainOrder.length || !playlist.length) return -1;
    if (playMode() === "random") return -1; // 随机不走链
    var curId = playlist[current] ? playlist[current].id : null;
    var pos = chainOrder.indexOf(curId);
    if (pos === -1) pos = 0;
    var next = pos + dir;
    if (next >= chainOrder.length) {
      if (playMode() === "loop") next = 0;
      else return -1;
    }
    if (next < 0) {
      if (playMode() === "loop") next = chainOrder.length - 1;
      else return -1;
    }
    var id = chainOrder[next];
    for (var i = 0; i < playlist.length; i++) {
      if (playlist[i].id === id) return i;
    }
    return -1;
  }

  // ---------- 会话记忆：刷新/重开后一键继续听 ----------
  var sessionRestored = false;
  var lastPositionSave = 0;

  function saveSession() {
    try {
      var cur = playlist[current];
      if (!cur || !audio.src) return;
      localStorage.setItem(accountKey("bmSession"), JSON.stringify({
        songId: cur.id,
        position: audio.currentTime || 0,
        queueIds: playlist.map(function (s) { return s.id; })
      }));
    } catch (e) {}
  }

  function restoreSession() {
    var raw = null;
    try { raw = localStorage.getItem(accountKey("bmSession")); } catch (e) {}
    if (!raw) return;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return; }
    if (!s || !s.songId) return;
    for (var i = 0; i < playlist.length; i++) {
      if (playlist[i].id === s.songId) {
        current = i;
        audio.src = playlist[i].audioUrl;
        var pos = s.position || 0;
        var onMeta = function () {
          try {
            if (pos > 1 && audio.duration && pos < audio.duration - 5) audio.currentTime = pos;
          } catch (e) {}
          audio.removeEventListener("loadedmetadata", onMeta);
        };
        audio.addEventListener("loadedmetadata", onMeta);
        updateNowPlaying(playlist[i]); // 不自动出声：一键 ▶ 即续播
        return;
      }
    }
  }

  function markPlayingCard(songId) {
    var cards = document.querySelectorAll("#songs .card, #dt-songs .card, #history-rack .card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle("playing", cards[i].dataset.play === String(songId));
    }
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function fetchSongs(q) {
    return fetch("/api/songs" + (q ? "?q=" + encodeURIComponent(q) : ""), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { songs: [] }; })
      .then(function (d) { return d.songs || []; });
  }

  function refreshPlaylist() {
    return fetchSongs(currentQuery).then(function (songs) {
      var playingId = current >= 0 && playlist[current] ? playlist[current].id : null;
      playlist = songs;
      current = -1;
      if (playingId !== null) {
        for (var i = 0; i < playlist.length; i++) {
          if (playlist[i].id === playingId) { current = i; break; }
        }
      }
      planChain();
      // 首次加载：恢复上次会话（不自动出声，一键 ▶ 续播）
      if (!sessionRestored) { sessionRestored = true; restoreSession(); planChain(); }
    });
  }

  function playSong(song) {
    stopTrial();
    cancelTransition();
    naturalPlan = null;
    playlist.forEach(function (s, i) { if (s.id === song.id) current = i; });
    ensureGraph();
    setGain(audioA, audioA === audio ? 1 : 0);
    setGain(audioB, audioB === audio ? 1 : 0);
    audio.src = song.audioUrl;
    audio.play().catch(function () {});
    updateNowPlaying(song);
    pushHistory({ k: "s" + song.id, kind: "song", id: song.id, title: song.title, artist: song.artist, cover: song.coverUrl });
    if (smartEnabled()) prefetchAnalyses();
    planChain(); // 以新歌为起点重排自动决策链
  }

  function updateNowPlaying(song) {
    $("player-bar").classList.remove("hidden");
    $("player-cover").src = song.coverUrl;
    var pt = $("player-title");
    pt.textContent = song.title;
    pt.title = song.title; // 截断时悬停看全文（#12）
    if (window.BiliTicker) BiliTicker.set(pt); // 超宽标题窗口内滚动（#13）
    $("player-artist").textContent = song.artist + " · " + (song.qualityLabel || "");
    // 切歌即重置进度显示（否则上一首的粉色填充/时间码会遗留到新歌开头）
    var seekEl = $("seek");
    if (seekEl) {
      seekEl.value = 0;
      syncSeekFill();
    }
    $("t-cur").textContent = "0:00";
    $("t-dur").textContent = "0:00";
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: "BiliMusic",
        artwork: [{ src: song.coverUrl, sizes: "512x512", type: "image/jpeg" }]
      });
      try { navigator.mediaSession.setActionHandler("previoustrack", function () { skip(-1); }); } catch (e) {}
      try { navigator.mediaSession.setActionHandler("nexttrack", function () { skip(1); }); } catch (e) {}
    }
    markPlayingCard(song.id);
    saveSession();
    renderQueue();
    if (!$("lyrics-panel").classList.contains("hidden")) loadLyrics(libLyricsMeta(song)); // 面板开着：切歌即刷新
  }

  // 点选歌曲 = 经算法平滑切入该歌（找当前歌最佳 Exit × 目标歌最佳 Entry），
  // 完成后链以它为起点重排；降级路径与 skip 一致。
  function playSongSmart(song) {
    var curSong = playlist[current] || null;
    if (!smartEnabled() || !curSong || song.id === curSong.id || transitionState) { playSong(song); return; }
    if (!audio.src || (audio.duration && audio.currentTime >= audio.duration - 0.3)) { playSong(song); return; }
    var fa = analysisCache[curSong.id], fb = analysisCache[song.id];
    var plan = (fa && fb)
      ? window.SmartTransition.planTransition(fa, fb, audio.currentTime || 0, { type: "manual" })
      : null;
    if (plan && plan.strategy !== "HARD_CUT") { startTransition(plan, song); return; }
    playSong(song);
  }

  function skip(delta) {
    // 试听态：在同列表组成的试听队列内切换（推荐/搜索/UP 页的歌）
    var q = window.__trialQueue;
    if (recActive && recAudio && q && q.items && q.items.length && window.playStream) {
      var ti = q.i + delta;
      if (ti < 0) ti = q.items.length - 1;
      if (ti >= q.items.length) ti = 0;
      q.i = ti;
      window.playStream(q.items[ti].bvid, q.items[ti], null);
      return;
    }
    stopTrial();
    naturalPlan = null;
    if (delta === 1 && playMode() === "random" && playlist.length > 1) {
      var ri = Math.floor(Math.random() * playlist.length);
      if (ri === current) ri = (ri + 1) % playlist.length;
      playSongSmart(playlist[ri]);
      return;
    }
    var ni = chainNextIndex(delta);
    if (ni < 0) {
      if (delta === 1) { try { audio.pause(); } catch (e) {} } // 顺序模式到队尾：停
      return;
    }
    var nextSong = playlist[ni];
    // 只对「下一首」方向且智能过渡开启时做过渡规划（响应速度优先）
    if (delta !== 1 || !smartEnabled()) { playSong(nextSong); return; }
    if (audio.duration && audio.currentTime >= audio.duration - 0.3) { playSong(nextSong); return; }
    var cur = playlist[current];
    var fa = cur && analysisCache[cur.id], fb = analysisCache[nextSong.id];
    var plan = (fa && fb)
      ? window.SmartTransition.planTransition(fa, fb, audio.currentTime || 0, { type: "manual" })
      : null;
    if (plan && plan.strategy !== "HARD_CUT") { startTransition(plan, nextSong); return; }
    playSong(nextSong); // HARD_CUT / 分析未就绪：直接切
  }

  document.addEventListener("click", function (e) {
    var delEl = e.target.closest("[data-del]");
    if (delEl) {
      var deletedRow = delEl.closest("[data-play]");
      if (deletedRow) deletedRow.hidden = true;
      fetch("/api/songs/" + delEl.dataset.del, { method: "DELETE" })
        .then(function (response) {
          if (!response.ok) throw new Error("Delete failed");
          if (window.htmx) htmx.trigger(document.body, "refreshSongs");
          refreshPlaylist();
        }).catch(function () {
          if (deletedRow) deletedRow.hidden = false;
          if (window.__toast) window.__toast("删除失败，请重试");
        });
      return; // 删除点击不穿透到整卡播放
    }
    var playEl = e.target.closest("[data-play]");
    if (playEl) {
      var ready = playlist.length ? Promise.resolve() : refreshPlaylist();
      ready.then(function () {
        for (var i = 0; i < playlist.length; i++) {
          if (String(playlist[i].id) === playEl.dataset.play) { playSongSmart(playlist[i]); return; }
        }
      });
    }
  });

  $("btn-toggle").addEventListener("click", function () {
    if (recActive && recAudio) { // 发现池试听接管胶囊
      if (recAudio.paused || recAudio.ended) { recAudio.play().catch(function () {}); }
      else { recAudio.pause(); }
      return;
    }
    if (!audio.src) return;
    if (audio.paused) { audio.play().catch(function () {}); } else { audio.pause(); }
  });
  $("btn-prev").addEventListener("click", function () { skip(-1); });
  $("btn-next").addEventListener("click", function () { skip(1); });

  function setPlayerToggle(paused) {
    var button = $("btn-toggle");
    button.querySelector("use").setAttribute("href", paused ? "#a-play" : "#a-pause");
    button.title = paused ? "播放" : "暂停";
    button.setAttribute("aria-label", button.title);
  }

  function onPlayPauseUI(e) {
    if (e.target !== audio) return;
    setPlayerToggle(audio.paused);
    if (audio.paused) saveSession();
  }
  function onEnded(e) {
    if (e.target !== audio) return;
    if (repeatOne) {
      audio.currentTime = 0;
      audio.play().catch(function () {});
      return;
    }
    var i = chainNextIndex(1);
    if (i >= 0) playSong(playlist[i]);
    else audio.pause();
  }
  function onTimeUpdate(e) {
    if (e.target !== audio) return;
    if (audio.duration && !seekDragging) {
      seek.value = Math.round((audio.currentTime / audio.duration) * 1000);
      syncSeekFill();
      $("t-cur").textContent = fmt(audio.currentTime);
      $("t-dur").textContent = fmt(audio.duration);
    }
    if (Date.now() - lastPositionSave > 3000) {
      lastPositionSave = Date.now();
      saveSession();
    }
    maybeNatural();
    triggerNatural();
    updateLyricHighlight(audio.currentTime);
  }
  [audioA, audioB].forEach(function (el) {
    el.addEventListener("play", onPlayPauseUI);
    el.addEventListener("pause", onPlayPauseUI);
    el.addEventListener("ended", onEnded);
    el.addEventListener("timeupdate", onTimeUpdate);
  });

  var seekDragging = false;
  var seek = $("seek");
  // #19 进度条粉色填充：--p 由这里同步（CSS 渐变消费）
  function syncSeekFill() {
    seek.style.setProperty("--p", (seek.value / 10) + "%");
  }
  syncSeekFill();
  seek.addEventListener("input", function () {
    seekDragging = true;
    syncSeekFill();
    if (audio.duration) {
      $("t-cur").textContent = fmt((seek.value / 1000) * audio.duration);
    }
  });
  seek.addEventListener("change", function () {
    if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration;
    syncSeekFill();
    seekDragging = false;
  });

  document.body.addEventListener("refreshSongs", refreshPlaylist);
  document.body.addEventListener("htmx:afterSwap", function (e) {
    // 搜索/任务局部刷新重绘了曲库网格 → 恢复“正在播放”标记
    if (e.target && e.target.id === "songs") {
      markPlayingCard(playlist[current] ? playlist[current].id : null);
    }
  });
  window.addEventListener("beforeunload", saveSession);

  // ---------- Smart Transition：纯在线版已停用（依赖本地音频分析）----------
  // 保留调用点与降级路径（playSongSmart/planChain 等以 smartEnabled() 短路），代码可整体回退
  function smartEnabled() {
    return false;
  }
  function setGain(el, v) {
    if (gains && gains[el.id]) gains[el.id].gain.value = v;
  }
  function ensureGraph() {
    if (audioCtx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      audioCtx = new Ctx();
      gains = {};
      [audioA, audioB].forEach(function (el) {
        var src = audioCtx.createMediaElementSource(el);
        var g = audioCtx.createGain();
        src.connect(g);
        g.connect(audioCtx.destination);
        gains[el.id] = g;
      });
      gains[audioA.id].gain.value = 1;
      gains[audioB.id].gain.value = 0;
    } catch (e) {
      audioCtx = null; // Web Audio 不可用 → 全部路径自然降级为硬切
    }
  }
  function cancelTransition() {
    if (!transitionState) return;
    clearTimeout(transitionState.timer);
    transitionState.mainEl.pause();
    setGain(audioA, audioA === audio ? 1 : 0);
    setGain(audioB, audioB === audio ? 1 : 0);
    transitionState = null;
  }
  function startTransition(plan, nextSong) {
    ensureGraph();
    if (!audioCtx) { playSong(nextSong); return; }
    if (audioCtx.state === "suspended") audioCtx.resume();
    cancelTransition();
    var mainEl = audio;
    var nextEl = mainEl === audioA ? audioB : audioA;
    var D = Math.max(0.3, plan.duration);
    nextEl.src = nextSong.audioUrl;
    nextEl.currentTime = plan.entryT;
    var gMain = gains[mainEl.id], gNext = gains[nextEl.id];
    var t0 = audioCtx.currentTime, steps = 40;
    gMain.gain.cancelScheduledValues(t0);
    gMain.gain.setValueAtTime(gMain.gain.value, t0);
    gNext.gain.cancelScheduledValues(t0);
    gNext.gain.setValueAtTime(0.0001, t0);
    // Equal-Power 曲线：A cos(πx/2) → 0，B sin(πx/2) → 1，重叠期响度稳定
    for (var i = 1; i <= steps; i++) {
      var x = i / steps, at = t0 + x * D;
      gMain.gain.linearRampToValueAtTime(Math.cos(Math.PI * x / 2), at);
      gNext.gain.linearRampToValueAtTime(Math.max(0.0001, Math.sin(Math.PI * x / 2)), at);
    }
    var p = nextEl.play();
    if (p && p.catch) p.catch(function () {});
    audio = nextEl; // active 指针切到 B
    playlist.forEach(function (s, i2) { if (s.id === nextSong.id) current = i2; });
    updateNowPlaying(nextSong);
    planChain(); // 链以切入的歌为起点重排
    saveSession();
    transitionState = {
      mainEl: mainEl,
      timer: setTimeout(function () {
        mainEl.pause();
        setGain(mainEl, 0);
        setGain(audio, 1);
        transitionState = null;
      }, D * 1000 + 120),
    };
  }
  function maybeNatural() {
    if (naturalPlan || !smartEnabled() || repeatOne || transitionState) return;
    if (!audio.duration) return;
    var remaining = audio.duration - audio.currentTime;
    if (remaining > 30 || remaining <= 4) return;
    var ni = chainNextIndex(1);
    if (ni < 0) return;
    var cur = playlist[current], nx = playlist[ni];
    if (!cur || !nx) return;
    var fa = analysisCache[cur.id], fb = analysisCache[nx.id];
    if (!fa || !fb) { prefetchAnalyses(); return; } // 等分析就绪，下次 timeupdate 再试
    var plan = window.SmartTransition.planTransition(fa, fb, 0, { type: "natural" });
    if (plan) { plan.nextSong = nx; naturalPlan = plan; }
  }
  function triggerNatural() {
    if (!naturalPlan || transitionState) return;
    if (audio.currentTime >= naturalPlan.exitT - 0.05) {
      var plan = naturalPlan;
      naturalPlan = null;
      startTransition(plan, plan.nextSong);
    }
  }
  function prefetchAnalyses() {
    // 自动决策链需要全队列的分析：预取整个队列（上限 100 首）
    var ids = [];
    playlist.forEach(function (s) {
      if (!analysisCache[s.id] && ids.indexOf(s.id) === -1 && ids.length < 100) ids.push(s.id);
    });
    ids.forEach(function (id) {
      if (analysisPending[id]) return;
      analysisPending[id] = true;
      fetch("/api/songs/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songId: id })
      })
        .then(function (r) {
          return r.json().then(function (d) { return { status: r.status, d: d }; });
        })
        .then(function (res) {
          if (res.status === 200) {
            analysisCache[id] = res.d;
            delete analysisPending[id];
            planChain(); // 新分析到位 → 链可能更优，自动重排
          } else if (res.status !== 202) {
            delete analysisPending[id];
          } else {
            // 分析中：服务端单首约 0.4s，2.5s 后允许重试
            setTimeout(function () { delete analysisPending[id]; }, 2500);
          }
        })
        .catch(function () { delete analysisPending[id]; });
    });
  }
  // 单曲循环开关（独立于自动决策链）
  var repeatToggle = $("repeat-one-toggle");
  if (repeatToggle) {
    repeatToggle.checked = repeatOne;
    repeatToggle.addEventListener("change", function () {
      repeatOne = repeatToggle.checked;
      localStorage.setItem("bmRepeatOne", repeatOne ? "1" : "0");
    });
  }

  // 播放列表面板
  var queuePanel = $("queue-panel");
  $("btn-queue").addEventListener("click", function () {
    queuePanel.classList.toggle("hidden");
    if (!queuePanel.classList.contains("hidden")) renderQueue();
  });
  $("queue-list").addEventListener("click", function (e) {
    var li = e.target.closest("li[data-idx]");
    if (li) {
      var song = queueDisplayItems[Number(li.getAttribute("data-idx"))];
      if (song) playSongSmart(song);
    }
  });

  // ---------- 歌词面板（B站字幕 + LRCLIB 混合，后端返回 LRC/纯文本） ----------
  var NOTE_RE = /[♪♫♩♬]/g; // 歌词行装饰符号（LRCLIB/AI 字幕常见），展示前剥掉

  function parseLrc(text) {
    var out = [], timed = 0;
    String(text || "").split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var m = line.match(/^\[(\d{1,2}):(\d{1,2}(?:\.\d{1,2})?)\](.*)$/);
      var body;
      if (m) {
        timed++;
        body = m[3].trim();
      } else {
        body = line.replace(/^\[[^\]]*\]/, "").trim();
      }
      body = body.replace(NOTE_RE, " ").replace(/\s+/g, " ").trim();
      out.push({ t: m ? parseInt(m[1], 10) * 60 + parseFloat(m[2]) : -1, text: body });
    });
    out.sort(function (a, b) { return (a.t < 0 ? 1e9 : a.t) - (b.t < 0 ? 1e9 : b.t); });
    return { lines: out, timed: timed >= 2 };
  }

  function renderLyrics() {
    var box = $("lyrics-scroll");
    if (!lyricLines.length) {
      box.innerHTML = '<div class="l-empty">暂无歌词</div>';
      return;
    }
    box.innerHTML = lyricLines.map(function (l, i) {
      var t = l.text || "· · ·"; // 纯音乐/间奏行：圆点代替 ♪
      return '<p class="l-line" data-idx="' + i + '">' + escapeHtml(t) + "</p>";
    }).join("");
    box.classList.toggle("timed", lyricTimed); // 有轴歌词可点击跳转
  }

  // 点击歌词行跳转到该行时间（曲库歌与试听流都支持；无轴歌词不响应）
  $("lyrics-scroll").addEventListener("click", function (e) {
    var line = e.target.closest(".l-line");
    if (!line || !lyricTimed) return;
    var l = lyricLines[Number(line.dataset.idx)];
    if (!l || l.t < 0) return;
    var m = (recActive && recAudio) ? recAudio : audio;
    if (!m) return;
    try { m.currentTime = l.t; } catch (err) {}
    updateLyricHighlight(l.t, true);
  });

  // 播放页封面/标题同步到大小两处（顶栏小封面 + 手机端大封面视图）
  function setLyricsCover(src) {
    var backdrop = $("lyrics-backdrop");
    if (backdrop && backdrop.getAttribute("src") !== (src || null)) {
      backdrop.classList.remove("ready");
      backdrop.onload = function () { backdrop.classList.add("ready"); };
      backdrop.onerror = function () { backdrop.classList.remove("ready"); };
      if (src) backdrop.src = src;
      else backdrop.removeAttribute("src");
    }
    var a = $("lyrics-cover"), b = $("lyrics-cover-big");
    if (!src) {
      if (a) a.removeAttribute("src");
      if (b) b.removeAttribute("src");
      return;
    }
    if (a) a.src = src;
    if (b) b.src = src;
  }
  function setLyricsText(title, artist) {
    var t1 = $("lyrics-title"), t2 = $("ly-title-big");
    if (t1) {
      t1.textContent = title;
      t1.title = title;
      if (window.BiliTicker) BiliTicker.set(t1); // 歌词页大标题同走马灯（#13）
    }
    if (t2) { t2.textContent = title; t2.title = title; }
    $("lyrics-artist").textContent = artist;
    var ba = $("ly-artist-big");
    if (ba) ba.textContent = artist;
  }

  function loadLyrics(meta) {
    // meta: {key, title, artist, cover, fetchUrl, fetchInit} — key 区分库内歌 / 试听歌
    lyricSongId = meta.key;
    lyricLines = []; lyricTimed = false; lyricIdx = -1;
    setLyricsText(meta.title, meta.artist);
    setLyricsCover(meta.cover);
    $("lyrics-scroll").innerHTML = '<div class="l-empty">歌词加载中…</div>';
    fetch(meta.fetchUrl, meta.fetchInit)
      .then(function (r) { return r.ok ? r.json() : { lyrics: null }; })
      .then(function (d) {
        if (lyricSongId !== meta.key) return; // 请求期间已切歌
        var parsed = parseLrc(d.lyrics);
        lyricLines = parsed.lines;
        lyricTimed = parsed.timed;
        lyricIdx = -1;
        renderLyrics();
        var now = meta.isTrial && recAudio ? recAudio.currentTime : (audio.currentTime || 0);
        updateLyricHighlight(now, true);
      })
      .catch(function () {
        if (lyricSongId !== meta.key) return;
        $("lyrics-scroll").innerHTML = '<div class="l-empty">暂无歌词</div>';
      });
  }

  // 跟随播放进度滚动高亮：线性指针小步推进，拖进度条大跳时重扫
  function updateLyricHighlight(now, force) {
    if (!lyricTimed || !lyricLines.length) return;
    var panel = $("lyrics-panel");
    if (panel.classList.contains("hidden")) return; // 面板收起时不做滚动
    var idx = lyricIdx < 0 || lyricIdx >= lyricLines.length ? 0 : lyricIdx;
    if (force || lyricLines[idx].t > now) idx = 0;
    while (idx + 1 < lyricLines.length && lyricLines[idx + 1].t <= now) idx++;
    while (idx > 0 && lyricLines[idx].t > now) idx--;
    if (idx === lyricIdx && !force) return;
    lyricIdx = idx;
    var box = $("lyrics-scroll");
    var nodes = box.querySelectorAll(".l-line");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle("on", i === idx);
    }
    var el = nodes[idx];
    if (el) box.scrollTop = Math.max(0, el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2);
  }

  function libLyricsMeta(song) {
    return {
      key: "lib:" + song.id, title: song.title, artist: song.artist, cover: song.coverUrl,
      fetchUrl: "/api/songs/" + song.id + "/lyrics",
    };
  }

  function trialLyricsMeta() {
    if (!recAudio) return null;
    return {
      key: "trial:" + recAudio.dataset.bvid,
      title: recAudio.dataset.title || "实时流试听",
      artist: recAudio.dataset.artist || "",
      cover: recAudio.dataset.cover || "",
      isTrial: true,
      fetchUrl: "/api/lyrics/preview",
      fetchInit: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bvid: recAudio.dataset.bvid,
          title: recAudio.dataset.title || "",
          artist: recAudio.dataset.artist || "",
          duration: Math.round(recAudio.duration || 0),
        }),
      },
    };
  }

  window.toggleLyrics = function () {
    var panel = $("lyrics-panel");
    var opening = panel.classList.contains("hidden");
    if (opening && window.__hidePanel) {
      // 艺术家页还开着时点播放条进歌词页：先收起艺术家页（歌词页层级在其下，否则被盖住）
      var upp = document.getElementById("up-panel");
      if (upp && !upp.classList.contains("hidden")) __hidePanel(upp);
    }
    if (window.__showPanel && opening) __showPanel(panel);
    else if (window.__hidePanel && !opening) __hidePanel(panel);
    else panel.classList.toggle("hidden");
    $("btn-lyrics").classList.toggle("on", opening);
    if (!opening) return;
    if (recActive && recAudio) { // 试听歌：bvid 直接取词
      var tm = trialLyricsMeta();
      setLyricsCover(tm.cover);
      if (lyricSongId === tm.key && lyricLines.length) updateLyricHighlight(recAudio.currentTime || 0, true);
      else loadLyrics(tm);
      return;
    }
    var song = playlist[current];
    if (song) setLyricsCover(song.coverUrl);
    if (song) {
      if (lyricSongId === "lib:" + song.id && lyricLines.length) updateLyricHighlight(audio.currentTime || 0, true);
      else loadLyrics(libLyricsMeta(song));
    } else {
      setLyricsText("—", "");
      renderLyrics();
    }
  };
  $("btn-lyrics").addEventListener("click", window.toggleLyrics);
  $("btn-lyrics-close").addEventListener("click", function () {
    if (window.__hidePanel) __hidePanel($("lyrics-panel"));
    else $("lyrics-panel").classList.add("hidden");
    $("btn-lyrics").classList.remove("on");
  });

  // 搜索框由 v3.js 接管（下拉：曲库命中 + B 站结果）；播放队列不再跟随搜索词
  refreshPlaylist();

  // ---------- 扫码登录弹窗（未登录时任意操作触发；打开才生成二维码） ----------
  var qrImg = $("qr-img");
  var qrcodeKey = null;
  var pollTimer = null;
  var qrLive = false;
  var pollBusy = false;
  var qrAttempt = 0;

  function stopQr() {
    qrAttempt++;
    qrLive = false;
    qrcodeKey = null;
    pollBusy = false;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function authJson(response) {
    return response.json().then(function (data) {
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "登录请求失败，请重试");
      return data;
    });
  }

  function genQr() {
    stopQr();
    qrLive = true;
    var attempt = qrAttempt;
    $("qr-status").textContent = "正在生成二维码…";
    qrImg.hidden = true;
    $("qr-refresh").classList.add("hidden");
    fetch("/api/auth/qrcode", { method: "POST" })
      .then(authJson)
      .then(function (d) {
        if (attempt !== qrAttempt || !qrLive) return;
        qrImg.src = d.qrPngDataUrl;
        qrImg.hidden = false;
        $("qr-status").textContent = "请用 B 站 App 扫一扫";
        qrcodeKey = d.qrcodeKey;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(checkPoll, 1500);
      })
      .catch(function (error) {
        if (attempt !== qrAttempt) return;
        stopQr();
        $("qr-status").textContent = error.message || "生成失败，稍后重试";
        $("qr-refresh").classList.remove("hidden");
      });
  }

  function checkPoll() {
    // 服务端生成的 key 固定为 32 位十六进制；先校验再拼入同源路径
    if (!qrLive || pollBusy || !qrcodeKey || !/^[0-9a-f]{32}$/.test(qrcodeKey)) return;
    pollBusy = true;
    var attempt = qrAttempt;
    fetch("/api/auth/qrcode/" + qrcodeKey)
      .then(authJson)
      .then(function (d) {
        if (attempt !== qrAttempt || !qrLive) return;
        if (d.status === "scanned") $("qr-status").textContent = "已扫码，请在手机上确认登录";
        if (d.status === "expired") {
          stopQr();
          $("qr-status").textContent = "二维码已失效";
          $("qr-refresh").classList.remove("hidden");
        }
        if (d.status === "confirmed") {
          stopQr();
          $("qr-status").textContent = "登录成功，正在进入…";
          setTimeout(function () { location.href = "/"; }, 800);
        }
      })
      .catch(function (error) {
        if (attempt !== qrAttempt) return;
        stopQr();
        $("qr-status").textContent = error.message || "登录失败，请重试";
        $("qr-refresh").classList.remove("hidden");
      })
      .finally(function () { if (attempt === qrAttempt) pollBusy = false; });
  }

  window.openLogin = function () {
    var m = $("login-modal");
    if (!m) return;
    m.classList.remove("hidden");
    if (!qrLive) { qrLive = true; genQr(); }
  };
  window.closeLogin = function () {
    var m = $("login-modal");
    if (!m) return;
    m.classList.add("hidden");
    stopQr(); // 关窗后到达的响应不能重新开始轮询
  };
  var qrRefreshBtn = $("qr-refresh");
  if (qrRefreshBtn) qrRefreshBtn.addEventListener("click", genQr);
  var loginCloseBtn = $("login-close");
  if (loginCloseBtn) loginCloseBtn.addEventListener("click", window.closeLogin);
  if (location.search.indexOf("login=1") >= 0) window.openLogin(); // 兼容旧 /login 链接

  // ---------- 短信验证码登录（B 站同款极验滑块：gt.js 懒加载） ----------
  var gtReady = null;
  function loadGt() {
    if (window.initGeetest) return Promise.resolve();
    if (gtReady) return gtReady;
    gtReady = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://static.geetest.com/static/tools/gt.js";
      s.onload = resolve;
      s.onerror = function () { gtReady = null; reject(new Error("gt.js 加载失败")); };
      document.head.appendChild(s);
    });
    return gtReady;
  }
  function smsMsg(txt, isErr) {
    var el = $("sms-msg");
    if (!el) return;
    el.textContent = txt || "";
    el.classList.toggle("err", !!isErr);
  }
  var smsCountdown = 0;
  function tickSmsBtn() {
    var btn = $("sms-send");
    if (!btn) return;
    if (smsCountdown > 0) {
      btn.disabled = true;
      btn.textContent = smsCountdown + "s";
    } else {
      btn.disabled = false;
      btn.textContent = "获取验证码";
    }
  }
  var smsCaptchaKey = ""; // B 站流程：发送成功后返回 captcha_key，登录时必带
  // 获取验证码：拉极验参数 → 弹滑块 → 通过后调发送接口
  function smsSend() {
    var tel = ($("sms-tel").value || "").trim();
    if (!/^\d{11}$/.test(tel)) { smsMsg("请输入 11 位手机号", true); return; }
    smsMsg("加载验证组件…");
    loadGt()
      .then(function () { return fetch("/api/auth/captcha").then(function (r) { return r.ok ? r.json() : null; }); })
      .then(function (cap) {
        if (!cap || !cap.geetest) throw new Error("获取验证参数失败");
        window.initGeetest({
          gt: cap.geetest.gt, challenge: cap.geetest.challenge,
          offline: false, new_captcha: true, product: "bind", // bind 模式：不绑 DOM，verify() 手动弹滑块
        }, function (captchaObj) {
          captchaObj.onReady(function () { captchaObj.verify(); smsMsg("请完成滑块验证…"); });
          captchaObj.onSuccess(function () {
            var v = captchaObj.getValidate();
            fetch("/api/auth/sms/send", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tel: tel, cid: "86", token: cap.token,
                challenge: v.geetest_challenge, validate: v.geetest_validate, seccode: v.geetest_seccode,
              }),
            }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
              .then(function (res) {
                if (res.ok && res.d.ok) {
                  smsCaptchaKey = res.d.captchaKey || "";
                  smsMsg("验证码已发送，5 分钟内有效");
                  smsCountdown = 60;
                  tickSmsBtn();
                  var iv = setInterval(function () {
                    smsCountdown--; tickSmsBtn();
                    if (smsCountdown <= 0) clearInterval(iv);
                  }, 1000);
                } else {
                  smsMsg((res.d && res.d.detail) || "发送失败，请重试", true);
                }
              });
          });
          captchaObj.onError(function () { smsMsg("验证组件出错，请重试", true); });
          captchaObj.onClose(function () { smsMsg("完成滑块验证后才能发送验证码", true); });
        });
      })
      .catch(function (e) { smsMsg(e.message || "加载失败，请重试", true); });
  }
  var smsSendBtn = $("sms-send");
  if (smsSendBtn) smsSendBtn.addEventListener("click", smsSend);

  // ---------- 浏览器登录兜底（#18）：WebView 里极验滑块可能起不来 ----------
  // 点击 → 桥/新窗口打开系统浏览器登录页（同一后端，Cookie 存服务端互通）→
  // 按钮变「我已完成登录」→ 再点探测登录态，成功即整页刷新。
  var blBrowserBtn = $("bl-open-browser");
  if (blBrowserBtn) {
    var blOpened = false;
    blBrowserBtn.addEventListener("click", function () {
      if (!blOpened) {
        blOpened = true;
        if (window.BiliMusicNative && window.BiliMusicNative.openExternalLogin) {
          BiliMusicNative.openExternalLogin();
        } else {
          window.open(location.origin + "/?login=1", "_blank");
        }
        blBrowserBtn.textContent = "在浏览器完成登录后，点此继续 →";
        return;
      }
      fetch("/api/auth/status", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("status " + r.status)); })
        .then(function (d) {
          if (d && d.loggedIn) location.reload();
          else {
            window.__toast && window.__toast("还未检测到登录，请先在浏览器完成");
            blBrowserBtn.textContent = "还没检测到？完成登录后再点一次";
          }
        })
        .catch(function () { window.__toast && window.__toast("暂时连不上 B 站，稍后再试"); });
    });
  }
  var smsGo = $("sms-go");
  if (smsGo) smsGo.addEventListener("click", function () {
    var tel = ($("sms-tel").value || "").trim();
    var code = ($("sms-code").value || "").trim();
    if (!/^\d{11}$/.test(tel)) { smsMsg("请输入 11 位手机号", true); return; }
    if (!/^\d{6}$/.test(code)) { smsMsg("请输入 6 位验证码", true); return; }
    if (!smsCaptchaKey) { smsMsg("请先获取短信验证码", true); return; }
    if (smsGo.disabled) return;
    stopQr();
    smsGo.disabled = true;
    smsMsg("登录中…");
    fetch("/api/auth/sms/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tel: tel, code: code, cid: "86", captchaKey: smsCaptchaKey }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.ok === true) {
          smsMsg("登录成功，正在进入…");
          setTimeout(function () { location.href = "/"; }, 600);
        } else {
          smsMsg((res.d && res.d.detail) || "登录失败，请重试", true);
        }
      })
      .catch(function () { smsMsg("网络错误，请重试", true); })
      .finally(function () { smsGo.disabled = false; });
  });

  // 未登录：任何 htmx/fetch 打到鉴权接口的 401 都弹登录窗
  // 初始加载抑制窗口：页面装载期的局部请求 401 不弹窗（空骨架自然呈现），之后的用户操作才弹
  var suppress401 = true;
  setTimeout(function () { suppress401 = false; }, 2000);
  document.body.addEventListener("htmx:responseError", function (e) {
    var xhr = e.detail && e.detail.xhr;
    if (xhr && xhr.status === 401 && !suppress401) {
      if (e.preventDefault) e.preventDefault();
      window.openLogin();
    }
  });
  var rawFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    return rawFetch(input, init).then(function (resp) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (resp.status === 401 && url.indexOf("/api/") === 0 && url.indexOf("/api/auth") !== 0 && !suppress401) {
        window.openLogin();
      }
      return resp;
    });
  };
  // 登出处理见 export.js（账号相关杂项）
  // ---------- 供外部调用的播放器 API ----------
  window.BiliPlayer = {
    playById: function (id) {
      // data-play 传来的是字符串、数组里是数字：必须字符串化后再比（严格 === 会全部失配）
      var want = String(id);
      function lookup() {
        for (var i = 0; i < playlist.length; i++) {
          if (String(playlist[i].id) === want) return playlist[i];
        }
        return null;
      }
      var song = lookup();
      if (song) { playSongSmart(song); return; }
      // 曲目数组是异步装载的（页面刚开就点播放的竞态）：拉一次全量再重试，不再静默吞掉
      refreshPlaylist().then(function () {
        var again = lookup();
        if (again) playSongSmart(again);
      });
    },
    toggle: function () { $("btn-toggle").click(); },
    skip: skip,
    currentId: function () { return playlist[current] ? playlist[current].id : null; },
    isPlaying: function () { return !!audio.src && !audio.paused; },
    songs: fetchSongs, // v3.js 搜索下拉用
    activeMedia: function () { return (recActive && recAudio) ? recAudio : audio; }, // 歌词页进度条寻址
    currentSong: function () { return playlist[current] || null; }, // 含 bvid
    trialInfo: function () { // 试听歌元数据（bvid/title/artist/cover），非试听返回 null
      return (recActive && recAudio)
        ? { bvid: recAudio.dataset.bvid, title: recAudio.dataset.title, artist: recAudio.dataset.artist, cover: recAudio.dataset.cover }
        : null;
    },
  };

  // ---------- 歌单（每歌单对应收藏夹 bilimusic- <歌单名>） ----------

  function activePlaylistId() {
    return localStorage.getItem(accountKey("bm_pl")) || "0";
  }

  function markActivePlaylist() {
    var active = activePlaylistId();
    var activeName = localStorage.getItem(accountKey("bm_pl_name")) || "全部歌曲";
    document.querySelectorAll("[data-pl]").forEach(function (c) {
      c.classList.toggle("on", String(c.dataset.pl) === active);
    });
    var hid = document.getElementById("collect-playlist-id");
    if (hid) hid.value = active;
    var box = document.querySelector(".collect-box input[name=url]");
    if (box) {
      box.placeholder = "粘贴 B 站视频链接，收藏到「" + activeName + "」…";
    }
  }

  window.switchView = function (name) {
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("on", v.id === "view-" + name);
    });
    document.querySelectorAll(".side-item[data-view]").forEach(function (b) {
      b.classList.toggle("on", b.dataset.view === name);
    });
  };

  window.selectPlaylist = function (id, el) {
    localStorage.setItem(accountKey("bm_pl"), String(id));
    localStorage.setItem(accountKey("bm_pl_name"), (el && el.dataset.name) || "全部歌曲");
    markActivePlaylist();
    // 主页「全部歌曲」已由推荐歌曲取代：仅详情页等仍挂 #songs 的场景需要刷新
    if (document.getElementById("songs")) {
      htmx.ajax("GET", "/partials/songs?playlist_id=" + id, {
        target: "#songs",
        swap: "innerHTML",
      });
    }
  };

  // web 表单路径统一带 htmx 头：未登录时服务端回 401 JSON（不带会被 307 重定向吞掉，
  // fetch 跟随拿到 HTML 却"成功"，歌单实际没建——#7 根因之一）
  async function webFormPost(url, body) {
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "HX-Request": "true" },
        body: body,
      });
    } catch (e) {
      return null; // 网络异常：调用方统一提示
    }
  }

  // 统一错误出口：网络失败 → toast；401 → 弹登录；其余 → 展示服务端人类可读信息
  async function formFailed(resp, fallback) {
    if (!resp) { window.__toast && window.__toast("网络错误，请重试"); return true; }
    if (resp.status === 401) {
      if (window.openLogin) openLogin();
      else window.__toast && window.__toast("请先登录 B 站账号");
      return true;
    }
    if (!resp.ok) {
      var msg = fallback;
      try {
        var data = await resp.json();
        if (data && data.detail) msg = data.detail;
      } catch (e) {}
      window.__toast && window.__toast(msg);
      return true;
    }
    return false;
  }

  window.createPlaylist = async function () {
    var name = window.__promptModal
      ? await window.__promptModal("新建歌单", { placeholder: "歌单名" })
      : prompt("歌单名：");
    if (!name || !name.trim()) return;
    var resp = await webFormPost("/web/playlists/create", new URLSearchParams({ name: name.trim() }));
    if (await formFailed(resp, "创建失败")) return;
    window.__toast && window.__toast("歌单已创建 · B 站收藏夹已同步");
    htmx.trigger(document.body, "playlistsChanged");
    htmx.ajax("GET", "/partials/playlists", { target: "#playlists-bar", swap: "innerHTML" });
  };

  window.renamePlaylist = async function (id, oldName) {
    var name = window.__promptModal
      ? await window.__promptModal("重命名歌单", { value: oldName })
      : prompt("新的歌单名（B 站收藏夹将同步改名）：", oldName);
    if (!name || !name.trim() || name === oldName) return;
    var resp = await webFormPost("/web/playlists/rename", new URLSearchParams({ id: id, name: name.trim() }));
    if (await formFailed(resp, "改名失败")) return;
    window.__toast && window.__toast("已改名 · B 站收藏夹同步更新");
    htmx.trigger(document.body, "playlistsChanged");
    htmx.ajax("GET", "/partials/playlists", { target: "#playlists-bar", swap: "innerHTML" });
  };

  window.deletePlaylist = async function (id, name) {
    var ok = window.__confirmModal
      ? await window.__confirmModal("删除歌单「" + name + "」？",
          "歌单内的歌曲会移入「我的曲库」（不会丢失）；对应的 B 站收藏夹 bilimusic- " + name + " 将一并删除；歌曲的 B 站收藏会后台转移到主夹。")
      : confirm("删除歌单「" + name + "」？\n\n· 歌单内的歌曲会移入「我的曲库」（不会丢失）\n· 对应的 B 站收藏夹 bilimusic- " + name + " 将一并删除\n· 歌曲的 B 站收藏会转移到主夹（后台进行）");
    if (!ok) return;
    var resp = await webFormPost("/web/playlists/delete", new URLSearchParams({ id: id }));
    if (await formFailed(resp, "删除失败")) return;
    if (activePlaylistId() === String(id)) selectPlaylist(0);
    htmx.trigger(document.body, "playlistsChanged");
    htmx.ajax("GET", "/partials/playlists", { target: "#playlists-bar", swap: "innerHTML" });
  };

  document.addEventListener("DOMContentLoaded", markActivePlaylist);
  document.addEventListener("htmx:afterSwap", function (e) {
    if (e.target && e.target.id === "playlists-bar") markActivePlaylist();
  });

  // ---------- 发现/推荐池（实时流试听，不下载；过期自动出池） ----------

  var recAudio = null;
  var recActive = false; // 发现池试听时，播放胶囊由实时流接管

  function stopTrial() {
    if (!recAudio) return;
    try { recAudio.pause(); } catch (e) {}
    recActive = false;
    document.body.classList.remove("trial");
  }

  function syncTrialUI() {
    if (!recActive || !recAudio) return;
    $("player-bar").classList.remove("hidden");
    var pt = $("player-title");
    pt.textContent = recAudio.dataset.title || "实时流试听";
    pt.title = pt.textContent;
    if (window.BiliTicker) BiliTicker.set(pt);
    $("player-artist").textContent = recAudio.dataset.artist || "";
    if (recAudio.dataset.cover) $("player-cover").src = recAudio.dataset.cover;
    // 试听接管即重置进度显示（清掉曲库歌遗留的填充/时间码）
    var seekEl = $("seek");
    if (seekEl) {
      seekEl.value = 0;
      syncSeekFill();
    }
    $("t-cur").textContent = "0:00";
    $("t-dur").textContent = "0:00";
  }

  // 迷你圆钮只显示单字符态（▶/⏸/⏳），旧长文案按钮兼容
  function setRecBtn(btn, label) {
    if (!btn) return;
    btn.textContent = btn.classList.contains("mini-act") ? label.charAt(0) : label;
  }

  function resetRecButtons() {
    document.querySelectorAll(".rec-play").forEach(function (b) {
      setRecBtn(b, "▶ 试听");
    });
  }

  // 通用实时流试听：接管播放胶囊（meta: {title, artist, cover}）
  window.playStream = function (bvid, meta, btn) {
    if (recAudio && recAudio.dataset.bvid === bvid) {
      if (recAudio.paused || recAudio.ended) {
        recActive = true;
        document.body.classList.add("trial");
        syncTrialUI();
        recAudio.play().catch(function () {});
        setRecBtn(btn, "⏸ 暂停");
      } else {
        recAudio.pause();
        setRecBtn(btn, "▶ 试听");
      }
      return;
    }
    if (recAudio) recAudio.pause();
    resetRecButtons();
    try { audioA.pause(); audioB.pause(); } catch (e) {} // 主音轨让位（不动会话，主播放器随时可切回）
    recAudio = new Audio("/api/stream/" + bvid);
    recAudio.dataset.bvid = bvid;
    recAudio.dataset.title = meta.title || "实时流试听";
    recAudio.dataset.artist = meta.artist || "";
    recAudio.dataset.cover = meta.cover || "";
    pushHistory({ k: "v" + bvid, kind: "stream", bvid: bvid, title: meta.title || "实时流试听", artist: meta.artist || "", cover: meta.cover || "" });
    recActive = true;
    document.body.classList.add("trial");
    syncTrialUI();
    recAudio.addEventListener("ended", function () {
      if (!recActive || recAudio.dataset.bvid !== bvid) return;
      var q = window.__trialQueue;
      if (q && q.items && q.items.length > 1) { skip(1); return; }
      resetRecButtons();
      setPlayerToggle(true);
      if (audioA.paused && audioB.paused) document.body.classList.remove("playing");
    });
    recAudio.addEventListener("error", function () {
      resetRecButtons();
      stopTrial();
      alert("试听失败：该视频可能已失效");
    });
    recAudio.addEventListener("playing", function () {
      var active = document.querySelector('.rec-play[data-bvid="' + bvid + '"]');
      setRecBtn(active, "⏸ 暂停");
    });
    recAudio.addEventListener("play", function () {
      setPlayerToggle(false);
      document.body.classList.add("playing");
      syncTrialUI();
      document.querySelectorAll(".trk-rec, .rec-card").forEach(function (row) {
        row.classList.toggle("playing", row.dataset.bvid === bvid);
      });
      if (!$("lyrics-panel").classList.contains("hidden")) loadLyrics(trialLyricsMeta()); // 歌词页开着：切试听歌即刷新
    });
    recAudio.addEventListener("timeupdate", function () {
      if (recActive) updateLyricHighlight(recAudio.currentTime); // 歌词跟随试听进度
    });
    recAudio.addEventListener("pause", function () {
      setPlayerToggle(true);
      if (audioA.paused && audioB.paused) document.body.classList.remove("playing");
    });
    recAudio.play().catch(resetRecButtons);
    setRecBtn(btn, "⏳ 缓冲");
  };

  window.playRec = function (bvid, btn) {
    if (recAudio && recAudio.dataset.bvid === bvid) { playStream(bvid, {}, btn); return; }
    var meta = {};
    var card = btn && btn.closest ? btn.closest(".reccard") : null;
    if (card) {
      var nm = card.querySelector(".nm"), ar = card.querySelector(".ar"), im = card.querySelector("img");
      meta = { title: nm ? nm.textContent : "", artist: ar ? ar.textContent : "", cover: im ? im.src : "" };
    }
    playStream(bvid, meta, btn);
  };

  window.dismissRec = function (bvid, el) {
    var body = new URLSearchParams({ bvid: bvid });
    fetch("/web/recs/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    });
    var card = el && el.closest ? el.closest(".rec-card") : null;
    if (card) card.remove();
  };

  // 收藏成功：点亮爱心 + toast；失败：toast 提示（不能在请求发出时立刻改 DOM——htmx 1.x 会中止该请求）
  document.addEventListener("htmx:afterRequest", function (e) {
    var elt = e.detail && e.detail.elt;
    if (!elt || !elt.classList || !elt.classList.contains("rec-collect")) return;
    if (e.detail.successful) {
      var bvid = elt.dataset.bvid;
      if (bvid && window.__markCollected) window.__markCollected(bvid);
      if (window.__toast) window.__toast("已收藏 · 已同步 B 站「bilimusic」夹");
      var card = elt.closest(".reccard, .rec-card");
      if (card) { // 发现池：转正出池，延迟淡出（让爱心点亮被看到）
        setTimeout(function () {
          if (!card.parentNode) return;
          card.classList.add("gone");
          setTimeout(function () { if (card.parentNode) card.remove(); }, 450);
        }, 900);
      }
    } else {
      if (window.__toast) window.__toast("收藏失败，请稍后重试");
    }
  });

  // ---------- 最近播放（本机 localStorage 记录；曲库歌与实时流统一进货架；按账号 mid 隔离） ----------
  function historyKey() {
    return "bmHistory:" + (document.body.dataset.mid || "0");
  }
  function bmHistory() {
    try { return JSON.parse(localStorage.getItem(historyKey()) || "[]"); } catch (e) { return []; }
  }
  function escHtml(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function historyCardHtml(x) {
    var inner =
      '<span class="im">' +
      '<img src="' + escHtml(x.cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' +
      '</span>' +
      '<span class="t1">' + escHtml(x.title) + "</span>" +
      '<span class="t2">' + escHtml(x.artist) + "</span>";
    // 曲库歌走 data-play 委托（点选即播）；实时流走 playRecRow（bvid 试听）
    return x.kind === "song"
      ? '<div class="rec-card card" data-play="' + escHtml(x.id) + '" title="' + escHtml(x.title) + '">' + inner + "</div>"
      : '<div class="rec-card" data-bvid="' + escHtml(x.bvid) + '" onclick="playRecRow(this)" title="' + escHtml(x.title) + '">' + inner + "</div>";
  }
  function renderHistory() {
    var sec = document.getElementById("sec-history");
    var rack = document.getElementById("history-rack");
    if (!sec || !rack) return;
    var h = bmHistory();
    sec.hidden = h.length === 0;
    rack.innerHTML = h.map(historyCardHtml).join("");
  }
  window.pushHistory = function (entry) {
    if (!entry || !entry.k) return;
    var h = bmHistory().filter(function (x) { return x.k !== entry.k; });
    entry.ts = Date.now();
    h.unshift(entry);
    try { localStorage.setItem(historyKey(), JSON.stringify(h.slice(0, 20))); } catch (e) {}
    renderHistory();
  };
  renderHistory();

  // 播放起播 → 以当前歌为种子搭车采集推荐（服务端频控，失败静默）
  var mainAudio = document.getElementById("audio");
  if (mainAudio) {
    mainAudio.addEventListener("play", function () {
      try {
        var id = window.BiliPlayer && window.BiliPlayer.currentId();
        if (!id) return;
        fetch("/api/recs/seed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ songId: id }),
        });
      } catch (e) { /* 采集失败不影响播放 */ }
    });
  }
})();
