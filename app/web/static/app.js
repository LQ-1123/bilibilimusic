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

  // #45 后续：锁屏/开屏/切应用瞬间的卡顿取证——每次自愈动作记一条到后端日志，
  // 带上元素状态与前后台态，下次复现就有实锤（payload 见 /api/debug/stall）
  function bufAhead(el) {
    var b = el.buffered, at = el.currentTime || 0, ahead = 0;
    for (var i = 0; i < b.length; i++) {
      if (b.start(i) <= at && at <= b.end(i)) { ahead = b.end(i) - at; break; }
    }
    return ahead;
  }
  window.__stallLog = function (phase, tries) {
    try {
      fetch("/api/debug/stall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: phase, tries: tries || 0,
          readyState: audio.readyState, networkState: audio.networkState,
          current: Math.round((audio.currentTime || 0) * 10) / 10,
          duration: Math.round((audio.duration || 0) * 10) / 10,
          bufferedAhead: Math.round(bufAhead(audio) * 10) / 10,
          hidden: document.hidden, tier: netTier(),
          src: (audio.src || "").replace(location.origin, "").slice(0, 90),
        }),
      }).catch(function () {});
    } catch (e) {}
  };

  // #45 卡顿自愈 v2：先软后硬。停住 3 秒先「原地微退 0.25s」逼浏览器重发 Range 请求
  // （后端会重新解析 playurl 换新 CDN 节点，通常 1 秒内接上、几乎无感）；2.5 秒仍停
  // 才整段重开（重解析 + 新连接，会断 1-2 秒）。冷却 15s、重开上限 5 次、playing 复位不变。
  (function () {
    var cooldownAt = 0, tries = 0, timer = null, phase = 0; // phase: 0=待软推 1=已软推待硬重开
    function stalled() {
      return !audio.paused && audio.readyState < 3;
    }
    function recover() {
      if (!stalled()) { phase = 0; return; }
      var now = Date.now();
      if (now - cooldownAt < 15000 || tries >= 5) return;
      if (phase === 0) {
        cooldownAt = now;
        phase = 1;
        window.__stallLog("nudge", tries);
        try {
          var at = audio.currentTime || 0;
          audio.currentTime = at < 0.3 ? at + 0.05 : Math.max(0, at - 0.25); // 起播段前挪，其余后推
        } catch (e) {}
        timer = setTimeout(recover, 2500);   // 还停着 → 升级硬重开
        return;
      }
      phase = 0;
      tries += 1;
      window.__stallLog("reopen", tries);
      if (tries === 2) {
        // v2.1 A6 弱网降档：第二次硬重开就换 64K 原地重开（保进度），10 分钟窗口后自然回升
        window.__weakNetNow();
        try { audio.src = withTier(audio.src); } catch (e) {}
      }
      var pos = audio.currentTime || 0;
      var onMeta = function () {
        audio.removeEventListener("loadedmetadata", onMeta);
        try {
          if (pos > 1 && isFinite(audio.duration) && pos < audio.duration - 1) audio.currentTime = pos;
        } catch (e) {}
        resumeGraph(); // 重开后 ctx 若被 WebView 挂起，声音照样出不来——先推醒再 play
        audio.play().catch(function () {});
      };
      audio.addEventListener("loadedmetadata", onMeta);
      try { audio.load(); } catch (e) {}
    }
    function arm() {
      clearTimeout(timer);
      timer = setTimeout(recover, 3000);
    }
    [audioA, audioB].forEach(function (el) {
      el.addEventListener("waiting", arm);
      el.addEventListener("stalled", arm);
      el.addEventListener("error", function () {
        // 元素级故障软推救不了：直接走硬重开
        clearTimeout(timer);
        phase = 1;
        recover();
      });
      el.addEventListener("playing", function () {
        clearTimeout(timer); tries = 0; phase = 0;
      });
    });
  })();

  // v2.3 音质策略：设置里可显式选档（bmQuality：best/192/132/64，v3.js cycleQuality 写入）。
  // 选了档就用它——弱网自愈也不再降档（用户已表态）。自动（默认）＝每首都取当前可用的
  // 最高档（Hi-Res/杜比随会员权益下发），仅卡顿自愈第二次硬重开时临时 64K 保命，
  // 10 分钟窗口后自然回升。（v2.1 的蜂窝自动降 192K 已移除：那是「音质糊」反馈的来源之一，
  // 省流量请显式选 192K 档。）
  var weakNetUntil = 0;
  function netTier() {
    var pref = lsGet("bmQuality");
    if (pref === "best" || pref === "192" || pref === "132" || pref === "64") return pref;
    if (Date.now() < weakNetUntil) return "64";
    return "best";
  }
  function withTier(src) {
    if (!src) return src;
    var t = netTier();
    if (/(?:[?&])tier=[^&]*/.test(src)) return src.replace(/([?&])tier=[^&]*/, "$1tier=" + t);
    return src + (src.indexOf("?") >= 0 ? "&" : "?") + "tier=" + t;
  }
  // 音质档位切换后立即生效：正在放的歌原地换 src（保进度续播），并重探测档位标签。
  // 主队列在放（非镜像态）优先；推荐试听在放时同样换档。
  window.__qualityApply = function () {
    var song = playlist[current];
    if (song && audio.src && !mirror) {
      var el = audio, pos = audio.currentTime || 0, wasPaused = audio.paused;
      var onMeta = function () {
        el.removeEventListener("loadedmetadata", onMeta);
        try {
          if (pos > 1 && isFinite(el.duration) && pos < el.duration - 1) el.currentTime = pos;
        } catch (e) {}
        if (!wasPaused) { resumeGraph(); el.play().catch(function () {}); }
      };
      el.addEventListener("loadedmetadata", onMeta);
      el.src = withTier(song.audioUrl);
      window.__qualityProbe(song.bvid, song.cid);
      return;
    }
    if (recAudio && recAudio.src && !recAudio.paused && recAudio.dataset.bvid) {
      var rp = recAudio.currentTime || 0;
      var onMeta2 = function () {
        recAudio.removeEventListener("loadedmetadata", onMeta2);
        try {
          if (rp > 1 && isFinite(recAudio.duration) && rp < recAudio.duration - 1) recAudio.currentTime = rp;
        } catch (e) {}
        recAudio.play().catch(function () {});
      };
      recAudio.addEventListener("loadedmetadata", onMeta2);
      recAudio.src = withTier("/api/stream/" + recAudio.dataset.bvid);
    }
  };
  window.__weakNetNow = function () { weakNetUntil = Date.now() + 10 * 60 * 1000; };
  // 档位标签：起播后探测实际选中的档位，播放条歌手位显示「歌手 · Hi-Res」（零提示文化：不弹胶囊）
  var qualityLabelNow = "";
  window.__qualityProbe = function (bvid, cid) {
    qualityLabelNow = "";
    if (!bvid) return;
    fetch("/api/stream/" + bvid + "/quality?tier=" + netTier() + (cid ? "&cid=" + cid : ""), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.qualityLabel) qualityLabelNow = d.qualityLabel; })
      .catch(function () {});
  };
  window.__qualityLabel = function () { return qualityLabelNow; };
  // 播放页进度条下方的档位小字：本地/试听随探测结果出现（v3.js 轮询驱动）；
  // 镜像态声音在对面，本机探测值不代表远端档位，清空不显示
  window.__paintLyQuality = function () {
    var el = document.getElementById("ly-quality");
    if (!el) return;
    var q = mirror ? "" : qualityLabelNow;
    if (el.textContent !== q) el.textContent = q;
  };

  // v2.1 A5 漫游电台：队列面板 ∞ 开关（或详情页「电台」按钮）打开后，队列见底
  // 自动按当前歌为种子从推荐池续歌（试听流，不落盘）；跳过电台歌＝出池负反馈。
  var radioPlayed = [];
  function radioOn() {
    try { return localStorage.getItem("bmRadio") === "1"; } catch (e) { return false; }
  }
  function radioSeedBvid() {
    if (recActive && recAudio && recAudio.dataset.bvid) return recAudio.dataset.bvid;
    var s = playlist[current];
    return s && s.bvid ? s.bvid : null;
  }
  function radioAppend(done) {
    var seed = radioSeedBvid();
    if (!radioOn() || !seed) { done(false); return; }
    fetch("/api/radio/next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seedBvid: seed, exclude: radioPlayed.slice(-30) }),
    })
      .then(function (r) { return r.ok ? r.json() : { songs: [] }; })
      .then(function (d) {
        var q = window.__trialQueue;
        if (!q || !q.items) { q = window.__trialQueue = { items: [], i: -1 }; }
        var added = 0;
        (d.songs || []).forEach(function (s) {
          if (!s.bvid) return;
          radioPlayed.push(s.bvid);
          q.items.push({ bvid: s.bvid, title: s.title, artist: s.artist, cover: s.coverUrl, radio: true });
          added += 1;
        });
        if (added && (queueMode() || drawerOpen())) renderQueue();
        done(added > 0);
      })
      .catch(function () { done(false); });
  }
  function radioContinue(fallbackStop) {
    radioAppend(function (got) {
      var q = window.__trialQueue;
      var nxt = (got && q && q.items) ? q.items[q.i + 1] : null;
      if (nxt) { q.i = q.i + 1; window.playStream(nxt.bvid, nxt, null); return; }
      if (fallbackStop) fallbackStop();
    });
  }
  function radioDismiss(bvid) {
    if (!bvid) return;
    fetch("/api/recs/" + bvid, { method: "DELETE" }).catch(function () {});
  }

  var audioCtx = null, gains = null; // gains: {audioA: GainNode, audioB: GainNode}
  var transitionState = null;        // 进行中的过渡 {mainEl, timer}
  var naturalPlan = null;            // 自然播放结束前的预规划
  var analysisCache = {};            // songId -> TrackAnalysis
  var analysisPending = {};
  // v2.2 A4 音量均衡 + gapless：normState 是当前曲的均衡状态（测量/落库都挂在它上面），
  // preload 是 gapless 的「已预载的下一首」（ended 时若无条件成立则弃用，走原切歌路径）
  var normState = null;
  var preload = null;
  var GAPLESS_AHEAD = 7;             // 距结尾多少秒开始预载下一首

  // ---------- 歌词状态 ----------
  var lyricLines = [];    // [{t: 秒（-1 = 无轴行）, text}]
  var lyricTimed = false; // 是否带时间轴（无轴则静态展示不滚动）
  var lyricSongId = null; // 当前歌词对应的歌（防切歌竞态）
  var lyricIdx = -1;      // 当前高亮行索引

  // ---------- 播放器 ----------
  var playlist = []; // [{id,title,artist,qualityLabel,audioUrl,coverUrl,duration}]
  var current = -1;
  var albumQueueId = null;
  var queueGeneration = 0;
  var refreshGeneration = 0;
  var currentQuery = ""; // 播放队列跟随当前搜索筛选

  // 播放顺序 = 自动决策链：按过渡得分把队列贪心排序（智能过渡关闭时 = 原顺序）
  var chainOrder = [];      // songId 序列，起点为当前歌
  var queueDisplayItems = []; // 队列面板当前展示的曲目（与 data-idx 对应）

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderQueue() {
    // v2.1 队列双壳：手机=播放页内视图（#queue-view），桌面=右侧栏抽屉（#q-drawer）。
    // 两壳共用同一份 partial，渲染写进所有 [data-qlist] 容器，事件全部委托。
    var mains = document.querySelectorAll('[data-qlist="main"]');
    if (!mains.length) return;
    var trialQ = window.__trialQueue;
    var trialItems = (recActive && trialQ && trialQ.items && trialQ.items.length) ? trialQ.items : null;
    var trialIdx = trialItems && trialQ.i >= 0 ? trialQ.i : -1;
    // v2.2 主列表＝一整个队列：已播放（压暗）/ 正在播放（粉字＋脉动）/ 待播，段位连着排，
    // 当前曲目不再单独拎出来——这样上一首、下一首的关系一眼可见。
    var entries, curIdx = -1, radioItems = [];
    if (trialItems) {
      entries = trialItems.filter(function (it) { return !it.radio; });
      radioItems = trialItems.filter(function (it) { return it.radio; });
      curIdx = entries.indexOf(trialItems[trialIdx]); // 当前项本身是电台歌时不进主列表（落在下面 ∞ 分区）
    } else {
      entries = playlist.slice();
      curIdx = current;
    }
    queueDisplayItems = entries; // data-idx 直接对应整张队列
    function _qEq() {
      return '<span class="q-eq" role="img" aria-label="正在播放"><span class="eq"><i></i><i></i><i></i></span></span>';
    }
    var mainHtml = entries.map(function (s, i) {
      var cls = i === curIdx ? "q-now" : (curIdx >= 0 && i < curIdx ? "q-done" : "");
      return "<li" + (cls ? ' class="' + cls + '"' : "") + " data-idx=\"" + i + "\" style=\"--qi:" + Math.min(i, 12) + "\" title=\"" + escapeHtml(s.title) + "\">" +
        _qRowCover(s) +
        '<div class="q-meta"><div class="q-t1">' + escapeHtml(s.title) + "</div>" +
        '<div class="q-t2">' + escapeHtml(s.artist || "") + "</div></div>" +
        (i === curIdx ? _qEq() : '<span class="q-dur">' + fmt(s.duration) + "</span>" + _qRowMore()) + "</li>";
    }).join("") || (trialItems ? "" : '<li class="q-empty">播放列表为空</li>');
    var radioHtml = radioItems.map(function (it, i) {
      var isNow = !!trialItems && it === trialItems[trialIdx];
      return '<li' + (isNow ? ' class="q-now"' : "") + ' data-radio="' + i + '" style="--qi:' + Math.min(i, 12) + '" title="' + escapeHtml(it.title) + '">' +
        _qRowCover(it) +
        '<div class="q-meta"><div class="q-t1">' + escapeHtml(it.title) + "</div>" +
        '<div class="q-t2">' + escapeHtml(it.artist || "") + "</div></div>" + (isNow ? _qEq() : _qRowMore()) + "</li>";
    }).join("");
    document.querySelectorAll('[data-qlist="main"]').forEach(function (el) { el.innerHTML = mainHtml; });
    document.querySelectorAll('[data-qlist="radio"]').forEach(function (el) { el.innerHTML = radioHtml; });
    document.querySelectorAll('[data-qsec="next"]').forEach(function (el) {
      el.hidden = !entries.length;
      var s = el.querySelector('[data-qsrc="next"]');
      if (s) s.textContent = !entries.length ? ""
        : (curIdx >= 0 ? "正在播放第 " + (curIdx + 1) + " 首 · 共 " + entries.length + " 首" : "共 " + entries.length + " 首");
    });
    document.querySelectorAll('[data-qsec="radio"]').forEach(function (el) { el.hidden = !radioItems.length; });
    closeQueueMenu(); // 行 DOM 换过一遍，菜单的锚点已失效
    syncQueuePills();
  }
  function _qRowMore() { // 行「···」：静止时不占视线，悬停/触屏常显（对齐 Apple Music 队列行的形态）
    return '<button class="q-more" type="button" data-qmore aria-label="更多操作">···</button>';
  }
  function _qRowCover(song) { // 行封面（用户定稿：接受低密度，行必须带封面）
    var c = song.coverUrl || song.cover || "";
    return c
      ? '<img class="q-cvr" src="' + escapeHtml(c) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : '<span class="q-cvr q-cvr-none"></span>';
  }

  // 三个胶囊＝三条互相独立的轴：随机（开/关）· 循环（关 → 列表 → 单曲）· ∞ 电台（开/关）。
  // 任意组合都成立：随机＋列表循环＝打乱后环绕；随机＋不循环＝打乱后放完即止。
  function syncQueuePills() {
    var loop = loopMode(), shuf = shuffleOn(), radio = radioOn();
    document.querySelectorAll('[data-qpill]').forEach(function (btn) {
      var kind = btn.dataset.qpill, on;
      if (kind === "shuffle") {
        on = shuf;
        btn.title = on ? "随机播放：开（点按恢复原顺序）" : "随机播放：关（点按打乱播放顺序）";
      } else if (kind === "loop") {
        on = loop !== "off";
        btn.title = loop === "one" ? "循环：单曲（点按关闭循环）"
          : (loop === "all" ? "循环：整个列表（点按切到单曲）" : "循环：关（点按开启列表循环）");
        btn.classList.toggle("one", loop === "one");
      } else if (kind === "radio") {
        on = radio;
        btn.title = on ? "漫游电台：开（队列播完自动续播）" : "漫游电台：关（点按开启，队列播完自动续播）";
      } else return;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    if (window.__syncLyMode) window.__syncLyMode(); // 歌词页的循环钮与这里同源
  }

  // 队列展示顺序 = 自动决策链（智能过渡关闭时 = 原顺序）
  function queueDisplay() {
    if (albumQueueId !== null || !smartEnabled() || !chainOrder.length) return playlist.slice();
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
    // 随机开启：顺序由固定种子决定（与当前歌无关，切歌不重排）；专辑队列不参与随机
    if (albumQueueId === null && shuffleOn()) {
      chainOrder = shuffleChainIds();
      renderQueue();
      return;
    }
    if (albumQueueId !== null || !smartEnabled()) {
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

  // ---------- 播放三轴：随机 / 循环 / 电台，各自独立，可任意组合 ----------
  // 旧版把「随机」和「循环」塞进同一个 bmPlayMode 枚举（order|loop|random），二者天生互斥；
  // 现在拆成 bmShuffle(0/1) × bmLoop(off|all|one) × bmRadio(0/1)，首次运行做一次性迁移。
  var shuffleSeed = (Math.random() * 0xffffffff) >>> 0;
  var shuffleIds = null, shuffleIdsKey = "";
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function shuffleOn() { return lsGet("bmShuffle") === "1"; }
  function loopMode() { var v = lsGet("bmLoop"); return (v === "all" || v === "one") ? v : "off"; }
  function setShuffleOn(on) {
    lsSet("bmShuffle", on ? "1" : "0");
    if (on) { shuffleSeed = (Math.random() * 0xffffffff) >>> 0; shuffleIds = null; } // 每次开启＝重掷一套新顺序
  }
  function setLoopMode(v) { lsSet("bmLoop", (v === "all" || v === "one") ? v : "off"); }
  (function migratePlayMode() { // 只在两个新键都还没写过时跑一次
    if (lsGet("bmShuffle") !== null || lsGet("bmLoop") !== null) return;
    var old = lsGet("bmPlayMode");
    if (old === null && lsGet("bmRepeatOne") === null) return;
    if (lsGet("bmRepeatOne") === "1") lsSet("bmLoop", "one");
    else lsSet("bmLoop", old === "loop" ? "all" : "off");
    lsSet("bmShuffle", old === "random" ? "1" : "0");
  })();

  // 随机顺序：种子固定 + 队列指纹固定 → 同一份顺序反复取用，切歌不重排。
  // 当前歌排头，这样「不循环」也能把整队正好放完一次。
  function shuffleChainIds() {
    var ids = playlist.map(function (s) { return s.id; });
    var key = shuffleSeed + "|" + ids.join(",");
    if (shuffleIds && shuffleIdsKey === key) return shuffleIds.slice();
    var seed = shuffleSeed >>> 0;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    for (var i = ids.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    }
    var curId = playlist[current] ? playlist[current].id : null;
    var at = curId === null ? -1 : ids.indexOf(curId);
    if (at > 0) { ids.splice(at, 1); ids.unshift(curId); }
    shuffleIds = ids; shuffleIdsKey = key;
    return shuffleIds.slice();
  }

  // 链上的上/下一首；loop=all 才环绕（专辑队列永远不环绕），到队尾/队首返回 -1
  function chainNextIndex(dir) {
    if (!chainOrder.length || !playlist.length) return -1;
    var wrap = loopMode() === "all" && albumQueueId === null;
    var curId = playlist[current] ? playlist[current].id : null;
    var pos = chainOrder.indexOf(curId);
    if (pos === -1) pos = 0;
    var next = pos + dir;
    if (next >= chainOrder.length) {
      if (wrap) next = 0;
      else return -1;
    }
    if (next < 0) {
      if (wrap) next = chainOrder.length - 1;
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
    var cards = document.querySelectorAll("#songs .card, #dt-songs .card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle("playing", cards[i].dataset.play === String(songId));
    }
  }
  // 播放标记只在播放动作时打；随后打开详情页 / htmx 重排会把行整批重渲染丢掉 .playing。
  // 监听歌曲容器的 DOM 变化统一补打（去抖 60ms），新渲染路径无需逐处记得调 markPlayingCard。
  var markTimer = 0;
  new MutationObserver(function () {
    if (markTimer) return;
    markTimer = setTimeout(function () {
      markTimer = 0;
      markPlayingCard(playlist[current] ? playlist[current].id : null);
    }, 60);
  }).observe(document.body, { childList: true, subtree: true });

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

  function orderedAlbumSongs(data) {
    return (data.songs || []).slice().sort(function (a, b) { return a.trackNo - b.trackNo; });
  }

  async function albumRequest(id, materialize) {
    var response = await fetch("/api/albums/" + encodeURIComponent(id) + (materialize ? "/materialize" : "/songs"),
      { method: materialize ? "POST" : "GET", cache: "no-store" });
    if (!response.ok) { var error = new Error("专辑加载失败，请重试"); error.status = response.status; throw error; }
    return response.json();
  }

  async function playAlbum(id, startSongId) {
    var generation = ++queueGeneration;
    try {
      var data = await albumRequest(id, false);
      while (data.hasMore) {
        if (generation !== queueGeneration) return;
        var previous = data.materializedPages;
        data = await albumRequest(id, true);
        if (data.hasMore && data.materializedPages === previous) throw new Error("专辑曲目加载未完成，请重试");
      }
      if (generation !== queueGeneration) return;
      var songs = orderedAlbumSongs(data);
      var selected = startSongId == null ? songs[0] : songs.find(function (song) { return String(song.id) === String(startSongId); });
      if (!selected) throw new Error("这首曲目已移除，或专辑暂无可播放曲目");
      albumQueueId = String(id);
      playlist = songs;
      current = -1;
      playSong(selected);
    } catch (error) {
      if (generation === queueGeneration && window.__toast) window.__toast(error.message);
    }
  }

  async function refreshPlaylist() {
    var generation = queueGeneration, request = ++refreshGeneration, albumId = albumQueueId;
    var songs;
    try { songs = albumId === null ? await fetchSongs(currentQuery) : orderedAlbumSongs(await albumRequest(albumId, false)); }
    catch (error) {
      if (error.status !== 404) return;
      songs = [];
    }
    if (generation !== queueGeneration || request !== refreshGeneration || albumId !== albumQueueId) return;
    var playingId = current >= 0 && playlist[current] ? playlist[current].id : null;
    playlist = songs;
    current = playlist.findIndex(function (song) { return song.id === playingId; });
    if (albumId !== null && playingId !== null && current < 0) { audio.pause(); cancelTransition(); naturalPlan = null; }
    planChain();
    if (!sessionRestored) { sessionRestored = true; restoreSession(); planChain(); }
  }

  /** 点歌入口（#29 第二轮）：串流态（别的设备在放）下点歌＝把这首推给在放的那台，本机不出声也不抢会话；
   *  对面没接（离线/没会话）才回退成本机播放。 */
  function playSong(song) {
    if (mirror && window.__sessionSync && window.__sessionSync.playOnRemote) {
      var idx = -1;
      for (var i = 0; i < playlist.length; i++) { if (playlist[i].id === song.id) { idx = i; break; } }
      if (idx >= 0) {
        var sent = window.__sessionSync.playOnRemote(window.BiliPlayer.queue(), idx, 0);
        if (sent) { sent.then(function (ok) { if (!ok) playLocalSong(song); }); return; }
      }
    }
    playLocalSong(song);
  }

  function playLocalSong(song) {
    exitMirror();   // 本机开始放歌 = 自己接管会话，播放条立刻回到本地态
    stopTrial();
    cancelTransition();
    naturalPlan = null;
    // #29 第二轮：跨端来的「试听队列」每条 songId 都是 0（未收藏的歌没有曲库 id），
    // 原来按 `s.id === song.id` 找下标会把 current 定到**最后一条** → 放的就不是点的那首。
    // 改成先按对象本体（引用）定位，再退化到「非 0 的 id」匹配。
    var at = playlist.indexOf(song);
    if (at < 0) {
      for (var si = 0; si < playlist.length; si++) {
        if (playlist[si].id && playlist[si].id === song.id) { at = si; break; }
      }
    }
    if (at >= 0) current = at;
    ensureGraph();
    setGain(audioA, audioA === audio ? 1 : 0);
    setGain(audioB, audioB === audio ? 1 : 0);
    resumeGraph();
    cancelPreload();
    normPrepare(audio, song); // 均衡增益在 src 设置后立刻生效（置 1 或已知响度的对齐值）
    statBegin(audio, song, song.title, song.artist);
    audio.src = withTier(song.audioUrl);
    window.__qualityProbe(song.bvid, song.cid);
    audio.play().catch(function () {});
    updateNowPlaying(song);
    if (smartEnabled()) prefetchAnalyses();
    planChain(); // 以新歌为起点重排自动决策链
  }

  // #23：跨端队列项 → 本机播放条目（接收端自己向后端取流，B 站按视频+分 P 路由）
  function buildQueue(items) {
    return (items || []).map(function (it) {
      return {
        id: it.songId || 0, bvid: it.bvid, cid: it.cid || 0,
        title: it.title || "", artist: it.artist || "",
        qualityLabel: "在线", coverUrl: it.coverUrl || "", duration: it.duration || 0,
        audioUrl: "/api/stream/" + encodeURIComponent(it.bvid) + (it.cid ? "?cid=" + it.cid : ""),
      };
    }).filter(function (x) { return !!x.bvid; });
  }

  function updateNowPlaying(song) {
    $("player-bar").classList.remove("hidden");
    if (!mirror) paintLocalBar(song);   // 镜像态由远端会话驱动播放条，本地只更新状态
    syncMediaMetadata(song.title, song.artist, song.coverUrl);
    markPlayingCard(song.id);
    saveSession();
    renderQueue();
    if (!$("lyrics-panel").classList.contains("hidden")) loadLyrics(libLyricsMeta(song)); // 面板开着：切歌即刷新
  }

  /** 本地态播放条的 DOM 绘制（镜像态走 BiliBarMirror.paint，两者互斥）。 */
  function paintLocalBar(song) {
    $("player-cover").src = song.coverUrl;
    var pt = $("player-title");
    pt.textContent = song.title;
    pt.title = song.title; // 截断时悬停看全文（#12）
    if (window.BiliTicker) BiliTicker.set(pt); // 超宽标题窗口内滚动（#13）
    $("player-artist").textContent = song.artist + " · " + (window.__qualityLabel() || song.qualityLabel || "");
    // 切歌即重置进度显示（否则上一首的粉色填充/时间码会遗留到新歌开头）
    var seekEl = $("seek");
    if (seekEl) {
      seekEl.value = 0;
      syncSeekFill();
    }
    $("t-cur").textContent = "0:00";
    $("t-dur").textContent = "0:00";
  }

  function syncMediaMetadata(title, artist, cover) {
    // 后端 song_out 在本地封面时返回相对路径（/api/songs/{id}/cover?...），
    // 原生 new URL(相对路径) 会抛 MalformedURLException 被吞掉 —— 先转绝对地址再传桥。
    var abs = cover || "";
    try { if (cover) abs = new URL(cover, location.origin).href; } catch (e) {}
    try { if (window.BiliMusicNative && BiliMusicNative.playbackStarted) BiliMusicNative.playbackStarted(title || "", artist || "", abs); } catch (e) {}
    if ("mediaSession" in navigator) {
      try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: artist,
        album: "BiliMusic",
        artwork: abs ? [{ src: abs }] : []
      });
      } catch (e) {}
      try { navigator.mediaSession.setActionHandler("previoustrack", function () { skip(-1); }); } catch (e) {}
      try { navigator.mediaSession.setActionHandler("nexttrack", function () { skip(1); }); } catch (e) {}
    }
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
    // 镜像态（#29 第二轮）：切歌作用在「在放的那台」上，本机不接管
    if (mirror && window.__sessionSync && window.__sessionSync.remoteCommand) {
      window.__sessionSync.remoteCommand(delta < 0 ? "prev" : "next");
      return;
    }
    // 试听态：在同列表组成的试听队列内切换（推荐/搜索/UP 页的歌）
    var q = window.__trialQueue;
    if (recActive && recAudio && q && q.items && q.items.length && window.playStream) {
      var cur = q.items[q.i];
      if (cur && cur.radio) radioDismiss(cur.bvid); // 跳过电台歌＝负反馈出池
      var ti = q.i + delta;
      if (ti < 0) ti = q.items.length - 1;
      if (ti >= q.items.length && radioOn()) {
        radioContinue(function () {});
        return;
      }
      if (ti >= q.items.length) ti = 0;
      q.i = ti;
      window.playStream(q.items[ti].bvid, q.items[ti], null);
      return;
    }
    stopTrial();
    naturalPlan = null;
    var ni = chainNextIndex(delta);
    if (ni < 0) {
      // v2.1 A5：曲库队列放完且电台开着 → 以最后一首为种子续电台（试听流接管）
      if (delta === 1 && radioOn() && playlist[current] && playlist[current].bvid) {
        radioContinue(function () {
          if (window.BiliMusicNative && BiliMusicNative.playbackStopped) BiliMusicNative.playbackStopped();
          try { audio.pause(); } catch (e) {}
        });
        return;
      }
      if (delta === 1) { if (window.BiliMusicNative && BiliMusicNative.playbackStopped) BiliMusicNative.playbackStopped(); try { audio.pause(); } catch (e) {} } // 顺序模式到队尾：停
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
    // #37：合集容器里的「收藏 / 移出曲库」——只动本地 collected 标记，不动 B 站收藏（视频级）
    var collectEl = e.target.closest("[data-collect]");
    if (collectEl) {
      var collectRow = collectEl.closest("[data-play]");
      collectEl.disabled = true;
      fetch("/api/songs/" + collectEl.dataset.collect + "/collect", { method: "POST" })
        .then(function (r) {
          if (!r.ok) throw new Error("collect failed");
          if (window.htmx) htmx.trigger(document.body, "refreshSongs");
          htmx.trigger(document.body, "playlistsChanged"); // 侧栏歌单计数/最近收藏刷新（#37）
          refreshPlaylist();
          var albumId = collectRow && collectRow.dataset && collectRow.dataset.album;
          if (albumId) {
            return fetch("/partials/album-tracks?album_id=" + albumId, { cache: "no-store" })
              .then(function (resp) { return resp.text(); })
              .then(function (html) { document.getElementById("dt-songs").innerHTML = html; });
          }
        })
        .catch(function () { collectEl.disabled = false; if (window.__toast) window.__toast("收藏失败，请重试"); });
      return; // 不穿透到整行播放
    }
    var uncollectEl = e.target.closest("[data-uncollect]");
    if (uncollectEl) {
      uncollectEl.disabled = true;
      fetch("/api/songs/" + uncollectEl.dataset.uncollect + "/uncollect", { method: "POST" })
        .then(function (r) {
          if (!r.ok) throw new Error("uncollect failed");
          if (window.htmx) htmx.trigger(document.body, "refreshSongs");
          htmx.trigger(document.body, "playlistsChanged"); // 侧栏歌单计数刷新（#37）
          refreshPlaylist();
          var albumId2 = (uncollectEl.closest("[data-play]") || {}).dataset;
          albumId2 = albumId2 && albumId2.album;
          if (albumId2) {
            return fetch("/partials/album-tracks?album_id=" + albumId2, { cache: "no-store" })
              .then(function (resp) { return resp.text(); })
              .then(function (html) { document.getElementById("dt-songs").innerHTML = html; });
          }
        })
        .catch(function () { uncollectEl.disabled = false; if (window.__toast) window.__toast("移出失败，请重试"); });
      return;
    }
    var delEl = e.target.closest("[data-del]");
    if (delEl) {
      var deletedRow = delEl.closest("[data-play]");
      if (deletedRow) deletedRow.hidden = true;
      var albumId = deletedRow && deletedRow.dataset && deletedRow.dataset.album;
      if (albumId) {
        // 专辑内移除单曲：仅本地删除，不动 B 站收藏（其余分 P 共用该视频收藏）
        fetch("/api/albums/" + albumId + "/songs/" + delEl.dataset.del, { method: "DELETE" })
          .then(function (response) {
            if (!response.ok) throw new Error("remove failed");
            if (window.htmx) htmx.trigger(document.body, "refreshSongs");
            return fetch("/partials/album-tracks?album_id=" + albumId, { cache: "no-store" })
              .then(function (r) { return r.text(); })
              .then(function (html) { document.getElementById("dt-songs").innerHTML = html; });
          }).catch(function () {
            if (deletedRow) deletedRow.hidden = false;
            if (window.__toast) window.__toast("移除失败，请重试");
          });
        return;
      }
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
      if (playEl.dataset.album) { playAlbum(playEl.dataset.album, playEl.dataset.play); return; }
      var wasAlbum = albumQueueId !== null;
      albumQueueId = null; ++queueGeneration;
      var want = playEl.dataset.play, gen = queueGeneration;
      // 曲库/队列点歌＝只播这首、队列不动（findSong 只认 id）。此前这里看到 song.albumId
      // 就 playAlbum 整张接管队列——合集单曲被收藏进曲库后一点播，原队列就被合集顶掉。
      // 「从这首播整张」只属于专辑/合集详情行的显式入口（上面 data-album 分支）。
      var playFound = function () {
        var hit = window.BiliPlayRoute.findSong(playlist, want);
        if (hit) { playSongSmart(hit); return true; }
        return false;
      };
      var ready = playlist.length && !wasAlbum ? Promise.resolve() : refreshPlaylist();
      ready.then(function () {
        if (playFound()) return;
        // #29 第二轮：跨端接管后本机 playlist 换成了对面的队列（试听队列 songId 全是 0），
        // 曲库卡片的 id 在里面匹配不到 → 点了没反应。这里补一次「拉本机曲库再找」。
        if (gen !== queueGeneration) return;
        refreshPlaylist().then(function () {
          if (gen !== queueGeneration) return;
          playFound();
        });
      });
    }
  });

  $("btn-toggle").addEventListener("click", function () {
    if (mirror) {   // 镜像态：中键 = 遥控对面播放/暂停（要换设备＝把播放条往上拖）
      if (window.__sessionSync) window.__sessionSync.barAction();
      return;
    }
    if (recActive && recAudio) { // 发现池试听接管胶囊
      if (recAudio.paused || recAudio.ended) { recAudio.play().catch(function () {}); }
      else { recAudio.pause(); }
      return;
    }
    if (!audio.src) return;
    if (audio.paused) { audio.play().catch(function () {}); } else { audio.pause(); }
  });
  $("btn-prev").addEventListener("click", function () {
    if (mirror) { window.__sessionSync && window.__sessionSync.remoteCommand("prev"); return; }
    skip(-1);
  });
  $("btn-next").addEventListener("click", function () {
    if (mirror) { window.__sessionSync && window.__sessionSync.remoteCommand("next"); return; }
    skip(1);
  });

  function setPlayerToggle(paused) {
    var button = $("btn-toggle");
    if (!mirror) {   // 镜像态中键由 BiliBarMirror.paint 负责（显示对面那台的播放状态）
      button.querySelector("use").setAttribute("href", paused ? "#a-play" : "#a-pause");
      button.title = paused ? "播放" : "暂停";
      button.setAttribute("aria-label", button.title);
    }
    // 壳层通知的播放/暂停图标跟随（#3 第一段）
    try { if (window.BiliMusicNative && BiliMusicNative.playbackPaused) BiliMusicNative.playbackPaused(!!paused); } catch (e) {}
  }
  function onPlayPauseUI(e) {
    if (e.target !== audio) return;
    setPlayerToggle(audio.paused);
    if (audio.paused) saveSession();
  }
  function onEnded(e) {
    if (e.target !== audio) return;
    statFlush(5); // 自然播完 = 一次完整收听（短歌也认），先落账再切下一首
    if (loopMode() === "one" && albumQueueId === null) {
      audio.currentTime = 0;
      audio.play().catch(function () {});
      return;
    }
    var i = chainNextIndex(1);
    var nx = i >= 0 ? playlist[i] : null;
    // gapless：预载就绪且队列没变 → 换轨零等待；否则走原切歌路径
    if (nx && !mirror && !recActive && window.BiliNorm &&
        window.BiliNorm.preloadUsable(preload, i, nx, netTier()) && preload.el !== audio) {
      activatePreloaded(i, nx);
      return;
    }
    cancelPreload();
    if (i >= 0) { playSong(playlist[i]); return; }
    // 队列放完：电台开着就按当前歌续播（∞ 的语义就是「播完不停」），否则停
    if (radioOn() && playlist[current] && playlist[current].bvid) {
      radioContinue(function () {
        if (window.BiliMusicNative && BiliMusicNative.playbackStopped) BiliMusicNative.playbackStopped();
        try { audio.pause(); } catch (err) {}
      });
      return;
    }
    if (window.BiliMusicNative && BiliMusicNative.playbackStopped) BiliMusicNative.playbackStopped();
    audio.pause();
  }
  function onTimeUpdate(e) {
    if (e.target !== audio) return;
    if (!mirror && audio.duration && !seekDragging) {   // 镜像态：播放条归远端会话驱动
      seek.value = Math.round((audio.currentTime / audio.duration) * 1000);
      syncSeekFill();
      $("t-cur").textContent = fmt(audio.currentTime);
      $("t-dur").textContent = fmt(audio.duration);
    }
    // 进度推给壳层媒体通知（1s 节流，#3）
    try {
      var now = Date.now();
      if (!onTimeUpdate.lastPush || now - onTimeUpdate.lastPush >= 1000) {
        onTimeUpdate.lastPush = now;
        if (window.BiliMusicNative && BiliMusicNative.playbackProgress) {
          BiliMusicNative.playbackProgress(audio.currentTime || 0, audio.duration || 0);
        }
      }
    } catch (e) {}
    if (Date.now() - lastPositionSave > 3000) {
      lastPositionSave = Date.now();
      saveSession();
    }
    maybeNatural();
    triggerNatural();
    normTick();      // A4 音量均衡：抽帧测响度（250ms 节流在函数内）
    statTick();      // B6 听歌统计：累计有效收听时长
    maybePreload();  // A4 gapless：结尾前预载下一首
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
    var dur = mirror ? mirrorDuration() : audio.duration;
    if (dur) {
      $("t-cur").textContent = fmt((seek.value / 1000) * dur);
    }
  });
  seek.addEventListener("change", function () {
    cancelPreload(); // 用户重定位了进度：预载的「下一首」时点已不可信
    if (mirror) {
      // 镜像态：拖动进度 = 让在放的那台设备跳过去
      var mdur = mirrorDuration();
      if (mdur && window.__sessionSync) window.__sessionSync.remoteSeek((seek.value / 1000) * mdur);
    } else if (audio.duration) {
      audio.currentTime = (seek.value / 1000) * audio.duration;
    }
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
      [audioA, audioB].forEach(wireGraph);
      gains[audioA.id].gain.value = 1;
      gains[audioB.id].gain.value = 0;
    } catch (e) {
      audioCtx = null; // Web Audio 不可用 → 全部路径自然降级为硬切
    }
  }
  function wireGraph(el) {
    var src = audioCtx.createMediaElementSource(el);
    var g = audioCtx.createGain();
    if (audioCtx.createAnalyser) {
      var an = audioCtx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      an.connect(g);
      el.__analyser = an; // A4 响度测量在这抽帧（增益前，测的是原始响度）
    } else {
      src.connect(g);
    }
    g.connect(audioCtx.destination);
    gains[el.id] = g;
  }
  // 试听/电台流（recAudio）不在常驻双轨里，起播时挂进同一张图（挂不上就裸放）
  function normAttach(el) {
    if (!audioCtx || el.__normGain || !window.BiliNorm) return;
    try {
      var src = audioCtx.createMediaElementSource(el);
      var g = audioCtx.createGain();
      if (audioCtx.createAnalyser) {
        var an = audioCtx.createAnalyser();
        an.fftSize = 2048;
        src.connect(an);
        an.connect(g);
        el.__analyser = an;
      } else {
        src.connect(g);
      }
      g.connect(audioCtx.destination);
      el.__normGain = g;
    } catch (e) {}
  }

  // ---------- v2.2 A4 音量均衡：起播对齐 + 在线实测 + 跨设备共享 ----------
  function normOn() { return lsGet("bmNorm") !== "0"; }
  function gainNodeFor(el) { return (gains && gains[el.id]) || el.__normGain || null; }
  function setElGain(el, v) {
    var g = gainNodeFor(el);
    if (!g) return;
    try { g.gain.cancelScheduledValues(0); } catch (e) {}
    g.gain.value = v;
  }
  function glideGain(el, v) {
    if (!audioCtx) { setElGain(el, v); return; }
    var g = gainNodeFor(el);
    if (!g) return;
    try { g.gain.setTargetAtTime(v, audioCtx.currentTime, 0.2); } catch (e) { g.gain.value = v; }
  }
  function loudMap() {
    try { return JSON.parse(lsGet("bmLoud") || "{}") || {}; } catch (e) { return {}; }
  }
  function loudLookup(key) {
    var hit = loudMap()[key];
    return hit && typeof hit.db === "number" ? hit.db : null;
  }
  function loudStore(key, db) {
    var m = loudMap();
    m[key] = { db: Math.round(db * 10) / 10, at: Date.now() };
    var keys = Object.keys(m);
    if (keys.length > 500) { // 上限 500 首，按学习时间淘汰最旧的
      keys.sort(function (a, b) { return m[a].at - m[b].at; });
      for (var i = 0; i < keys.length - 500; i++) delete m[keys[i]];
    }
    lsSet("bmLoud", JSON.stringify(m));
  }
  /** 切歌/预载激活时调用：已知响度起播即对齐；未知先 1，边放边测（normTick）。 */
  function normPrepare(el, song) {
    normState = null;
    if (!window.BiliNorm || !song || !song.bvid) { setElGain(el, 1); return; }
    if (!normOn()) { setElGain(el, 1); return; }
    var key = song.bvid + ":" + (song.cid || 0);
    var known = loudLookup(key);
    setElGain(el, window.BiliNorm.gainFor(known));
    var meter = el.__analyser
      ? new window.BiliNorm.LoudnessMeter(el.__analyser.context.sampleRate)
      : null;
    normState = { el: el, key: key, song: song, meter: meter, knownDb: known, applied: known != null, saved: known != null };
    if (known == null) fetchLoudness(song, key);
  }
  function fetchLoudness(song, key) {
    fetch("/api/loudness?bvid=" + encodeURIComponent(song.bvid) + "&cid=" + (song.cid || 0))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || d.db == null || !normState || normState.key !== key) return;
        loudStore(key, d.db);
        if (!normState.applied) { // 服务端学过而本机没学过：播放中平滑对齐
          normState.applied = true;
          normState.knownDb = d.db;
          glideGain(normState.el, window.BiliNorm.gainFor(d.db));
        }
      })
      .catch(function () {});
  }
  function saveLoudnessRemote(song, db, duration) {
    fetch("/api/loudness", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bvid: song.bvid, cid: song.cid || 0, db: Math.round(db * 10) / 10, duration: duration || 0 }),
    }).catch(function () {});
  }
  var normLastTick = 0, normBuf = null;
  function normTick() {
    if (!normState || !normOn() || !window.BiliNorm) return;
    if (normState.el !== audio && normState.el !== recAudio) return;
    var an = normState.el.__analyser;
    if (!an || !an.getFloatTimeDomainData || !normState.meter) return;
    var now = Date.now();
    var dt = normLastTick ? Math.min(2, (now - normLastTick) / 1000) : 0; // 暂停/切后台的时间不计
    normLastTick = now;
    if (!normBuf || normBuf.length !== an.fftSize) normBuf = new Float32Array(an.fftSize);
    try { an.getFloatTimeDomainData(normBuf); } catch (e) { return; }
    normState.meter.push(normBuf, dt);
    if (!normState.applied && normState.meter.confident()) { // 本机首听：估出来就对齐
      var est = normState.meter.estimate();
      if (est != null) {
        normState.applied = true;
        normState.knownDb = est;
        glideGain(normState.el, window.BiliNorm.gainFor(est));
      }
    }
    if (!normState.saved && normState.knownDb != null && normState.meter.savable()) {
      normState.saved = true; // 门内听满 20s 才算学完：跳过的歌不污染统计
      loudStore(normState.key, normState.knownDb);
      saveLoudnessRemote(normState.song, normState.knownDb, normState.el.duration);
    }
  }
  window.toggleNorm = function () {
    var turningOn = !normOn();
    lsSet("bmNorm", turningOn ? "1" : "0");
    if (turningOn) {
      var cur = playlist[current];
      if (audio.src && cur) normPrepare(audio, cur);
      else if (recActive && recAudio) { normAttach(recAudio); normPrepare(recAudio, { bvid: recAudio.dataset.bvid, cid: 0 }); }
    } else {
      normState = null;
      if (gains) { setElGain(audioA, audioA === audio ? 1 : 0); setElGain(audioB, audioB === audio ? 1 : 0); }
    }
    paintNormRow();
  };
  function paintNormRow() {
    var on = normOn();
    var label = $("acct-norm-label");
    if (label) label.textContent = "音量均衡 · " + (on ? "开" : "关");
    document.querySelectorAll(".norm-switch-input").forEach(function (el) { el.checked = on; });
  }
  paintNormRow();
  function applyNormSetting(on) {
    lsSet("bmNorm", on ? "1" : "0");
    if (on) {
      var cur = playlist[current];
      if (audio.src && cur) normPrepare(audio, cur);
      else if (recActive && recAudio) { normAttach(recAudio); normPrepare(recAudio, { bvid: recAudio.dataset.bvid, cid: 0 }); }
    } else {
      normState = null;
      if (gains) { setElGain(audioA, audioA === audio ? 1 : 0); setElGain(audioB, audioB === audio ? 1 : 0); }
    }
    paintNormRow();
  }
  window.toggleNorm = function () { applyNormSetting(!normOn()); };
  document.querySelectorAll(".norm-switch-input").forEach(function (el) {
    el.addEventListener("change", function () { applyNormSetting(el.checked); });
  });

  // ---------- #45 后续：Android 电池白名单（ROM 后台省电是锁屏断流的最后一块） ----------
  function paintBatteryRow() {
    var row = $("acct-battery");
    if (!row || !window.BiliMusicNative || !BiliMusicNative.batteryOptimized) return;
    try { row.classList.toggle("hidden", !BiliMusicNative.batteryOptimized()); } catch (e) {}
  }
  paintBatteryRow();
  document.addEventListener("visibilitychange", function () { if (!document.hidden) paintBatteryRow(); });
  window.requestBatteryWhitelist = function () {
    try { if (window.BiliMusicNative) BiliMusicNative.requestIgnoreBatteryOptimization(); } catch (e) {}
  };

  // ---------- T1 轻缓存：只有一行状态 + 一键清空（无管理界面） ----------
  // 听歌统计与缓存行联动刷新（验收反馈②：别让数字停在旧值）：落账/清缓存/回前台/
  // 账号 Tab 点开/播放中每 30s 都会刷一次；stats 卡片经 bm-stats 事件由 htmx 重拉。
  // B6 听歌统计桌面入口改为侧边栏独立视图（/partials/stats-view），弹窗版已移除。
  function refreshStatsUI() {
    if (window.htmx) htmx.trigger(document.body, "bm-stats");
    refreshCacheRow();
  }
  function refreshCacheRow() {
    fetch("/api/cache/stats")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        var mb = d.bytes / 1048576;
        var text = "听歌缓存 · " + d.count + " 首 · " + (mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + " MB";
        document.querySelectorAll(".cache-label").forEach(function (label) { label.textContent = text; });
      })
      .catch(function () {});
  }
  refreshCacheRow();
  setInterval(function () {
    if (document.hidden) return;
    var playing = (audio && !audio.paused) || (recAudio && !recAudio.paused);
    if (playing) refreshStatsUI();
  }, 30000);
  document.addEventListener("click", function (e) {
    var tab = e.target.closest && e.target.closest(".m-tab");
    if (tab && tab.dataset && tab.dataset.mtab === "account") setTimeout(refreshStatsUI, 300);
  });
  // 播放历史页（最常听/最近播放）点歌：优先在当前队列里找同一首（队列不动），
  // 曲库/队列里没有就走实时流试听（推荐/搜索同一套路），绝不展开改队列。
  document.addEventListener("click", function (e) {
    var row = e.target.closest && e.target.closest("#view-stats li[data-bvid]");
    if (!row) return;
    var bvid = row.dataset.bvid, cid = Number(row.dataset.cid) || 0;
    if (!bvid) return;
    for (var i = 0; i < playlist.length; i++) {
      if (playlist[i].bvid === bvid && (!cid || !playlist[i].cid || Number(playlist[i].cid) === cid)) {
        playSongSmart(playlist[i]);
        return;
      }
    }
    if (window.playStream) window.playStream(bvid, {
      title: row.dataset.title || "", artist: row.dataset.artist || "",
      cover: row.dataset.cover || "", cid: cid,
    }, null);
  });
  window.clearListenCache = function () {
    window.__confirmModal("清空听歌缓存？", "只删本机缓存的音乐文件，不影响曲库、歌单与 B 站收藏。")
      .then(function (ok) {
        if (!ok) return;
        fetch("/api/cache/clear", { method: "POST" })
          .then(function () { refreshStatsUI(); if (window.__toast) window.__toast("听歌缓存已清空"); })
          .catch(function () {});
      });
  };

  // ---------- B6 听歌统计：一次收听一行，落账点在切歌/播完/停试听/关页 ----------
  // 分钟统计用完整真实收听秒数；跳过（<30s）不计，自然播完哪怕不足 30s 也算听完。
  var statState = null, statLast = 0;
  function statKey(bvid, cid, title) { return (bvid || "") + ":" + (cid || 0) + ":" + (title || ""); }
  function statBegin(el, song, title, artist) {
    statFlush();
    statState = {
      el: el,
      key: statKey(song && song.bvid, song && song.cid, title),
      bvid: (song && song.bvid) || "",
      cid: (song && song.cid) || 0,
      title: title || "",
      artist: artist || "",
      duration: Math.round((song && song.duration) || 0),
      cover: (song && song.coverUrl) || "",  // v2.3 播放历史行级封面（随流水落账）
      listened: 0,
    };
    statLast = 0;
  }
  function statTick() {
    if (!statState) return;
    var el = statState.el;
    if (!el || el.paused) { statLast = 0; return; }
    var now = Date.now();
    var dt = statLast ? Math.min(2, (now - statLast) / 1000) : 0; // 暂停/切后台不计
    statLast = now;
    statState.listened += dt;
  }
  function statPost(data, keepalive) {
    fetch("/api/stats/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      keepalive: !!keepalive,
    }).then(function () { refreshStatsUI(); }).catch(function () {});
  }
  function statFlush(minListened) {
    if (!statState) return;
    var s = statState;
    statState = null;
    if (!s.title || s.listened < (minListened || 30)) return; // 跳过不算听
    statPost({
      bvid: s.bvid, cid: s.cid, title: s.title, artist: s.artist,
      duration: s.duration, listened: Math.round(s.listened), cover: s.cover || "",
    });
  }
  // 兜底：会话恢复/壳层直接 play() 不经过 playSong——play 事件上认歌，歌没变就续记
  function statEnsure() {
    var song = playlist[current] || null;
    var title = song ? song.title : "";
    if (statState && statState.el === audio && statState.key === statKey(song && song.bvid, song && song.cid, title)) return;
    if (song) statBegin(audio, song, song.title, song.artist);
  }
  [audioA, audioB].forEach(function (el) {
    el.addEventListener("play", function () {
      if (el === audio && !recActive) statEnsure();
    });
  });
  window.addEventListener("pagehide", function () {
    if (statState && statState.title && statState.listened >= 30) {
      statPost({
        bvid: statState.bvid, cid: statState.cid, title: statState.title, artist: statState.artist,
        duration: statState.duration, listened: Math.round(statState.listened), cover: statState.cover || "",
      }, true);
    }
  });

  // ---------- v2.2 A4 gapless：结尾前预载下一首，ended 即换轨零等待 ----------
  function cancelPreload() { preload = null; }
  function maybePreload() {
    if (mirror || recActive || loopMode() === "one" || transitionState) { cancelPreload(); return; }
    if (!audio.duration || !isFinite(audio.duration)) return;
    var remaining = audio.duration - audio.currentTime;
    if (remaining > GAPLESS_AHEAD || remaining <= 0.8) {
      if (preload && preload.from === audio) cancelPreload(); // 拖回去了：预载作废
      return;
    }
    var ni = chainNextIndex(1);
    var nx = ni >= 0 ? playlist[ni] : null;
    if (nx && window.BiliNorm && window.BiliNorm.preloadUsable(preload, ni, nx, netTier())) return;
    if (!nx || !nx.audioUrl) return; // 队列尽头：电台续播要现拉推荐，不预载
    cancelPreload();
    var el = audio === audioA ? audioB : audioA;
    el.src = withTier(nx.audioUrl);
    el.load();
    preload = { el: el, idx: ni, song: nx, tier: netTier(), from: audio };
  }
  /** ended 时预载仍成立 → 换轨起播（复用 playLocalSong 的收尾，但不重设 src）。 */
  function activatePreloaded(i, nx) {
    var oldEl = audio;
    audio = preload.el;
    preload = null;
    try { oldEl.pause(); } catch (err) {}
    setElGain(oldEl, 0);
    normPrepare(audio, nx);
    statBegin(audio, nx, nx.title, nx.artist);
    window.__qualityProbe(nx.bvid, nx.cid);
    var p = audio.play();
    if (p && p.catch) p.catch(function () {});
    updateNowPlaying(nx);
    planChain();
    saveSession();
  }

  function resumeGraph() {
    if (audioCtx && audioCtx.state === "suspended") {
      try {
        var p = audioCtx.resume();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    }
  }
  // WebView 切后台/锁屏可能挂起 AudioContext：媒体元素以为在放，routed 音频却停摆——
  // 锁屏/切应用瞬卡的头号嫌疑。回前台可见与每个播放事件都推一把 resume。
  document.addEventListener("visibilitychange", function () { if (!document.hidden) resumeGraph(); });
  [audioA, audioB].forEach(function (el) {
    el.addEventListener("play", resumeGraph);
    el.addEventListener("playing", resumeGraph);
  });
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
    nextEl.src = withTier(nextSong.audioUrl);
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
    if (naturalPlan || !smartEnabled() || loopMode() === "one" || transitionState) return;
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
  // 队列行「···」菜单：从行取曲目 → 悬停按钮旁弹出一张小卡（外观复用 .pm-item，与 #song-menu 同族）。
  // 菜单自己一份 DOM（#q-menu），不和 #song-menu 共用——那边是按「当前播放的歌」取数据的。
  var qMenu = $("q-menu");
  var qMenuItem = null;
  function closeQueueMenu() {
    if (qMenu) qMenu.hidden = true;
    qMenuItem = null;
  }
  function openQueueMenu(anchor) {
    if (!qMenu) return;
    var item = rowSong(anchor.closest("li"));
    if (!item) return;
    var trial = !item.id; // 无曲库 id = 试听/电台行：不进「从队列移除」，改走不感兴趣
    var items = trial
      ? ['<button type="button" class="pm-item" data-qact="dismiss">不感兴趣</button>']
      : ['<button type="button" class="pm-item" data-qact="remove">从队列移除</button>'];
    items.push('<button type="button" class="pm-item" data-qact="pl">加入歌单</button>');
    items.push('<button type="button" class="pm-item" data-qact="bili">在 B 站打开</button>');
    qMenu.innerHTML = items.join("");
    qMenu.hidden = false;
    qMenuItem = item;
    var r = anchor.getBoundingClientRect();
    var mh = qMenu.offsetHeight, mw = qMenu.offsetWidth;
    qMenu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + "px";
    qMenu.style.top = (r.top - mh - 8 > 8 ? r.top - mh - 8 : r.bottom + 8) + "px";
  }
  // 主列表 [data-idx] 走 queueDisplayItems；电台列表 [data-radio] 走 __trialQueue 的 radio 子集
  function rowSong(li) {
    if (!li) return null;
    if (li.hasAttribute("data-radio")) {
      var rq = window.__trialQueue;
      if (!rq || !rq.items) return null;
      var rItems = rq.items.filter(function (it) { return it.radio; });
      return rItems[Number(li.getAttribute("data-radio"))] || null;
    }
    var idx = Number(li.getAttribute("data-idx"));
    return isFinite(idx) ? (queueDisplayItems[idx] || null) : null;
  }
  // 从队列移除：试听队列改 items 并修正游标；曲库队列删歌后重排决策链
  function removeQueueItem(song) {
    var q = window.__trialQueue;
    var at = q && q.items ? q.items.indexOf(song) : -1;
    if (at >= 0) {
      q.items.splice(at, 1);
      if (q.i > at) q.i -= 1;
      else if (q.i === at) q.i = Math.min(at, q.items.length - 1);
      renderQueue();
      return;
    }
    var pi = playlist.indexOf(song);
    if (pi < 0) return;
    playlist.splice(pi, 1);
    if (pi < current) current -= 1;
    planChain();
    if (window.__toast) window.__toast("已从队列移除");
  }
  // 清除：只清「后面待播的」，正在放的这首留着（与 Apple Music 继续播放的清除同语义）
  function clearUpcoming() {
    var q = window.__trialQueue;
    if (q && q.items && q.items.length) {
      var keep = q.i >= 0 ? q.items[q.i] : null;
      q.items = keep ? [keep] : [];
      q.i = keep ? 0 : -1;
    }
    if (playlist.length) {
      var cur = playlist[current] || null;
      playlist = cur ? [cur] : [];
      current = cur ? 0 : -1;
    }
    planChain();
    renderQueue();
    if (window.__toast) window.__toast("已清空待播曲目");
  }

  // v2.1 队列双壳（手机=播放页内视图 / 桌面=右侧栏抽屉）。胶囊与行点击全部事件委托，
  // 同一份逻辑同时服务两个壳里的 [data-qpill] / [data-qlist]。
  document.addEventListener("click", function (e) {
    // 「···」菜单：点菜单外或再点一次按钮即收（放在最前，避免又被下面的行点击吃掉）
    if (qMenu && !qMenu.hidden && !e.target.closest("#q-menu") && !e.target.closest("[data-qmore]")) closeQueueMenu();
    var qAct = e.target.closest("[data-qact]");
    if (qAct && qMenuItem) {
      var act = qAct.getAttribute("data-qact");
      var item = qMenuItem;
      closeQueueMenu();
      if (act === "bili") { if (item.bvid) window.open("https://www.bilibili.com/video/" + item.bvid, "_blank"); return; }
      if (act === "remove") { removeQueueItem(item); return; }
      if (act === "dismiss") {
        radioDismiss(item.bvid);
        removeQueueItem(item);
        if (window.__toast) window.__toast("已减少这类推荐");
        return;
      }
      if (act === "pl" && window.__openPlMenu) {
        var rect = qAct.getBoundingClientRect();
        if (item.id) window.__openPlMenu(rect, "song", { song: item.id });
        else if (item.bvid) window.__openPlMenu(rect, "url", { bvid: item.bvid, url: "https://www.bilibili.com/video/" + item.bvid });
      }
      return;
    }
    var moreBtn = e.target.closest("[data-qmore]");
    if (moreBtn) { openQueueMenu(moreBtn); return; }
    if (e.target.closest("[data-qclear]")) { clearUpcoming(); return; }
    if (e.target.closest(".q-now")) return; // 正在播放行：点它不做事（免得又起播一遍）
    var pill = e.target.closest("[data-qpill]");
    if (pill) {
      var kind = pill.dataset.qpill;
      if (kind === "shuffle") setShuffleOn(!shuffleOn());
      else if (kind === "loop") { var lm = loopMode(); setLoopMode(lm === "off" ? "all" : (lm === "all" ? "one" : "off")); }
      else if (kind === "radio") lsSet("bmRadio", radioOn() ? "0" : "1");
      planChain();       // 随机＝换一套顺序；循环＝队尾是否环绕。都要重算链
      syncQueuePills();
      return;
    }
    var radioRow = e.target.closest('li[data-radio]');
    if (radioRow && window.playStream) {
      var rq = window.__trialQueue;
      var rItem = rowSong(radioRow);
      if (!rq || !rq.items || !rItem) return;
      rq.i = rq.items.indexOf(rItem);
      window.playStream(rItem.bvid, rItem, null);
      return;
    }
    var row = e.target.closest("li[data-idx]");
    if (!row) return;
    var song = rowSong(row);
    if (!song) return;
    if (song.id) { playSongSmart(song); return; } // 曲库行
    // 试听/电台行（无曲库 id，playSongSmart 会静默无效）：起实时流并同步队列下标
    if (song.bvid && window.playStream) {
      var q = window.__trialQueue;
      if (q && q.items) {
        var fi = q.items.indexOf(song);
        if (fi >= 0) q.i = fi;
      }
      window.playStream(song.bvid, song, null);
    }
  });

  // 桌面抽屉（#q-drawer）：主界面保留，右侧滑出。播放条队列钮 / 歌词页底行队列钮 / Esc / 返回栈共用。
  var qDrawer = $("q-drawer");
  var qEnterTimer = 0;
  function drawerOpen() { return !!qDrawer && document.body.classList.contains("qside-open"); }
  window.__toggleQueueDrawer = function (force) {
    if (!qDrawer) return;
    var to = typeof force === "boolean" ? force : !drawerOpen();
    if (!to) closeQueueMenu();
    // 开合状态只挂在 body 上：右栏靠 CSS 的 translateX + visibility 过渡进出（display 切不出动画）
    document.body.classList.toggle("qside-open", to);
    // 镜像一个标记类：back-stack.js 靠 MutationObserver 盯 #q-drawer 的 class 变化来压/出栈，
    // 状态本体在 body 上（CSS 用它驱动位移与让位），这里只是把信号喂给观察者
    qDrawer.classList.toggle("is-open", to);
    clearTimeout(qEnterTimer);
    if (to) {
      renderQueue();
      // 打开时把「正在播放」那行滚进视野（长队列不必自己翻）
      var nowRow = document.querySelector('#q-drawer .q-now');
      if (nowRow && nowRow.scrollIntoView) nowRow.scrollIntoView({ block: "center" });
      document.body.classList.add("qside-enter"); // 清单错峰入场，只在开栏这一下
      qEnterTimer = setTimeout(function () { document.body.classList.remove("qside-enter"); }, 700);
    } else {
      document.body.classList.remove("qside-enter");
    }
    // 抽屉开合会收起/放出播放条的歌曲信息：让走马灯按新的可用宽度重测一次
    if (window.BiliTicker) window.BiliTicker.set($("player-title"));
  };
  var qdClose = $("q-drawer-close");
  if (qdClose) qdClose.addEventListener("click", function () { window.__toggleQueueDrawer(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (qMenu && !qMenu.hidden) { closeQueueMenu(); return; } // 先收行菜单，再收抽屉
    if (drawerOpen()) window.__toggleQueueDrawer(false);
  });
  window.__isDesktop = function () { return window.matchMedia("(min-width: 901px)").matches; };
  window.__syncQueuePills = syncQueuePills; // 详情页「电台」按钮打开电台后同步胶囊态
  // 播放页的随机 / 循环钮与队列胶囊共用同一套轴语义：换顺序、重排链、同步各处状态都收在这里
  window.__togglePlayAxis = function (kind) {
    if (kind === "shuffle") setShuffleOn(!shuffleOn());
    else if (kind === "loop") { var lm = loopMode(); setLoopMode(lm === "off" ? "all" : (lm === "all" ? "one" : "off")); }
    else return;
    planChain();       // 随机＝换一套顺序；循环＝队尾是否环绕。都要重算链
    syncQueuePills();
  };

  // v2.1 队列视图（手机）：住在歌词面板里的第二个视图（歌词 ⇄ 播放列表）。
  var queueViewEl = $("queue-view");
  function queueMode() { return !!queueViewEl && !queueViewEl.hidden; }
  window.__setQueueView = function (toQueue) {
    if (toQueue === false) { if (window.__goCoverView) window.__goCoverView(null); return; } // 队列返回 = 播放页
    if (window.__goQueueView) window.__goQueueView(); // 队列态再按 = 回播放页（goQueue 内部翻转）
  };
  window.__renderQueueView = renderQueue; // v3.js goQueue 刷新列表用
  $("btn-queue").addEventListener("click", function () {
    if (window.__isDesktop()) { window.__toggleQueueDrawer(); return; } // 桌面：右侧栏抽屉
    if (window.__toggleQueueView) window.__toggleQueueView();            // 手机：播放页内视图
  });
  window.__resetQueueView = function () { // 歌词页关闭时由 v3.js 钩子调用：复位视图状态
    if (!queueViewEl) return;
    queueViewEl.hidden = true;
    var ls = $("lyrics-scroll");
    if (ls) ls.hidden = false;
    $("lyrics-panel").classList.remove("queue-mode");
  };

  // ---------- 歌词面板（B站字幕 + LRCLIB 混合，后端返回 LRC/纯文本） ----------
  var NOTE_RE = /[♪♫♩♬]/g; // 歌词行装饰符号（LRCLIB/AI 字幕常见），展示前剥掉
  // 作词/作曲/编曲等元数据行：老库里可能已经存进去了，展示前再剥一道（BUG-007）
  var META_RE = /^(作词|作曲|作詞|编曲|編曲|制作人|製作人|混音|母带|母帶|录音|錄音|监制|監製|出品|OP|SP|词|曲|lyrics?|composer|arranger?|producer|mixed\s*by|written\s*by)\s*[:：]/i;

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
      if (body && META_RE.test(body)) return; // 元数据行不当歌词
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
    if (window.BiliLearning) window.BiliLearning.decorate();
  }

  // 点击歌词行跳转到该行时间（曲库歌与试听流都支持；无轴歌词不响应）
  $("lyrics-scroll").addEventListener("click", function (e) {
    var line = e.target.closest(".l-line");
    if (!line) return;
    if (window.BiliLearning) window.BiliLearning.select(Number(line.dataset.idx));
    if (!lyricTimed) return;
    var l = lyricLines[Number(line.dataset.idx)];
    if (!l || l.t < 0) return;
    var m = (recActive && recAudio) ? recAudio : audio;
    if (!m) return;
    try { m.currentTime = l.t; } catch (err) {}
    updateLyricHighlight(l.t, true);
  });
  window.__learningSeek = function (time) {
    if (mirror || !Number.isFinite(time) || time < 0) return false;
    var media = (recActive && recAudio) ? recAudio : audio;
    if (!media || !media.src) return false;
    try { media.currentTime = time; return true; } catch (err) { return false; }
  };
  window.__learningDuration = function () {
    var media = (recActive && recAudio) ? recAudio : audio;
    return media && Number.isFinite(media.duration) ? media.duration : 0;
  };

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
    if (t2) {
      t2.textContent = title;
      t2.title = title;
      if (window.BiliTicker) BiliTicker.set(t2); // 播放页大歌名超长也走马灯
    }
    $("lyrics-artist").textContent = artist;
    var ba = $("ly-artist-big");
    if (ba) ba.textContent = artist;
  }

  function loadLyrics(meta) {
    // meta: {key, title, artist, cover, fetchUrl, fetchInit} — key 区分库内歌 / 试听歌
    currentLyricsMeta = meta;
    lyricSongId = meta.key;
    lyricLines = []; lyricTimed = false; lyricIdx = -1;
    if (window.BiliLearning) window.BiliLearning.loading(meta);
    setLyricsText(meta.title, meta.artist);
    var sourceEl = $("lyrics-source");
    if (sourceEl) { sourceEl.hidden = true; sourceEl.textContent = ""; }
    setLyricsCover(meta.cover);
    var posEl = $("ly-pos");
    if (posEl) {
      var p = meta.pos;
      if (p && p.total > 1) { posEl.textContent = p.index + " / " + p.total; posEl.hidden = false; }
      else { posEl.hidden = true; posEl.textContent = ""; }
    }
    $("lyrics-scroll").innerHTML = '<div class="l-empty">歌词加载中…</div>';
    fetch(meta.fetchUrl, meta.fetchInit)
      .then(function (r) {
        if (!r.ok) throw new Error("lyrics-request-failed");
        return r.json();
      })
      .then(function (d) {
        if (lyricSongId !== meta.key) return; // 请求期间已切歌
        var parsed = parseLrc(d.lyrics);
        if (sourceEl && d.source) {
          var sourceNames = { cc: "B站字幕", ai: "B站AI字幕", lrclib: "LRCLIB", ncm: "网易云" };
          sourceEl.textContent = "来源 · " + (sourceNames[d.source] || d.source);
          sourceEl.hidden = false;
        }
        lyricLines = parsed.lines;
        lyricTimed = parsed.timed;
        lyricIdx = -1;
        renderLyrics();
        if (window.BiliLearning) window.BiliLearning.setLyrics(meta, lyricLines, lyricTimed);
        var now = meta.isTrial && recAudio ? recAudio.currentTime : (audio.currentTime || 0);
        updateLyricHighlight(now, true);
      })
      .catch(function () {
        if (lyricSongId !== meta.key) return;
        var action = String(meta.key).indexOf("lib:") === 0
          ? ' <button type="button" class="ly-retry-inline">重试</button>' : "";
        $("lyrics-scroll").innerHTML = '<div class="l-empty l-error">歌词加载失败' + action + '</div>';
        if (window.BiliLearning) window.BiliLearning.error();
        var retry = $("lyrics-scroll").querySelector(".ly-retry-inline");
        if (retry) retry.addEventListener("click", retryLyrics);
      });
  }
  function retryLyrics() {
    if (!lyricSongId || String(lyricSongId).indexOf("lib:") !== 0) return;
    var id = String(lyricSongId).slice(4);
    loadLyrics(Object.assign({}, currentLyricsMeta || {}, { key: lyricSongId, fetchUrl: "/api/songs/" + id + "/lyrics?force=1" }));
  }
  var currentLyricsMeta = null;

  // 跟随播放进度滚动高亮：线性指针小步推进，拖进度条大跳时重扫
  function updateLyricHighlight(now, force) {
    if (!lyricTimed || !lyricLines.length) return;
    var panel = $("lyrics-panel");
    if (panel.classList.contains("hidden")) return; // 面板收起时不做滚动
    var idx = lyricIdx < 0 || lyricIdx >= lyricLines.length ? 0 : lyricIdx;
    if (force || lyricLines[idx].t > now) idx = 0;
    while (idx + 1 < lyricLines.length && lyricLines[idx + 1].t <= now) idx++;
    while (idx > 0 && lyricLines[idx].t > now) idx--;
    if (window.BiliLearning) window.BiliLearning.time(now, idx);
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
      pos: window.BiliPlayer ? window.BiliPlayer.position() : null,
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
    openLyricsForCurrent();
  };

  /** 歌曲详情页（播放页/歌词页）当前该显示哪首：镜像态＝远端在放的那首（#29 第二轮：
   *  串流时点进详情页必须同步，本机 audio 不动）；否则＝本机当前曲目/试听流。 */
  function mirrorLyricsMeta() {
    var m = window.BiliBarMirror && BiliBarMirror.song ? BiliBarMirror.song() : null;
    if (!m || !m.bvid) return null;
    return {
      key: "mirror:" + m.bvid,
      title: m.title || "远端曲目", artist: m.artist || "", cover: m.coverUrl || "",
      isMirror: true,
      fetchUrl: "/api/lyrics/preview",
      fetchInit: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bvid: m.bvid, title: m.title || "", artist: m.artist || "",
                               duration: Math.round(m.duration || 0) }),
      },
    };
  }
  function openLyricsForCurrent() {
    if (mirror) {                                  // 串流中：详情页跟着远端那首
      var mm = mirrorLyricsMeta();
      if (mm) {
        var live = BiliBarMirror.live ? BiliBarMirror.live() : null;
        setLyricsCover(mm.cover);
        if (lyricSongId === mm.key && lyricLines.length) updateLyricHighlight(live ? live.position : 0, true);
        else loadLyrics(mm);
        return;
      }
    }
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
      if (window.BiliLearning) window.BiliLearning.setLyrics({ key: "none" }, [], false);
      renderLyrics();
    }
  }
  /** 镜像态进出 / 换歌时，详情页开着就跟过去（BiliBarMirror 里调）。 */
  window.__lyricsRefresh = function () {
    var panel = $("lyrics-panel");
    if (!panel || panel.classList.contains("hidden")) return;
    openLyricsForCurrent();
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

  // ---------- 二维码点按保存：已按用户要求砍掉（2026-09-17） ----------
  // 手机/桌面都只保留系统级「长按/右键 → 保存图片」这一种方式，无任何自动行为。

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
  var smsGo = $("sms-go"); // 短信登录已下线（v1.0.1）：DOM 不存在时这段不执行
  if (smsGo) smsGo.addEventListener("click", function () {});

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

  // ---------- #27 镜像播放条：别的设备在放时，本机播放条显示「它在放什么」 ----------
  // 详见 docs/issue-ledger.md §7。规则：中键=⇢ 串流到本设备；⏮/⏭/进度/音量都作用于在放的那台设备。
  var mirror = null;        // {song, deviceName, playing, volume, pos, at}
  var mirrorTimer = 0;
  var lastMirrorSongKey = "";   // 上一次绘制时远端那首的指纹：换歌要联动歌词页（#29 第二轮）
  var localVol = null;      // 进入镜像前的本机音量（退出时还原到音量条）

  function exitMirror() {
    if (mirror) window.BiliBarMirror.off();
  }
  function mirrorPosition() {
    if (!mirror) return 0;
    var pos = mirror.pos;
    if (mirror.playing) pos += (Date.now() - mirror.at) / 1000;
    return Math.max(0, pos);
  }
  function mirrorDuration() {
    return Number(mirror && mirror.song && mirror.song.duration) || 0;
  }
  /** 退出镜像：播放条还原本机曲目（本机没有曲目就收起）。 */
  function restoreLocalBar() {
    var song = playlist[current];
    var bar = $("player-bar");
    if (!song || !audio.src) { bar.classList.add("hidden"); setPlayerToggle(true); return; }
    paintLocalBar(song);
    if (audio.duration) {
      seek.value = Math.round((audio.currentTime / audio.duration) * 1000);
      syncSeekFill();
      $("t-cur").textContent = fmt(audio.currentTime);
      $("t-dur").textContent = fmt(audio.duration);
    }
    setPlayerToggle(audio.paused);
    var vol = $("vol");
    if (vol && localVol != null) { vol.value = localVol; vol.style.setProperty("--p", vol.value + "%"); }
    localVol = null;
  }

  window.BiliBarMirror = {
    isOn: function () { return !!mirror; },
    /** 进入/刷新镜像态：每次远端快照进来都调一次（重新对时，进度不漂）。 */
    on: function (session) {
      if (!session || !session.song || !session.song.bvid) return;
      var first = !mirror;
      if (first) {
        localVol = $("vol") ? $("vol").value : null;
        $("player-bar").classList.add("mirror");
      }
      var action = mirror && mirror.action;
      mirror = {
        song: { bvid: session.song.bvid, title: session.song.title || "", artist: session.song.artist || "",
                coverUrl: session.song.coverUrl || "", duration: Number(session.song.duration) || 0 },
        deviceName: session.activeDeviceName || "其他设备",
        playing: !!session.playing,
        volume: Number(session.volume),
        pos: Number(session.position) || 0,
        at: Date.now(),
        action: action || "transfer",
      };
      $("player-bar").classList.remove("hidden");
      this.setAction(mirror.action);
      this.paint();
      if (first) mirrorTimer = setInterval(function () { window.BiliBarMirror.paint(); }, 500);
      if (first) window.__lyricsRefresh && window.__lyricsRefresh();   // 刚进镜像：歌词页若开着就换成远端那首
    },
    off: function () {
      if (!mirror) return;
      mirror = null;
      lastMirrorSongKey = "";
      if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = 0; }
      $("player-bar").classList.remove("mirror");
      restoreLocalBar();
      window.__lyricsRefresh && window.__lyricsRefresh();   // 回到本机：歌词页跟着换回本机那首
    },
    /** 远端正在放的那首（歌词/详情页在镜像态要用）。 */
    song: function () { return mirror ? mirror.song : null; },
    deviceName: function () { return mirror ? mirror.deviceName : ""; },
    /** 镜像态的实时进度（含本地补时），供歌词页/详情页跟随。 */
    live: function () {
      if (!mirror) return null;
      return { position: mirrorPosition(), duration: mirrorDuration(), playing: !!mirror.playing };
    },
    /** 中键两种语义（#29）：toggle=遥控对面播放/暂停（长按弹串流浮层）；resume=点一下继续播放。 */
    setAction: function (mode) {
      if (mirror) mirror.action = mode;
      this.paint();
    },
    paint: function () {
      if (!mirror) return;
      var song = mirror.song;
      var pos = mirrorPosition(), dur = mirrorDuration();
      var cover = $("player-cover");
      if (cover.getAttribute("src") !== (song.coverUrl || "")) cover.src = song.coverUrl || "";
      var pt = $("player-title");
      if (pt.textContent !== song.title) {
        pt.textContent = song.title;
        pt.title = song.title;
        if (window.BiliTicker) BiliTicker.set(pt);
      }
      // #29 第二轮：up 主位不再被「在 X 上播放」顶掉（点了还会跳到 up 主页，语义错位）。
      // 串流中改用播放条的粉色光晕（.mirror 的溜边光）表示；设备名只留在 hover 提示里。
      var line = song.artist || "未知歌手";
      var pa = $("player-artist");
      if (pa.textContent !== line) pa.textContent = line;
      var tip = "正在「" + mirror.deviceName + "」上播放" + (mirror.playing ? "" : "（已暂停）");
      if (pa.title !== tip) pa.title = tip;
      if (!seekDragging) {
        seek.value = dur ? Math.round((Math.min(pos, dur) / dur) * 1000) : 0;
        syncSeekFill();
      }
      $("t-cur").textContent = fmt(pos);
      $("t-dur").textContent = fmt(dur);
      var vol = $("vol");
      if (vol && isFinite(mirror.volume) && document.activeElement !== vol) {
        var v = String(Math.round(mirror.volume));
        if (vol.value !== v) { vol.value = v; vol.style.setProperty("--p", v + "%"); }
      }
      // #29 中键：短按＝遥控对面播放/暂停，长按＝弹串流浮层（提示写进 title）
      var btn = $("btn-toggle");
      if (btn) {
        var resume = mirror.action === "resume";
        var icon = resume ? "#a-play" : (mirror.playing ? "#a-pause" : "#a-play");
        var tip = resume ? "点一下继续播放" : (mirror.playing ? "暂停" : "播放") + "（在 " + mirror.deviceName + " 上）";
        var use = btn.querySelector("use");
        if (use.getAttribute("href") !== icon) use.setAttribute("href", icon);
        if (btn.title !== tip) { btn.title = tip; btn.setAttribute("aria-label", tip); }
      }
      // 串流中换歌：歌词页（歌曲详情页）跟着换
      var key = song.bvid + "|" + song.title;
      if (key !== lastMirrorSongKey) {
        var firstPaint = !lastMirrorSongKey;
        lastMirrorSongKey = key;
        if (!firstPaint) window.__lyricsRefresh && window.__lyricsRefresh();
      }
      // 歌词页开着时：进度/时间/高亮按远端走（本机 audio 在镜像态是不动的）
      var lp = $("lyrics-panel");
      if (lp && !lp.classList.contains("hidden")) {
        updateLyricHighlight(pos, false);
        var lcur = $("ly-cur"), lrem = $("ly-rem"), lseek = $("ly-seek");
        if (lcur) lcur.textContent = fmt(pos);
        if (lrem && dur) lrem.textContent = "-" + fmt(Math.max(0, dur - pos));
        window.__paintLyQuality && window.__paintLyQuality();
        if (lseek && !window.__lySeekDragging && dur) {
          lseek.value = Math.round((Math.min(pos, dur) / dur) * 1000);
          lseek.style.setProperty("--p", (lseek.value / 10) + "%");
        }
      }
    },
  };

  // ---------- 供外部调用的播放器 API ----------
  window.BiliPlayer = {
    playAlbum: playAlbum,
    playById: function (id) {
      if (albumQueueId !== null) {
        albumQueueId = null; ++queueGeneration;
        return refreshPlaylist().then(function () { window.BiliPlayer.playById(id); });
      }
      ++queueGeneration;
      var want = id; // data-play 传来的是字符串、数组里是数字：findSong 内部统一字符串化后再比
      function lookup() {
        return window.BiliPlayRoute.findSong(playlist, want);
      }
      var song = lookup();
      if (song) { playSongSmart(song); return; }
      // 曲目数组是异步装载的（页面刚开就点播放的竞态）：拉一次全量再重试，不再静默吞掉。
      // 同 playFound：不按 albumId 展开整张专辑，队列保持不动。
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
    // #23 跨端会话：上报用的队列快照（只带跨端需要的字段）+ 把远端队列搬到本机
    queue: function () {
      return playlist.map(function (s) {
        return { songId: s.id || 0, bvid: s.bvid, cid: s.cid || 0,
                 title: s.title, artist: s.artist, coverUrl: s.coverUrl,
                 duration: s.duration || 0 };   // 控制器端算进度比例 / 发 seek 要用
      });
    },
    adopt: function (items, index, at) {
      // #23 Phase 1：把远端队列搬到本机并立刻出声（打开即续播）
      var list = buildQueue(items);
      if (!list.length) return false;
      playlist = list;
      current = Math.min(Math.max(0, index | 0), list.length - 1);
      var seekTo = Math.max(0, Number(at) || 0);
      var onMeta = function () {
        audio.removeEventListener("loadedmetadata", onMeta);
        try {
          if (seekTo > 1 && isFinite(audio.duration) && seekTo < audio.duration - 2) audio.currentTime = seekTo;
        } catch (e) {}
      };
      audio.addEventListener("loadedmetadata", onMeta);
      playLocalSong(playlist[current]);   // #29 第二轮：这里必须直落本地播放——
      return true;                        // 走 playSong 分发的话，控制器收到「play 命令」时若自己也以为在镜像态，
    },                                    // 会把命令再转发回去（A→B→A 互相踢皮球，两台都不出声）
    // #23 Phase 2：移交接收端——预加载 + seek，**不出声**；canplay 后由调用方决定 play / claimed
    prepare: function (items, index, at) {
      var list = buildQueue(items);
      if (!list.length) return Promise.reject(new Error("empty-queue"));
      playlist = list;
      current = Math.min(Math.max(0, index | 0), list.length - 1);
      var song = playlist[current];
      stopTrial();
      cancelTransition();
      naturalPlan = null;
      audio.src = withTier(song.audioUrl);
      updateNowPlaying(song);
      var seekTo = Math.max(0, Number(at) || 0);
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { cleanup(); reject(new Error("canplay-timeout")); }, 5000);
        function cleanup() {
          clearTimeout(timer);
          audio.removeEventListener("loadedmetadata", onMeta);
          audio.removeEventListener("canplay", onReady);
          audio.removeEventListener("error", onErr);
        }
        function onMeta() {
          try {
            if (seekTo > 1 && isFinite(audio.duration) && seekTo < audio.duration - 2) audio.currentTime = seekTo;
          } catch (e) {}
        }
        function onReady() { cleanup(); resolve({ song: song, position: seekTo }); }
        function onErr() { cleanup(); reject(new Error("load-failed")); }
        audio.addEventListener("loadedmetadata", onMeta);
        audio.addEventListener("canplay", onReady);
        audio.addEventListener("error", onErr);
        try { audio.load(); } catch (e) { cleanup(); reject(e); }
      });
    },
    resume: function () { return audio.play(); },
    activeMedia: function () { return (recActive && recAudio) ? recAudio : audio; }, // 歌词页进度条寻址
    currentSong: function () { return playlist[current] || null; }, // 含 bvid
    position: function () { // 队列位置（1 基），用于播放页封面上的「3 / 30」；无队列返回 null
      if (!playlist.length || !playlist[current]) return null;
      return { index: current + 1, total: playlist.length };
    },
    // #29 第二轮：试听态（未收藏的推荐/最近播放）也当成一套队列上报/移交，未收藏的歌因此可串流
    trialState: function () {
      if (!recActive || !recAudio) return null;
      var items = trialQueueItems({ bvid: recAudio.dataset.bvid, title: recAudio.dataset.title,
                                    artist: recAudio.dataset.artist, cover: recAudio.dataset.cover });
      if (!items.length) return null;
      var idx = 0;
      for (var i = 0; i < items.length; i++) { if (items[i].bvid === recAudio.dataset.bvid) { idx = i; break; } }
      var dur = (isFinite(recAudio.duration) && recAudio.duration) ? Math.round(recAudio.duration) : 0;
      if (dur) items[idx].duration = dur;   // 试听流的真实时长要等 metadata，补进队列里给对面算进度
      return { items: items, index: idx, position: recAudio.currentTime || 0,
               playing: !recAudio.paused && !recAudio.ended };
    },
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
    statFlush(); // 试听停了：听满 30s 的也落一条
    try { recAudio.pause(); } catch (e) {}
    recActive = false;
    document.body.classList.remove("trial");
    if (normState && normState.el === recAudio) normState = null; // 均衡测量跟随真实在放的那路
  }

  /** 试听接管播放胶囊前，主音轨必须先让位（#29 第二轮：原来只在「换一条试听」时让位，
   *  同一条试听再点一次会直接 play()，于是主音轨那首和试听两首一起放）。 */
  function pauseMainTracks() {
    try { audioA.pause(); audioB.pause(); } catch (e) {}
  }

  /** 试听（未收藏的推荐/最近播放）也进会话：让别人能看到/接到这首，而不是只刷新在线状态。 */
  function reportTrial() {
    if (window.__sessionSync && window.__sessionSync.report) window.__sessionSync.report(true);
  }

  function syncTrialUI() {
    if (!recActive || !recAudio) return;
    syncMediaMetadata(recAudio.dataset.title, recAudio.dataset.artist, recAudio.dataset.cover);
    $("player-bar").classList.remove("hidden");
    var pt = $("player-title");
    pt.textContent = recAudio.dataset.title || "实时流试听";
    pt.title = pt.textContent;
    if (window.BiliTicker) BiliTicker.set(pt);
    $("player-artist").textContent = (recAudio.dataset.artist || "") + (window.__qualityLabel() ? " · " + window.__qualityLabel() : "");
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

  /** 试听架 → 会话/串流用的队列项（未收藏的歌没有曲库 id，只能靠 bvid 取流）。 */
  function trialQueueItems(fallback) {
    var q = window.__trialQueue;
    var items = (q && q.items && q.items.length) ? q.items : [fallback];
    return items.filter(function (it) { return it && it.bvid; }).map(function (it) {
      return { songId: 0, bvid: it.bvid, cid: 0, title: it.title || "", artist: it.artist || "",
               coverUrl: it.cover || "", duration: Number(it.duration) || 0 };
    });
  }

  // 通用实时流试听：接管播放胶囊（meta: {title, artist, cover}）
  // #29 第二轮：串流态（别的设备在放）下点推荐/最近播放＝把这首推给在放的那台，本机不出声。
  window.playStream = function (bvid, meta, btn) {
    if (mirror && window.__sessionSync && window.__sessionSync.playOnRemote) {
      var queue = trialQueueItems({ bvid: bvid, title: (meta || {}).title || "", artist: (meta || {}).artist || "",
                                    cover: (meta || {}).cover || "" });
      var idx = 0;
      for (var i = 0; i < queue.length; i++) { if (queue[i].bvid === bvid) { idx = i; break; } }
      if (queue.length) {
        var sent = window.__sessionSync.playOnRemote(queue, idx, 0);
        if (sent) { sent.then(function (ok) { if (!ok) playStreamLocal(bvid, meta, btn); }); return; }
      }
    }
    playStreamLocal(bvid, meta, btn);
  };

  function playStreamLocal(bvid, meta, btn) {
    ++queueGeneration; // A new trial selection cancels any pending album preparation.
    var mCid = Number(meta && meta.cid) || 0;
    // 同一首（bvid+cid 都同）才走「续播/暂停」；多分 P 的另一集要换 src 重开
    if (recAudio && recAudio.dataset.bvid === bvid && (Number(recAudio.dataset.cid) || 0) === mCid) {
      if (recAudio.paused || recAudio.ended) {
        pauseMainTracks();   // ← 让主音轨停：否则「主音轨那首 + 这条试听」两首一起放（用户报的 bug）
        recActive = true;
        document.body.classList.add("trial");
        syncTrialUI();
        recAudio.play().catch(function () {});
        setRecBtn(btn, "⏸ 暂停");
      } else {
        recAudio.pause();
        setRecBtn(btn, "▶ 试听");
        reportTrial();
      }
      return;
    }
    if (recAudio) recAudio.pause();
    resetRecButtons();
    pauseMainTracks(); // 主音轨让位（主音轨那首随时可切回；试听态会如实上报会话）
    cancelPreload();   // 试听接管播放：gapless 预载作废
    // v2.3 播放历史：多分 P 曲目按 meta.cid 路由（此前一律播第一分 P）
    recAudio = new Audio(withTier("/api/stream/" + bvid + (mCid ? "?cid=" + mCid : "")));
    normAttach(recAudio); // 试听/电台流也进均衡（挂不上图就裸放）
    normPrepare(recAudio, { bvid: bvid, cid: mCid });
    statBegin(recAudio, { bvid: bvid, cid: mCid, duration: Number(meta.duration) || 0, coverUrl: meta.cover || "" }, meta.title || "实时流试听", meta.artist || "");
    recAudio.dataset.bvid = bvid;
    recAudio.dataset.cid = mCid;
    recAudio.dataset.title = meta.title || "实时流试听";
    recAudio.dataset.artist = meta.artist || "";
    recAudio.dataset.cover = meta.cover || "";
    window.__qualityProbe(bvid, mCid);
    recActive = true;
    document.body.classList.add("trial");
    syncTrialUI();
    recAudio.addEventListener("ended", function () {
      if (!recActive || recAudio.dataset.bvid !== bvid) return;
      var q = window.__trialQueue;
      if (q && q.items && q.items.length > 1) { skip(1); return; }
      if (radioOn()) {
        radioContinue(function () {
          resetRecButtons();
          setPlayerToggle(true);
          if (audioA.paused && audioB.paused) document.body.classList.remove("playing");
        });
        return;
      }
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
      reportTrial();
      document.querySelectorAll(".trk-rec, .rec-card").forEach(function (row) {
        row.classList.toggle("playing", row.dataset.bvid === bvid);
      });
      if (!$("lyrics-panel").classList.contains("hidden")) loadLyrics(trialLyricsMeta()); // 歌词页开着：切试听歌即刷新
    });
    recAudio.addEventListener("timeupdate", function () {
      statTick(); // B6：试听/电台流同样计入有效收听
      if (recActive) updateLyricHighlight(recAudio.currentTime); // 歌词跟随试听进度
      if (recActive && window.BiliMusicNative && BiliMusicNative.playbackProgress &&
          (!recAudio.lastNativePush || Date.now() - recAudio.lastNativePush >= 1000)) {
        recAudio.lastNativePush = Date.now();
        BiliMusicNative.playbackProgress(recAudio.currentTime || 0, Number.isFinite(recAudio.duration) ? recAudio.duration : 0);
      }
    });
    recAudio.addEventListener("pause", function () {
      setPlayerToggle(true);
      if (audioA.paused && audioB.paused) document.body.classList.remove("playing");
      reportTrial();
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

  // ---------- 最近播放：前端已砍（等重新设计），本机 localStorage 记录一并停写 ----------

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
