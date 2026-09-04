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
    });
  }

  function playSong(song) {
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
    renderQueue();
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
    var playEl = e.target.closest("[data-play]");
    if (playEl) {
      var ready = playlist.length ? Promise.resolve() : refreshPlaylist();
      ready.then(function () {
        for (var i = 0; i < playlist.length; i++) {
          if (String(playlist[i].id) === playEl.dataset.play) { playSongSmart(playlist[i]); return; }
        }
      });
      return;
    }
    var delEl = e.target.closest("[data-del]");
    if (delEl && confirm("确定从曲库删除这首歌？（本地文件一并删除）")) {
      fetch("/api/songs/" + delEl.dataset.del, { method: "DELETE" })
        .then(function () {
          if (window.htmx) htmx.trigger(document.body, "refreshSongs");
          refreshPlaylist();
        });
    }
  });

  $("btn-toggle").addEventListener("click", function () {
    if (!audio.src) return;
    if (audio.paused) { audio.play().catch(function () {}); } else { audio.pause(); }
  });
  $("btn-prev").addEventListener("click", function () { skip(-1); });
  $("btn-next").addEventListener("click", function () { skip(1); });

  function onPlayPauseUI(e) {
    if (e.target !== audio) return;
    $("btn-toggle").textContent = audio.paused ? "▶" : "⏸";
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
    maybeNatural();
    triggerNatural();
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

  // 搜索框联动：播放队列跟随当前筛选结果
  var search = $("search");
  var searchTimer = null;
  if (search) {
    search.addEventListener("input", function () {
      currentQuery = search.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(refreshPlaylist, 400);
    });
  }

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
})();
