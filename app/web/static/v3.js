/* BiliMusic v3 交互层：视图/主题/侧栏拖宽/链接收藏/移动端 Tab（依赖 app.js 全局） */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  // ---------- 主题 ----------
  window.toggleTheme = function () {
    var t = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("bmTheme", t); } catch (e) {}
  };

  var mainEl = $("mainEl");

  // 详情页滚动时淡出面包屑（dt-top 已透明，避免文字与曲目行重叠）
  if (mainEl) {
    mainEl.addEventListener("scroll", function () {
      mainEl.classList.toggle("scrolled", mainEl.scrollTop > 64);
    }, { passive: true });
  }

  // ---------- 侧栏拖宽（仅桌面有意义；范围 200–420） ----------
  (function () {
    var handle = $("side-handle"), app = $("app");
    if (!handle || !app) return;
    var dragging = false;
    handle.addEventListener("pointerdown", function (e) {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      document.body.style.cursor = "col-resize";
    });
    handle.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var w = Math.min(420, Math.max(200, e.clientX));
      // 设在 html 上：内容区、侧栏与全屏覆盖层（歌词/艺术家页）都能继承
      document.documentElement.style.setProperty("--side", w + "px");
    });
    var up = function () { dragging = false; document.body.style.cursor = ""; };
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  })();

  // ---------- 用户设置弹层（侧栏点头像：智能切歌 / 同步 / 退出登录） ----------
  (function () {
    var btn = $("side-user-btn"), pop = $("user-pop");
    var host = btn && btn.closest(".side-user");
    if (!btn || !pop || !host) return;
    var smart = $("smart-toggle-side"), queueSmart = $("smart-toggle");
    var smartOn = function () { return localStorage.getItem("bmSmartTransition") !== "0"; };
    if (smart) {
      smart.checked = smartOn();
      smart.addEventListener("change", function () {
        localStorage.setItem("bmSmartTransition", smart.checked ? "1" : "0");
        if (queueSmart && queueSmart.checked !== smart.checked) {
          queueSmart.checked = smart.checked;
          queueSmart.dispatchEvent(new Event("change", { bubbles: true })); // 同步队列面板的智能过渡开关
        }
      });
    }
    if (queueSmart) queueSmart.addEventListener("change", function () {
      if (smart) smart.checked = queueSmart.checked;
    });
    var setOpen = function (v) { host.classList.toggle("pop-open", v); };
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(!host.classList.contains("pop-open"));
    });
    pop.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".user-pop")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });
    var sync = $("side-sync"), quit = $("side-logout");
    if (sync) sync.addEventListener("click", function () { setOpen(false); syncNow(); });
    if (quit) quit.addEventListener("click", function () {
      fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        .then(function () { location.href = "/"; });
    });
  })();

  // ---------- 导航 ----------
  function collapseOverlays() {
    var up = $("up-panel"), ly = $("lyrics-panel");
    if (up) window.__hidePanel(up);
    if (ly) { window.__hidePanel(ly); ly.classList.remove("showlyrics"); var bl = $("btn-lyrics"); if (bl) bl.classList.remove("on"); }
  }
  window.goHome = function () {
    collapseOverlays();
    $("app").dataset.view = "home";
    document.body.classList.remove("in-detail");
    if (window.switchView) switchView("home");
    var nav = $("navHome");
    if (nav) nav.classList.add("on");
  };
  window.jumpDiscover = function () {
    goHome();
    var sec = document.getElementById("sec-discover");
    if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  window.focusSearchBar = function () {
    goHome();
    var s = $("search");
    if (s) { s.focus(); }
  };
  window.syncNow = function () {
    var b = $("btn-sync");
    if (b) b.click();
  };

  // ---------- 歌单详情（user = 曲库歌单 / rec = 线上推荐歌单） ----------
  var dtState = { kind: "user", id: "0", name: "全部歌曲", hue: 340 };

  function fillUserDetail(el) {
    var d = el.dataset;
    dtState = { kind: "user", id: d.pl, name: d.name, hue: d.hue || 340 };
    $("app").dataset.view = "detail";
    document.body.classList.add("in-detail");
    var hero = document.getElementById("dt-hero");
    if (hero) hero.style.setProperty("--dh", dtState.hue);
    document.getElementById("dt-eyebrow").textContent =
      d.pl === "0" ? "ALL · 全部收藏" :
      d.default === "1" ? "MAIN · 默认歌单 · bilimusic 夹" : "PLAYLIST · bilimusic-" + d.name + " 夹";
    document.getElementById("dt-title").textContent = d.name;
    document.getElementById("dt-meta").innerHTML =
      "<b>" + d.count + " 首</b><span>·</span><span>已同步 B 站收藏夹</span>";
    document.getElementById("dt-crumb").textContent = "主页 / " + d.name;
    // 封面：取歌单内真实视频封面做艺术化拼贴（无封面/请求失败回退渐变底）
    var cvr0 = document.querySelector("#dt-hero .dt-cvr");
    if (cvr0) { cvr0.classList.remove("mosaic-host"); cvr0.innerHTML = ""; }
    fetch("/api/playlists/" + encodeURIComponent(d.pl) + "/covers")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.covers) || !data.covers.length) return;
        if ($("app").dataset.view !== "detail" || dtState.id !== d.pl) return; // 请求期间已切走
        var c = document.querySelector("#dt-hero .dt-cvr");
        var mos = mosaicHtml(data.covers.join("|"));
        if (c && mos) { c.classList.add("mosaic-host"); c.innerHTML = mos; }
      })
      .catch(function () {});
    if (window.htmx) {
      htmx.ajax("GET", "/partials/songs?playlist_id=" + encodeURIComponent(d.pl), {
        target: "#dt-songs",
        swap: "innerHTML",
      });
    }
    if (mainEl) mainEl.scrollTop = 0;
  }

  function mosaicHtml(covers) {
    var esc = function (s) {
      return String(s || "").replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    };
    var urls = (covers || "").split("|").filter(Boolean);
    if (!urls.length) return "";
    if (urls.length >= 4) {
      var imgs = urls.slice(0, 4).map(function (u) {
        return '<img src="' + esc(u) + '" alt="" referrerpolicy="no-referrer">';
      }).join("");
      return '<span class="mosaic">' + imgs + "</span>";
    }
    return '<span class="mosaic one"><img src="' + esc(urls[0]) + '" alt="" referrerpolicy="no-referrer"></span>';
  }

  function fillRecDetail(el, autoplay) {
    var d = el.dataset;
    dtState = { kind: "rec", id: "rec:" + d.rgenre, name: d.name, hue: d.hue || 340 };
    $("app").dataset.view = "detail";
    document.body.classList.add("in-detail");
    var hero = document.getElementById("dt-hero");
    if (hero) hero.style.setProperty("--dh", dtState.hue);
    var cvr = document.querySelector("#dt-hero .dt-cvr");
    var mos = mosaicHtml(d.covers);
    if (cvr) {
      cvr.classList.toggle("mosaic-host", !!mos);
      cvr.innerHTML = mos;
    }
    document.getElementById("dt-eyebrow").textContent =
      d.rgenre === "daily" ? "REC · 每日轮换推荐" : "REC · 线上推荐歌单";
    document.getElementById("dt-title").textContent = d.name;
    document.getElementById("dt-meta").innerHTML =
      "<b>" + d.count + " 首</b><span>·</span><span>来自 B 站推荐池</span><span>·</span><span>实时流试听 · 不下载</span>";
    document.getElementById("dt-crumb").textContent = "主页 / " + d.name;
    if (window.htmx) {
      htmx.ajax("GET", "/partials/rec-genre-tracks?genre=" + encodeURIComponent(d.rgenre), {
        target: "#dt-songs",
        swap: "innerHTML",
      });
    }
    if (mainEl) mainEl.scrollTop = 0;
    if (autoplay) setTimeout(window.playDetailFirst, 900); // 等曲目列表加载
  }

  window.openDetailFrom = function (el, autoplay) {
    collapseOverlays(); // 侧栏常驻后：进详情前收起全屏覆盖层（艺术家页/歌词页）
    // 先选中歌单（决定收藏目标 + 主页列表联动），再进详情
    if (el.dataset.rgenre === undefined && window.selectPlaylist) selectPlaylist(el.dataset.pl, el);
    if (el.dataset.rgenre !== undefined) fillRecDetail(el, autoplay);
    else fillUserDetail(el);
  };

  function firstRecRow() { return document.querySelector('#dt-songs .trk-rec'); }

  // 曲目列表由 htmx 异步装载：点得早时轮询等待（~4s），不再静默吞掉点击
  function whenDetailRows(cb) {
    var tries = 0;
    (function poll() {
      if (document.querySelector("#dt-songs [data-play], #dt-songs .trk-rec")) { cb(); return; }
      if (++tries > 40) { window.__toast("曲目还在加载，稍后再试"); return; }
      setTimeout(poll, 100);
    })();
  }

  window.playDetailFirst = function () {
    whenDetailRows(function () {
      if (dtState.kind === "rec") {
        var r = firstRecRow();
        if (r) r.click();
        return;
      }
      var row = document.querySelector("#dt-songs [data-play]");
      if (row && window.BiliPlayer) BiliPlayer.playById(row.dataset.play);
    });
  };
  // 分享该歌单：取对应 B 站收藏夹链接（自动复制 + 弹窗展示可手动复制）
  window.shareDetail = function () {
    if (dtState.kind === "rec") { window.__toast("线上推荐歌单不支持分享"); return; }
    fetch("/api/playlists/" + String(dtState.id) + "/share-link")
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, t: t }; }); })
      .then(function (res) {
        var data = null;
        try { data = JSON.parse(res.t); } catch (e) {}
        if (!res.ok) { window.__toast((data && data.detail) || "获取分享链接失败"); return; }
        var link = (data && data.link) || "";
        if (link && navigator.clipboard) navigator.clipboard.writeText(link).catch(function () {});
        var extra = (data && data.folderCount > 1) ? "（共 " + data.folderCount + " 夹，链接为首夹）" : "";
        if (window.__promptModal) {
          window.__promptModal("分享「" + ((data && data.name) || "") + "」· 链接已复制" + extra, { value: link });
        }
      })
      .catch(function () { window.__toast("网络错误，请重试"); });
  };

  // 推荐行点击 → 实时流试听（胶囊接管）
  window.playRecRow = function (row) {
    if (!window.playStream) return;
    var img = row.querySelector("img");
    window.playStream(row.dataset.bvid, {
      title: (row.querySelector(".t1") || {}).textContent || "",
      artist: row.dataset.artist || (row.querySelector(".t2") || {}).textContent || "",
      cover: img ? img.src : "",
    }, null);
  };

  // 歌单增删改后：刷新侧栏；正在看的用户歌单没了就回主页（推荐歌单详情不受影响）
  document.body.addEventListener("playlistsChanged", function () {
    if ($("app").dataset.view !== "detail" || dtState.kind === "rec") return;
    var el = document.querySelector('.side-pl[data-pl="' + dtState.id + '"]');
    if (el) fillUserDetail(el);
    else goHome();
  });

  // ---------- toast 轻提示 ----------
  var toastTimer = null;
  window.__toast = function (msg) {
    var el = $("toast");
    if (!el) return;
    $("toast-txt").textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2400);
  };

  // ---------- 界面切换过渡：覆盖层开（淡入上浮）/ 关（淡出后隐藏） ----------
  window.__showPanel = function (el) {
    if (!el) return;
    el.classList.remove("hidden", "closing");
    el.classList.add("opening");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.remove("opening"); });
    });
  };
  window.__hidePanel = function (el) {
    if (!el || el.classList.contains("hidden")) return;
    el.classList.add("closing");
    setTimeout(function () { el.classList.add("hidden"); el.classList.remove("closing"); }, 300);
  };

  // ---------- UP 主作品页（Apple Music 沉浸式艺术家页） ----------
  window.openUp = async function (bvid) {
    if (!bvid) return;
    var p = $("up-panel");
    if (!p) return;
    try {
      var r = await fetch("/web/up/resolve?bvid=" + encodeURIComponent(bvid));
      var owner = await r.json();
      if (!r.ok || !owner.mid) { window.__toast(owner.error || "未找到 UP 主"); return; }
      window.__showPanel(p);
      p.dataset.name = owner.name || "";
      p.dataset.mid = owner.mid;
      p.style.setProperty("--uph", owner.hue != null ? owner.hue : 340);
      p.style.setProperty("--upfog", 0);
      lastUpFog = -1;
      $("up-bg").src = owner.face || "";
      $("up-bg-blur").src = owner.face || "";
      $("up-ambient").src = owner.face || "";
      $("up-name").textContent = owner.name || "UP 主";
      $("up-space").href = "https://space.bilibili.com/" + owner.mid;
      $("up-body").innerHTML = '<div class="empty">加载中…</div>';
      var list = $("up-list");
      if (list) list.scrollTop = 0;
      if (window.htmx) {
        htmx.ajax("GET", upUrl(owner.mid, 1), { target: "#up-body", swap: "innerHTML" });
      }
    } catch (e) { window.__toast("网络错误，请重试"); }
  };
  function upUrl(mid, pn) {
    var p = $("up-panel");
    var name = p && p.dataset.name ? "&name=" + encodeURIComponent(p.dataset.name) : "";
    return "/partials/up?mid=" + mid + "&pn=" + pn + name;
  }
  function upFirstSong() {
    return document.querySelector("#up-body .up-song") || document.querySelector("#up-body .up-video");
  }
  var lastUpFog = -1; // 上次设置的 --upfog，避免滚动中高频写样式
  (function () {
    var p = $("up-panel");
    if (!p) return;
    var close = $("up-close");
    if (close) close.addEventListener("click", function () { window.__hidePanel(p); });
    var list = $("up-list");
    if (list) {
      // 滚动：hero 随页离开视口，头像背景渐虚化融入环境背景
      list.addEventListener("scroll", function () {
        if (p.classList.contains("hidden")) return;
        var fog = Math.min(1, list.scrollTop / 240);
        if (Math.abs(fog - lastUpFog) > 0.02) {
          lastUpFog = fog;
          p.style.setProperty("--upfog", fog.toFixed(2));
        }
      }, { passive: true });
      // 加载更多（委托）
      list.addEventListener("click", function (e) {
        var more = e.target.closest(".up-more");
        if (!more || !window.htmx) return;
        var mid = more.dataset.mid, pn = more.dataset.pn;
        var loading = document.createElement("div");
        loading.className = "empty";
        loading.textContent = "加载中…";
        more.replaceWith(loading);
        htmx.ajax("GET", upUrl(mid, pn), { target: "#up-body", swap: "beforeend" });
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!p.classList.contains("hidden")) window.__hidePanel(p);
    });
    // Hero 操作行：播放热门 / 分享主页 / 随机播放
    var playBtn = $("up-play");
    if (playBtn) playBtn.addEventListener("click", function () {
      if (window.BiliPlayer && (document.body.classList.contains("playing"))) { BiliPlayer.toggle(); return; }
      var first = upFirstSong();
      if (first) playRecRow(first); else window.__toast("作品加载中…");
    });
    var shareBtn = $("up-share");
    if (shareBtn) shareBtn.addEventListener("click", function () {
      var link = "https://space.bilibili.com/" + (p.dataset.mid || "");
      if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () {
        window.__toast("主页链接已复制");
      }, function () { window.__toast(link); });
    });
    var shufBtn = $("up-shuffle");
    if (shufBtn) shufBtn.addEventListener("click", function () {
      var rows = document.querySelectorAll("#up-body .up-song, #up-body .up-video");
      if (!rows.length) { window.__toast("作品加载中…"); return; }
      playRecRow(rows[Math.floor(Math.random() * rows.length)]);
    });
    // 曲目行里点 UP 名（.t2）：进作品页而非播放（捕获阶段拦截，抢在行 onclick 之前）
    document.addEventListener("click", function (e) {
      var t2 = e.target.closest(".t2");
      if (!t2 || t2.closest("#up-panel") || t2.closest(".search-drop")) return;
      var row = t2.closest(".trk");
      if (!row) return;
      var bvid = row.dataset.bvid;
      if (!bvid) return;
      e.stopPropagation();
      e.preventDefault();
      openUp(bvid);
    }, true);
    // 歌词页 / 播放条的 UP 名点击
    function upFromPlayer() {
      var t = window.BiliPlayer && BiliPlayer.trialInfo ? BiliPlayer.trialInfo() : null;
      var s = window.BiliPlayer && BiliPlayer.currentSong ? BiliPlayer.currentSong() : null;
      var bvid = t ? t.bvid : (s ? s.bvid : null);
      if (bvid) openUp(bvid); else window.__toast("当前没有播放的歌");
    }
    var la = $("lyrics-artist"), pa = $("player-artist");
    if (la) la.addEventListener("click", upFromPlayer);
    if (pa) pa.addEventListener("click", upFromPlayer);
    // Mini Player：接管播放控制 + 当前曲同步
    var umPrev = $("um-prev"), umNext = $("um-next"), umToggle = $("um-toggle"), umLyrics = $("um-lyrics");
    if (umPrev && window.BiliPlayer) umPrev.addEventListener("click", function () { BiliPlayer.prev(); });
    if (umNext && window.BiliPlayer) umNext.addEventListener("click", function () { BiliPlayer.next(); });
    if (umToggle && window.BiliPlayer) umToggle.addEventListener("click", function () { BiliPlayer.toggle(); });
    if (umLyrics) umLyrics.addEventListener("click", function () {
      window.__hidePanel(p);
      if (window.toggleLyrics) toggleLyrics();
    });
    function syncMini() {
      if (p.classList.contains("hidden")) return;
      var song = window.BiliPlayer && BiliPlayer.currentSong ? BiliPlayer.currentSong() : null;
      var trial = window.BiliPlayer && BiliPlayer.trialInfo ? BiliPlayer.trialInfo() : null;
      var t = trial ? trial.title : (song ? song.title : "—");
      var a = trial ? trial.artist : (song ? song.artist : "");
      var c = trial ? trial.cover : (song ? song.coverUrl : "");
      var tt = $("um-title"), aa = $("um-artist"), cc = $("um-cover");
      if (tt.textContent !== t) tt.textContent = t;
      if (aa.textContent !== a) aa.textContent = a;
      if (c && !cc.src.endsWith(c) && cc.getAttribute("src") !== c) cc.src = c;
    }
    setInterval(syncMini, 800);
  })();

  // ---------- 已收藏状态：爱心灰→点亮 ----------
  var collected = {};
  function markHearts() {
    document.querySelectorAll("[data-bvid]").forEach(function (n) {
      var h = (n.classList.contains("sd-heart") || n.classList.contains("love")) ? n : n.querySelector(".sd-heart, .love");
      if (h) h.classList.toggle("on", !!collected[n.dataset.bvid]);
    });
  }
  function loadCollected() {
    if (!window.BiliPlayer || !BiliPlayer.songs) return;
    BiliPlayer.songs("").then(function (songs) {
      collected = {};
      (songs || []).forEach(function (s) { collected[s.bvid] = 1; });
      markHearts();
    }).catch(function () {});
  }
  window.__markCollected = function (bvid) {
    collected[bvid] = 1;
    markHearts();
  };
  document.body.addEventListener("refreshSongs", loadCollected);
  document.body.addEventListener("htmx:afterSwap", function (e) {
    if (e.target && (e.target.id === "sd-web" || e.target.id === "rec-list" || e.target.id === "up-body")) markHearts();
  });
  loadCollected();

  // ---------- 搜索下拉：曲库命中（点击即播）+ B 站结果（♥ 收藏） ----------
  (function () {
    var input = $("search"), drop = $("search-drop"), lib = $("sd-lib"), web = $("sd-web");
    if (!input || !drop) return;
    var LINK = /^\s*(https?:\/\/|b23\.|bv|av)/i;
    var timer = null, lastQ = null;

    function open() { drop.hidden = false; }
    function close() {
      drop.hidden = true;
      var tb = $("topbar"); // 手机端：搜索胶囊随关闭一并收起
      if (tb) { tb.classList.remove("searching"); tb.style.bottom = ""; }
      document.body.classList.remove("msearching");
      var d = $("search-drop"); if (d) d.style.bottom = "";
    }

    function esc(s) {
      return String(s || "").replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    function renderLib(songs) {
      if (!songs.length) {
        lib.innerHTML = '<div class="sd-sec">曲库</div><div class="sd-empty">曲库没有匹配 · 去 B 站找找 ↓</div>';
        return;
      }
      lib.innerHTML = '<div class="sd-sec">曲库 · 点击播放</div>' + songs.map(function (s) {
        return '<div class="sd-row" data-song="' + s.id + '">' +
          '<img class="sd-cov" src="' + s.coverUrl + '" alt="" referrerpolicy="no-referrer">' +
          '<div class="sd-meta"><div class="sd-t">' + esc(s.title) + '</div>' +
          '<div class="sd-s">' + esc(s.artist) + '</div></div>' +
          '<span class="sd-play">▶</span></div>';
      }).join("");
    }

    function renderLinkCard(url) {
      lib.innerHTML = '<div class="sd-collect">' +
        '<span style="font-size:24px;flex:none">🎬</span>' +
        '<div class="sd-meta"><div class="sd-t">识别到视频链接</div>' +
        '<div class="sd-s">' + esc(url) + '</div></div>' +
        '<button class="sd-go" type="button">♥ 收藏</button></div>';
      var btn = lib.querySelector(".sd-go");
      btn.addEventListener("click", function () {
        var pid = document.getElementById("collect-playlist-id");
        var body = new URLSearchParams({ url: url, playlist_id: pid ? pid.value : "0" });
        btn.disabled = true;
        btn.textContent = "收藏中…";
        fetch("/web/import", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body,
        })
          .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, t: t }; }); })
          .then(function (res) {
            btn.disabled = false;
            btn.textContent = "♥ 收藏";
            if (!res.ok) { window.__toast(res.t || "收藏失败"); return; }
            window.__toast("已提交收藏 · 完成后自动入库");
            input.value = "";
            close();
            if (window.htmx) {
              htmx.ajax("GET", "/partials/tasks", { target: "#task-list", swap: "innerHTML" });
              htmx.trigger(document.body, "refreshSongs");
            }
          })
          .catch(function () {
            btn.disabled = false;
            btn.textContent = "♥ 收藏";
            window.__toast("网络错误，请重试");
          });
      });
    }

    function run(q) {
      if (q === lastQ) return;
      lastQ = q;
      if (LINK.test(q)) { // 粘贴链接 / BV 号：仅显示收藏卡
        renderLinkCard(q);
        web.innerHTML = "";
        return;
      }
      if (window.BiliPlayer && BiliPlayer.songs) {
        BiliPlayer.songs(q).then(function (songs) { renderLib((songs || []).slice(0, 5)); })
          .catch(function () { renderLib([]); });
      }
      if (window.htmx) {
        htmx.ajax("GET", "/partials/web-search?q=" + encodeURIComponent(q), { target: "#sd-web", swap: "innerHTML" });
      }
    }

    var closeBtn = $("search-close");
    var syncClose = function () { // 桌面端：有输入才显示 ✕（点击清空）；手机端搜索态由 CSS 接管
      if (closeBtn) closeBtn.style.display = (input.value.trim() && !drop.hidden) ? "grid" : "";
    };
    input.addEventListener("input", function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (!q) { close(); lastQ = null; } else { open(); timer = setTimeout(function () { run(q); }, 350); }
      syncClose();
    });
    input.addEventListener("focus", function () {
      if (input.value.trim()) open();
    });
    if (closeBtn) closeBtn.addEventListener("click", function () {
      input.value = "";
      close();
      input.blur();
      syncClose();
    });
    lib.addEventListener("click", function (e) {
      var row = e.target.closest("[data-song]");
      if (row && window.BiliPlayer) { BiliPlayer.playById(Number(row.dataset.song)); close(); }
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest("#search-drop") && !e.target.closest("#tbSearch")) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
  })();

  // ---------- 音量（双 audio 元素同步；--p 驱动滑条粉色填充） ----------
  (function () {
    var vol = $("vol");
    if (!vol) return;
    var paint = function () { vol.style.setProperty("--p", vol.value + "%"); };
    paint();
    vol.addEventListener("input", function () {
      var v = vol.value / 100;
      var a = $("audio"), b = $("audio2");
      if (a) a.volume = v;
      if (b) b.volume = v;
      paint();
    });
  })();

  // ---------- 点封面 → 歌词详情页（曲库歌 / 试听歌都支持） ----------
  (function () {
    var c = $("player-cover"), lc = $("lyrics-cover");
    if (c && window.toggleLyrics) c.addEventListener("click", function () { toggleLyrics(); });
    if (lc && window.BiliPlayer) lc.addEventListener("click", function () {
      // 手机端歌词视图：点顶栏小封面回到大封面视图；其余情况维持原"点封面播放/暂停"
      var panel = $("lyrics-panel");
      if (panel.classList.contains("showlyrics") && window.matchMedia("(max-width: 900px)").matches) {
        panel.classList.remove("showlyrics");
        return;
      }
      BiliPlayer.toggle();
    });
  })();

  // ---------- 手机端播放页：封面视图 ↔ 歌词视图（Apple Music 式） ----------
  (function () {
    var panel = $("lyrics-panel");
    if (!panel) return;
    var big = $("lyrics-cover-big");
    if (big) big.addEventListener("click", function () { panel.classList.add("showlyrics"); });
    var bubble = $("ly-bubble");
    if (bubble) bubble.addEventListener("click", function () { panel.classList.toggle("showlyrics"); });
  })();

  // ---------- 歌词页控制条：进度/时间跟随当前媒体（曲库歌或试听流），seek 双向 ----------
  (function () {
    var seekEl = $("ly-seek");
    if (!seekEl || !window.BiliPlayer) return;
    var dragging = false;
    var panelOpen = function () { return !$("lyrics-panel").classList.contains("hidden"); };

    setInterval(function () {
      if (!panelOpen()) return;
      var m = BiliPlayer.activeMedia();
      if (!m || !m.duration || !isFinite(m.duration)) return;
      if (!dragging) {
        seekEl.value = Math.round((m.currentTime / m.duration) * 1000);
        seekEl.style.setProperty("--p", (seekEl.value / 10) + "%"); // 已播粉色填充
      }
      $("ly-cur").textContent = fmtTime(m.currentTime);
      $("ly-rem").textContent = "-" + fmtTime(Math.max(0, m.duration - m.currentTime));
    }, 500);
    function fmtTime(s) {
      s = Math.max(0, Math.floor(s || 0));
      return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }
    seekEl.addEventListener("input", function () {
      dragging = true;
      seekEl.style.setProperty("--p", (seekEl.value / 10) + "%"); // 拖动实时填充
      var m = BiliPlayer.activeMedia();
      if (m && m.duration) $("ly-cur").textContent = fmtTime((seekEl.value / 1000) * m.duration);
    });
    seekEl.addEventListener("change", function () {
      var m = BiliPlayer.activeMedia();
      if (m && m.duration) {
        try { m.currentTime = (seekEl.value / 1000) * m.duration; } catch (e) {}
      }
      dragging = false;
    });
    var lt = $("ly-toggle");
    if (lt) lt.addEventListener("click", function () { BiliPlayer.toggle(); });
    var lp = $("ly-prev");
    if (lp) lp.addEventListener("click", function () { BiliPlayer.skip(-1); });
    var ln = $("ly-next");
    if (ln) ln.addEventListener("click", function () { BiliPlayer.skip(1); });

    // 播放模式钮：顺序 → 列表循环 → 随机 循环切换（引擎行为见 app.js playMode()）
    var MODES = [
      { k: "order", name: "顺序播放", icon: "i-queue" },
      { k: "loop", name: "列表循环", icon: "i-rep" },
      { k: "random", name: "随机播放", icon: "i-shuf" },
    ];
    var lm = $("ly-mode");
    if (lm) {
      var applyMode = function () {
        var cur = localStorage.getItem("bmPlayMode") || "order";
        var m = MODES.filter(function (x) { return x.k === cur; })[0] || MODES[0];
        var use = lm.querySelector("use");
        if (use) use.setAttribute("href", "#" + m.icon);
        lm.title = "播放模式：" + m.name;
      };
      lm.addEventListener("click", function () {
        var cur = localStorage.getItem("bmPlayMode") || "order";
        var next = MODES[(MODES.findIndex(function (x) { return x.k === cur; }) + 1) % MODES.length];
        localStorage.setItem("bmPlayMode", next.k);
        applyMode();
        window.__toast("播放模式：" + next.name);
      });
      applyMode();
    }

    // ＋ 添加至歌单（当前歌）
    var la = $("ly-add");
    if (la) la.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!window.__openPlMenu) return;
      var trial = window.BiliPlayer && BiliPlayer.trialInfo();
      if (trial) __openPlMenu(la.getBoundingClientRect(), "url", {
        bvid: trial.bvid, url: "https://www.bilibili.com/video/" + trial.bvid,
      });
      else {
        var song = BiliPlayer.currentSong();
        if (!song) { window.__toast("当前没有播放的歌"); return; }
        __openPlMenu(la.getBoundingClientRect(), "song", { song: song.id });
      }
    });

    // ··· 详情菜单：加入歌单 / 打开原链接 / 分享 / 推荐相似歌曲（试听歌无曲库 id，无相似推荐）/ 在 B 站打开
    var more = $("ly-more");
    if (more) more.addEventListener("click", function (e) {
      e.stopPropagation();
      var sm = $("song-menu");
      if (!sm) return;
      var trial = window.BiliPlayer && BiliPlayer.trialInfo();
      var song = trial ? null : (BiliPlayer.currentSong() || null);
      var bvid = trial ? trial.bvid : (song ? song.bvid : null);
      if (!bvid) { window.__toast("当前没有播放的歌"); return; }
      var url = "https://www.bilibili.com/video/" + bvid;
      var items = [
        '<button type="button" class="pm-item" data-act="pl">加入歌单</button>',
        '<button type="button" class="pm-item" data-act="open">打开原链接</button>',
        '<button type="button" class="pm-item" data-act="share">分享</button>',
      ];
      if (song) items.push('<button type="button" class="pm-item" data-act="similar">推荐相似歌曲</button>');
      items.push('<button type="button" class="pm-item" data-act="bili">在 B 站打开</button>');
      sm.innerHTML = items.join("");
      sm.hidden = false;
      var r = more.getBoundingClientRect();
      var mh = sm.offsetHeight, mw = sm.offsetWidth;
      sm.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + "px";
      sm.style.top = (r.top - mh - 8 > 8 ? r.top - mh - 8 : r.bottom + 8) + "px";
      sm.dataset.bvid = bvid;
      sm.dataset.url = url;
      sm.dataset.trial = trial ? "1" : "";
      sm.dataset.songid = song ? song.id : "";
    });
    var sm2 = $("song-menu");
    if (sm2) sm2.addEventListener("click", function (e) {
      e.stopPropagation(); // 防止选动作的点击冒泡到 document 误关刚打开的 pl-menu
      var act = e.target.closest("[data-act]");
      if (!act) return;
      var kind = act.dataset.act;
      sm2.hidden = true;
      var bvid = sm2.dataset.bvid;
      if (kind === "bili") { window.open("https://www.bilibili.com/video/" + bvid, "_blank"); return; }
      if (kind === "share") {
        var link = "https://www.bilibili.com/video/" + bvid;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(
            function () { window.__toast("链接已复制 · 可粘贴给朋友或本应用整单收藏"); },
            function () { window.__toast("复制失败，请手动复制：" + link); }
          );
        } else {
          window.__toast(link);
        }
        return;
      }
      if (kind === "similar") {
        var sid = Number(sm2.dataset.songid);
        if (!sid) { window.__toast("试听歌暂不支持推荐相似"); return; }
        fetch("/api/recs/seed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ songId: sid }),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.queued) {
              window.__toast("已提交相似推荐采集 · 稍后到发现页看看");
              setTimeout(function () { // 后台采集 2-4s，完成后刷新发现区
                if (window.htmx) htmx.trigger(document.body, "recsChanged");
              }, 4500);
            } else {
              window.__toast("相似歌曲有采集频控，稍后再来");
            }
          })
          .catch(function () { window.__toast("网络错误，请重试"); });
        return;
      }
      // 加入歌单：复用 pl-menu（锚定 ··· 按钮位置）
      var m = $("ly-more");
      if (m && window.__openPlMenu) {
        var rect = m.getBoundingClientRect();
        if (sm2.dataset.trial) __openPlMenu(rect, "url", { bvid: bvid, url: "https://www.bilibili.com/video/" + bvid });
        else {
          var sid2 = Number(sm2.dataset.songid);
          if (sid2) __openPlMenu(rect, "song", { song: sid2 });
        }
      }
    });
    document.addEventListener("click", function (e) {
      var sm = $("song-menu");
      if (sm && !sm.hidden && !e.target.closest("#song-menu") && !e.target.closest("#ly-more")) sm.hidden = true;
    });
  })();

  // ---------- 播放状态 → 全局均衡器动画 ----------
  (function () {
    ["audio", "audio2"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("play", function () { document.body.classList.add("playing"); });
      el.addEventListener("pause", function () {
        var a = $("audio"), b = $("audio2");
        if (a && b && a.paused && b.paused) document.body.classList.remove("playing");
      });
    });
  })();

  // ---------- Esc 关闭浮层 ----------
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var lp = $("lyrics-panel"), qp = $("queue-panel");
    if (lp && !lp.classList.contains("hidden")) {
      var bc = $("btn-lyrics-close");
      if (bc) bc.click();
      return;
    }
    if (qp && !qp.classList.contains("hidden")) {
      var bq = $("btn-queue");
      if (bq) bq.click();
      return;
    }
    if ($("app").dataset.view === "detail") goHome();
  });

  // ---------- 轻量弹窗（in-app 浏览器常拦截 prompt/confirm，改用页面内弹窗） ----------
  window.__promptModal = function (title, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var box = $("mini-modal-box"), wrap = $("mini-modal");
      box.innerHTML =
        '<h3 style="margin-bottom:12px">' + title + "</h3>" +
        '<input id="mm-input" type="text" style="width:100%;height:42px;border-radius:12px;background:var(--card);' +
        'border:1px solid var(--stroke);padding:0 14px;font-size:14px" placeholder="' + (opts.placeholder || "") + '" ' +
        'value="' + (opts.value || "") + '">' +
        '<div class="modal-actions"><button id="mm-cancel">取消</button><button id="mm-ok">确定</button></div>';
      wrap.classList.remove("hidden");
      var input = $("mm-input");
      input.focus();
      input.select();
      var done = function (val) {
        wrap.classList.add("hidden");
        document.removeEventListener("keydown", onKey, true);
        resolve(val);
      };
      var onKey = function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); done(input.value.trim() || null); }
        if (ev.key === "Escape") { ev.preventDefault(); done(null); }
      };
      document.addEventListener("keydown", onKey, true);
      $("mm-ok").addEventListener("click", function () { done(input.value.trim() || null); });
      $("mm-cancel").addEventListener("click", function () { done(null); });
    });
  };
  window.__confirmModal = function (title, text) {
    return new Promise(function (resolve) {
      var box = $("mini-modal-box"), wrap = $("mini-modal");
      box.innerHTML =
        '<h3 style="margin-bottom:10px">' + title + "</h3>" +
        '<p style="font-size:12.5px;color:var(--txt2);line-height:1.8">' + text + "</p>" +
        '<div class="modal-actions"><button id="mm-cancel">取消</button>' +
        '<button id="mm-ok" style="background:#e05252">删除</button></div>';
      wrap.classList.remove("hidden");
      var done = function (val) { wrap.classList.add("hidden"); resolve(val); };
      $("mm-ok").addEventListener("click", function () { done(true); });
      $("mm-cancel").addEventListener("click", function () { done(false); });
    });
  };

  // ---------- 行内"加入歌单"菜单 ----------
  (function () {
    var menu = $("pl-menu");
    if (!menu) return;
    function hide() { menu.hidden = true; }

    // 供歌词页 ＋/··· 等处编程调用：rect=锚点，mode="song"(data.song)|"url"(data.bvid/url)
    window.__openPlMenu = function (rect, mode, data) {
      var items = [];
      document.querySelectorAll(".side-pl").forEach(function (el) {
        if (el.dataset.pl !== "0") {
          items.push({ id: el.dataset.pl, name: el.dataset.name });
        }
      });
      menu.innerHTML = '<div class="pm-title">' + (mode === "url" ? "加入歌单（收藏入库）" : "加入歌单") + "</div>" +
        items.map(function (p) {
          return '<button type="button" class="pm-item" data-pm="' + p.id + '" data-name="' + p.name + '">' +
            '<span class="nm">' + p.name + "</span></button>";
        }).join("") +
        '<button type="button" class="pm-item pm-new" data-new="1">＋ 新建歌单</button>';
      menu.hidden = false;
      var mw = menu.offsetWidth, mh = menu.offsetHeight;
      var left = Math.max(8, Math.min(window.innerWidth - mw - 8, rect.right - mw));
      var top = rect.bottom + 6;
      if (top + mh > window.innerHeight - 8) top = rect.top - mh - 6;
      top = Math.max(8, Math.min(window.innerHeight - mh - 8, top));
      menu.style.left = left + "px";
      menu.style.top = top + "px";
      menu.dataset.mode = mode;
      if (mode === "url") { menu.dataset.bvid = data.bvid; menu.dataset.url = data.url; }
      else { menu.dataset.song = data.song; }
    };
    document.addEventListener("click", function (e) {
      var songBtn = e.target.closest(".addto[data-add]");
      var recBtn = e.target.closest(".addto[data-rec]");
      if (songBtn || recBtn) {
        e.stopPropagation();
        menu.dataset.mode = recBtn ? "url" : "song";
        if (recBtn) { menu.dataset.bvid = recBtn.dataset.rec; menu.dataset.url = recBtn.dataset.url; }
        else { menu.dataset.song = songBtn.dataset.add; }
        var items = [];
        document.querySelectorAll(".side-pl").forEach(function (el) {
          if (el.dataset.pl !== "0") {
            items.push({ id: el.dataset.pl, name: el.dataset.name });
          }
        });
        menu.innerHTML = '<div class="pm-title">' + (recBtn ? "加入歌单（收藏入库）" : "加入歌单") + "</div>" +
          items.map(function (p) {
            return '<button type="button" class="pm-item" data-pm="' + p.id + '" data-name="' + p.name + '">' +
              '<span class="nm">' + p.name + "</span></button>";
          }).join("") +
          '<button type="button" class="pm-item pm-new" data-new="1">＋ 新建歌单</button>';
        var anchor = recBtn || songBtn;
        var r = anchor.getBoundingClientRect();
        menu.hidden = false;
        var mw = menu.offsetWidth, mh = menu.offsetHeight;
        var left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw));
        var top = r.bottom + 6;
        if (top + mh > window.innerHeight - 8) top = r.top - mh - 6; // 放按钮上方
        top = Math.max(8, Math.min(window.innerHeight - mh - 8, top)); // 目标行在视口外时钳回视口内
        menu.style.left = left + "px";
        menu.style.top = top + "px";
        return;
      }
      var pick = e.target.closest("[data-pm]");
      if (pick && !menu.hidden) {
        var pid = pick.dataset.pm, name = pick.dataset.name;
        hide();
        if (menu.dataset.mode === "url") {
          // 推荐卡：收藏入库到所选歌单（转正出池）
          fetch("/web/import", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ url: menu.dataset.url, playlist_id: pid }),
          })
            .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, t: t }; }); })
            .then(function (res) {
              if (!res.ok) { window.__toast(res.t || "加入失败"); return; }
              window.__markCollected && window.__markCollected(menu.dataset.bvid);
              window.__toast("已加入「" + name + "」· B 站收藏夹已同步");
              var card = document.querySelector('.reccard .addto[data-rec="' + menu.dataset.bvid + '"]');
              var rc = card ? card.closest(".reccard") : null;
              if (rc) {
                rc.classList.add("gone");
                setTimeout(function () { if (rc.parentNode) rc.remove(); }, 450);
              }
              if (window.htmx) htmx.trigger(document.body, "refreshSongs");
            })
            .catch(function () { window.__toast("网络错误，请重试"); });
          return;
        }
        var songId = menu.dataset.song;
        fetch("/web/playlists/add-song", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ song_id: songId, playlist_id: pid }),
        })
          .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, t: t }; }); })
          .then(function (res) {
            if (!res.ok) { window.__toast(res.t || "加入失败"); return; }
            window.__toast("已加入「" + name + "」· B 站收藏夹已同步");
            if (window.htmx) {
              htmx.ajax("GET", "/partials/playlists", { target: "#playlists-bar", swap: "innerHTML" });
              htmx.trigger(document.body, "refreshSongs");
            }
          })
          .catch(function () { window.__toast("网络错误，请重试"); });
        return;
      }
      if (e.target.closest("[data-new]")) {
        hide();
        if (window.createPlaylist) createPlaylist();
        return;
      }
      if (!e.target.closest("#pl-menu")) hide();
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
  })();
  // ---------- 移动端 Tab / 搜索圆钮 ----------
  window.mTab = function (name, btn) {
    document.body.dataset.mtab = name;
    document.querySelectorAll(".m-tab").forEach(function (b) {
      b.classList.toggle("on", b === btn);
    });
    if (name === "home" && $("app").dataset.view === "detail") goHome();
    if (mainEl) mainEl.scrollTop = 0;
  };
  window.orbSearch = function (e) {
    if (e) e.stopPropagation(); // 防止开启搜索的这次点击冒泡到 document 触发"点击外部关闭"
    var tb = $("topbar");
    if (!tb) return;
    if (getComputedStyle(tb).display === "none") {
      // 手机端：搜索胶囊从底部圆钮位置向左展开
      tb.classList.add("searching");
      document.body.classList.add("msearching");
      var t = document.querySelector('.m-tab[data-mtab="home"]');
      document.querySelectorAll(".m-tab").forEach(function (b) {
        b.classList.toggle("on", b === t);
      });
      document.body.dataset.mtab = "home";
      setTimeout(function () {
        var s = $("search");
        if (s) { s.focus(); if (s.value.trim()) openMobileDrop(); }
      }, 80);
      return;
    }
    focusSearchBar();
  };
  function openMobileDrop() { var d = $("search-drop"); if (d) d.hidden = false; }

  // 键盘弹起时：搜索胶囊与结果面板跟随可视视口上移，避免被键盘遮住
  (function () {
    var vv = window.visualViewport;
    if (!vv) return;
    vv.addEventListener("resize", function () {
      var tb = $("topbar");
      if (!tb || !tb.classList.contains("searching")) return;
      var overlap = window.innerHeight - vv.height - vv.offsetTop; // 键盘占位高度
      var lift = overlap > 0 ? overlap + 12 : 14;
      tb.style.bottom = lift + "px";
      var d = $("search-drop");
      if (d && !d.hidden) d.style.bottom = (lift + 64) + "px";
    });
  })();

  // ---------- 队列 / 歌词 按钮视觉态 ----------
  (function () {
    var bq = $("btn-queue");
    if (bq) {
      bq.addEventListener("click", function () {
        var qp = $("queue-panel");
        bq.classList.toggle("on", qp && !qp.classList.contains("hidden"));
      });
    }
  })();

  // ---------- 收藏任务浮片：完成态（已收藏/失败）只短暂提示，不常驻 ----------
  (function () {
    var TOAST_MS = 5200, MAX = 40;
    var toasted = {};
    try { toasted = JSON.parse(sessionStorage.getItem("bmToastedTasks") || "{}") || {}; } catch (e) { toasted = {}; }
    var persist = function () {
      try { sessionStorage.setItem("bmToastedTasks", JSON.stringify(toasted)); } catch (e) {}
    };
    var sweep = function () {
      var rows = document.querySelectorAll("#task-list .task[data-tid]");
      rows.forEach(function (row) {
        var id = row.dataset.tid;
        var finished = row.classList.contains("st-ready") || row.classList.contains("st-failed");
        if (!finished) return; // 进行中（下载/解析）的常驻显示
        if (toasted[id]) { row.remove(); return; } // 提示过一次：不再出现
        toasted[id] = 1;
        setTimeout(function () {
          var el = document.querySelector('#task-list .task[data-tid="' + id + '"]');
          if (!el) return;
          el.classList.add("bye");
          setTimeout(function () { if (el.parentNode) el.remove(); }, 450);
        }, TOAST_MS);
      });
      var keys = Object.keys(toasted);
      if (keys.length > MAX) {
        keys.slice(0, keys.length - MAX).forEach(function (k) { delete toasted[k]; });
      }
      persist();
    };
    document.body.addEventListener("htmx:afterSwap", function (e) {
      if (e.target && e.target.id === "task-list") sweep();
    });
  })();

  // ---------- 智能过渡 / 单曲循环 开关样式联动 ----------
  document.querySelectorAll(".smart-toggle input").forEach(function (box) {
    var sync = function () {
      box.closest(".smart-toggle").classList.toggle("checked", box.checked);
    };
    box.addEventListener("change", sync);
    sync();
  });
})();
