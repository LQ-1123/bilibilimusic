/* BiliMusic Web 前端逻辑：播放器 + Media Session + 扫码登录（导出见 export.js） */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
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
      return "<li" + cls + ' data-idx="' + i + '">' +
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

  // 链上的上/下一首（环形，播完自动绕回，即隐含循环语义）
  function chainNextIndex(dir) {
    if (!chainOrder.length || !playlist.length) return -1;
    var curId = playlist[current] ? playlist[current].id : null;
    var pos = chainOrder.indexOf(curId);
    if (pos === -1) pos = 0;
    var next = (pos + dir + chainOrder.length) % chainOrder.length;
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
      localStorage.setItem("bmSession", JSON.stringify({
        songId: cur.id,
        position: audio.currentTime || 0,
        queueIds: playlist.map(function (s) { return s.id; })
      }));
    } catch (e) {}
  }

  function restoreSession() {
    var raw = null;
    try { raw = localStorage.getItem("bmSession"); } catch (e) {}
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
    var cards = document.querySelectorAll("#songs .card, #dt-songs .card");
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
    return fetch("/api/songs" + (q ? "?q=" + encodeURIComponent(q) : ""))
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
    if (smartEnabled()) prefetchAnalyses();
    planChain(); // 以新歌为起点重排自动决策链
  }

  function updateNowPlaying(song) {
    $("player-bar").classList.remove("hidden");
    $("player-cover").src = song.coverUrl;
    $("player-title").textContent = song.title;
    $("player-artist").textContent = song.artist + " · " + (song.qualityLabel || "");
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
    if (!$("lyrics-panel").classList.contains("hidden")) loadLyrics(song); // 面板开着：切歌即刷新
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
    stopTrial();
    naturalPlan = null;
    var ni = chainNextIndex(delta);
    if (ni < 0) return;
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
      if (confirm("确定从曲库删除这首歌？（本地文件一并删除）")) {
        fetch("/api/songs/" + delEl.dataset.del, { method: "DELETE" })
          .then(function () {
            if (window.htmx) htmx.trigger(document.body, "refreshSongs");
            refreshPlaylist();
          });
      }
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

  function onPlayPauseUI(e) {
    if (e.target !== audio) return;
    $("btn-toggle").textContent = audio.paused ? "▶" : "⏸";
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
      $("seek").value = Math.round((audio.currentTime / audio.duration) * 1000);
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
  seek.addEventListener("input", function () {
    seekDragging = true;
    if (audio.duration) {
      $("t-cur").textContent = fmt((seek.value / 1000) * audio.duration);
    }
  });
  seek.addEventListener("change", function () {
    if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration;
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

  // ---------- Smart Transition（智能过渡） ----------
  function smartEnabled() {
    return localStorage.getItem("bmSmartTransition") !== "0";
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
  var smartToggle = $("smart-toggle");
  if (smartToggle) {
    smartToggle.checked = smartEnabled();
    smartToggle.addEventListener("change", function () {
      localStorage.setItem("bmSmartTransition", smartToggle.checked ? "1" : "0");
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
  function parseLrc(text) {
    var out = [], timed = 0;
    String(text || "").split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var m = line.match(/^\[(\d{1,2}):(\d{1,2}(?:\.\d{1,2})?)\](.*)$/);
      if (m) {
        timed++;
        out.push({ t: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text: m[3].trim() });
      } else {
        out.push({ t: -1, text: line.replace(/^\[[^\]]*\]/, "").trim() });
      }
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
      return '<p class="l-line" data-idx="' + i + '">' + escapeHtml(l.text || "♪") + "</p>";
    }).join("");
  }

  function loadLyrics(song) {
    lyricSongId = song.id;
    lyricLines = []; lyricTimed = false; lyricIdx = -1;
    $("lyrics-title").textContent = song.title;
    $("lyrics-artist").textContent = song.artist;
    var lyCov = $("lyrics-cover");
    if (lyCov) lyCov.src = song.coverUrl;
    $("lyrics-scroll").innerHTML = '<div class="l-empty">歌词加载中…</div>';
    fetch("/api/songs/" + song.id + "/lyrics")
      .then(function (r) { return r.ok ? r.json() : { lyrics: null }; })
      .then(function (d) {
        if (lyricSongId !== song.id) return; // 请求期间已切歌
        var parsed = parseLrc(d.lyrics);
        lyricLines = parsed.lines;
        lyricTimed = parsed.timed;
        lyricIdx = -1;
        renderLyrics();
        updateLyricHighlight(audio.currentTime || 0, true);
      })
      .catch(function () {
        if (lyricSongId !== song.id) return;
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

  window.toggleLyrics = function () {
    var panel = $("lyrics-panel");
    var opening = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    $("btn-lyrics").classList.toggle("on", opening);
    if (!opening) return;
    var song = playlist[current];
    var lyCov = $("lyrics-cover");
    if (song && lyCov) lyCov.src = song.coverUrl;
    if (song) {
      if (lyricSongId === song.id && lyricLines.length) updateLyricHighlight(audio.currentTime || 0, true);
      else loadLyrics(song);
    } else {
      $("lyrics-title").textContent = "—";
      $("lyrics-artist").textContent = "";
      renderLyrics();
    }
  };
  $("btn-lyrics").addEventListener("click", window.toggleLyrics);
  $("btn-lyrics-close").addEventListener("click", function () {
    $("lyrics-panel").classList.add("hidden");
    $("btn-lyrics").classList.remove("on");
  });

  // 搜索框由 v3.js 接管（下拉：曲库命中 + B 站结果）；播放队列不再跟随搜索词
  refreshPlaylist();

  // ---------- 扫码登录页 ----------
  var qrImg = $("qr-img");
  if (qrImg) {
    var qrcodeKey = null;
    var pollTimer = null;

    function genQr() {
      $("qr-status").textContent = "正在生成二维码…";
      qrImg.hidden = true;
      $("qr-refresh").classList.add("hidden");
      fetch("/api/auth/qrcode", { method: "POST" })
        .then(function (r) { if (!r.ok) throw new Error("fail"); return r.json(); })
        .then(function (d) {
          qrImg.src = d.qrPngDataUrl;
          qrImg.hidden = false;
          $("qr-status").textContent = "请用 B 站 App 扫一扫";
          qrcodeKey = d.qrcodeKey;
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = setInterval(checkPoll, 1500);
        })
        .catch(function () { $("qr-status").textContent = "生成失败，请刷新页面重试"; });
    }

    function checkPoll() {
      // 服务端生成的 key 固定为 32 位十六进制；先校验再拼入同源路径
      if (!qrcodeKey || !/^[0-9a-f]{32}$/.test(qrcodeKey)) return;
      var url = "/api/auth/qrcode/" + qrcodeKey;
      fetch(url)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return;
          if (d.status === "scanned") $("qr-status").textContent = "已扫码，请在手机上确认登录";
          if (d.status === "expired") {
            clearInterval(pollTimer);
            $("qr-status").textContent = "二维码已失效";
            $("qr-refresh").classList.remove("hidden");
          }
          if (d.status === "confirmed") {
            clearInterval(pollTimer);
            $("qr-status").textContent = "登录成功，正在跳转…";
            setTimeout(function () { location.href = "/"; }, 800);
          }
        });
    }

    $("qr-refresh").addEventListener("click", genQr);
    genQr();
  }
  // 登出处理见 export.js（账号相关杂项）
  // ---------- 供外部调用的播放器 API ----------
  window.BiliPlayer = {
    playById: function (id) {
      for (var i = 0; i < playlist.length; i++) {
        if (playlist[i].id === id) { playSongSmart(playlist[i]); return; }
      }
    },
    toggle: function () { $("btn-toggle").click(); },
    skip: skip,
    currentId: function () { return playlist[current] ? playlist[current].id : null; },
    isPlaying: function () { return !!audio.src && !audio.paused; },
    songs: fetchSongs, // v3.js 搜索下拉用
  };

  // ---------- 歌单（每歌单对应收藏夹 bilimusic- <歌单名>） ----------

  function activePlaylistId() {
    return localStorage.getItem("bm_pl") || "0";
  }

  function markActivePlaylist() {
    var active = activePlaylistId();
    var activeName = localStorage.getItem("bm_pl_name") || "全部歌曲";
    document.querySelectorAll("[data-pl]").forEach(function (c) {
      c.classList.toggle("on", String(c.dataset.pl) === active);
    });
    var hid = document.getElementById("collect-playlist-id");
    if (hid) hid.value = active;
    var box = document.querySelector(".collect-box input[name=url]");
    if (box) {
      box.placeholder = "粘贴 B 站视频链接，收藏到「" + activeName + "」…";
    }
    var hint = document.getElementById("songs-filter-hint");
    if (hint) hint.textContent = active === "0" ? "全部歌单 · 按收藏时间" : "歌单「" + activeName + "」 · 按收藏时间";
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
    localStorage.setItem("bm_pl", String(id));
    localStorage.setItem("bm_pl_name", (el && el.dataset.name) || "全部歌曲");
    markActivePlaylist();
    htmx.ajax("GET", "/partials/songs?playlist_id=" + id, {
      target: "#songs",
      swap: "innerHTML",
    });
  };

  window.createPlaylist = async function () {
    var name = prompt("歌单名（将创建同名收藏夹 bilimusic- <歌单名>，总长约 20 字以内）：");
    if (!name || !name.trim()) return;
    var body = new URLSearchParams({ name: name.trim() });
    var resp = await fetch("/web/playlists/create", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    });
    if (!resp.ok) {
      alert((await resp.text()) || "创建失败");
      return;
    }
    htmx.trigger(document.body, "playlistsChanged");
    htmx.ajax("GET", "/partials/playlists", { target: "#playlists-bar", swap: "innerHTML" });
  };

  window.renamePlaylist = async function (id, oldName) {
    var name = prompt("新的歌单名（B 站收藏夹将同步改名）：", oldName);
    if (!name || name === oldName) return;
    var body = new URLSearchParams({ id: id, name: name.trim() });
    var resp = await fetch("/web/playlists/rename", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    });
    if (!resp.ok) {
      alert((await resp.text()) || "改名失败");
      return;
    }
    htmx.trigger(document.body, "playlistsChanged");
    htmx.ajax("GET", "/partials/playlists", { target: "#playlists-bar", swap: "innerHTML" });
  };

  window.deletePlaylist = async function (id, name) {
    if (!confirm("删除歌单「" + name + "」？\n\n· 歌单内的歌曲会移入「我的曲库」（不会丢失）\n· 对应的 B 站收藏夹 bilimusic- " + name + " 将一并删除\n· 歌曲的 B 站收藏会转移到主夹（后台进行）")) return;
    var body = new URLSearchParams({ id: id });
    var resp = await fetch("/web/playlists/delete", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    });
    if (!resp.ok) {
      alert((await resp.text()) || "删除失败");
      return;
    }
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
    $("player-title").textContent = recAudio.dataset.title || "实时流试听";
    $("player-artist").textContent =
      (recAudio.dataset.artist ? recAudio.dataset.artist + " · " : "") + "发现 · 实时流（未入库）";
    if (recAudio.dataset.cover) $("player-cover").src = recAudio.dataset.cover;
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

  window.playRec = function (bvid, btn) {
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
    var card = btn && btn.closest ? btn.closest(".reccard") : null;
    if (card) {
      var nm = card.querySelector(".nm"), ar = card.querySelector(".ar"), im = card.querySelector("img");
      recAudio.dataset.title = nm ? nm.textContent : "实时流试听";
      recAudio.dataset.artist = ar ? ar.textContent : "";
      recAudio.dataset.cover = im ? im.src : "";
    }
    recActive = true;
    document.body.classList.add("trial");
    syncTrialUI();
    recAudio.addEventListener("ended", function () {
      resetRecButtons();
      $("btn-toggle").textContent = "▶";
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
      $("btn-toggle").textContent = "⏸";
      document.body.classList.add("playing");
      syncTrialUI();
    });
    recAudio.addEventListener("pause", function () {
      $("btn-toggle").textContent = "▶";
      if (audioA.paused && audioB.paused) document.body.classList.remove("playing");
    });
    recAudio.play().catch(resetRecButtons);
    setRecBtn(btn, "⏳ 缓冲");
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
