/* BiliMusic v3 交互层：视图/主题/侧栏拖宽/链接收藏/移动端 Tab（依赖 app.js 全局） */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  // Tauri 桌面端（#20/#24）：macOS Overlay 标题栏——红绿灯由系统画。
  // 拖动改由 Tauri 内置的 data-tauri-drag-region 处理（见 base.html 的 #topbar 与 .tb-drag），
  // 这里只负责给 macOS 加 html.tauri —— CSS 侧栏顶部 40px 让位依赖它。
  (function () {
    var api = window.__TAURI__ && window.__TAURI__.window;
    if (!api || !api.getCurrentWindow) return;
    // 侧栏顶部 40px 让位只对 macOS Overlay 标题栏有意义；Windows/Linux 保留系统装饰，不额外留白。
    if (/Mac OS X|Macintosh/.test(navigator.userAgent || "")) {
      document.documentElement.classList.add("tauri");
    }
  }());

  // ---------- 主题（深/浅切换：顶栏圆钮 / 侧栏设置弹层 / 手机账号 Tab 三处入口共享） ----------
  // 未手动选择过就跟随系统：localStorage 里没有显式 bmTheme 时实时跟随 prefers-color-scheme，
  // 系统深浅切换（含日落自动切换）立即生效。只在用户真正点切换时才落盘——
  // 旧版启动即写 localStorage，把第一次检测到的系统偏好「冻死」在本地，此后永不跟随（用户反馈）。
  var systemDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  // 显式选择存独立 key：旧版启动即写 bmTheme，人人都有存量值，读它等于永远 pinned；
  // 换新 key 让所有老用户自然回到「跟随系统」，存量 bmTheme 弃用。
  function storedTheme() {
    try { return localStorage.getItem("bmThemeChoice") || ""; } catch (e) { return ""; }
  }
  var setTheme = function (t, persist) {
    document.documentElement.dataset.theme = t;
    if (persist) {
      try { localStorage.setItem("bmThemeChoice", t); } catch (e) {}
    }
    // 原生壳跟随：系统栏图标明暗（#2 方案 B；桌面/浏览器无此桥自动跳过）
    try { if (window.BiliMusicNative && BiliMusicNative.setTheme) BiliMusicNative.setTheme(t); } catch (e) {}
    var lt = $("light-toggle");
    if (lt) lt.checked = t === "light";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "light" ? "#f0f1f5" : "#0b0b10");
    var sub = $("theme-mode-sub");
    if (sub) sub.textContent = t === "light" ? "当前 · 浅色" : "当前 · 深色";
  };
  // 显式存储（light/dark）优先；否则按系统当前偏好。persist 只在用户主动操作时为 true。
  var applyTheme = function (persist) {
    var saved = storedTheme();
    var t = saved === "light" || saved === "dark" ? saved : (systemDark && systemDark.matches ? "dark" : "light");
    setTheme(t, persist);
  };
  window.toggleTheme = function () {
    setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light", true);
  };
  var lightToggle = $("light-toggle");
  if (lightToggle) {
    lightToggle.addEventListener("change", function () {
      setTheme(lightToggle.checked ? "light" : "dark", true);
    });
  }
  if (systemDark && systemDark.addEventListener) {
    systemDark.addEventListener("change", function () { applyTheme(false); });
  }
  applyTheme(false);

  // ---------- 侧栏主导航：首页=返回主页；推荐=推荐视图；其余跳转待用户指定 ----------
  window.navGo = function (btn) {
    var nav = btn.dataset.nav;
    if (nav === "home") {
      if (window.goHome) goHome();
    } else if (nav === "recommend") {
      collapseOverlays();
      $("app").dataset.view = "recommend";
      document.body.classList.remove("in-detail");
      if (window.switchView) switchView("recommend");
      if (mainEl) mainEl.scrollTop = 0;
    } else if (nav === "up") {
      collapseOverlays();
      $("app").dataset.view = "up";
      document.body.classList.remove("in-detail");
      if (window.switchView) switchView("up");
      if (mainEl) mainEl.scrollTop = 0;
    } else {
      return; // 未接行为的导航项
    }
    document.querySelectorAll(".side-nav .side-item").forEach(function (b) {
      b.classList.toggle("on", b === btn);
    });
  };

  // ---------- UP 主视图：左列表（拼音排序/头像懒解析）+ 右详情 ----------
  function escUp(s) {
    return String(s || "").replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function sortUpRows() {
    var box = $("upv-rows");
    if (!box) return;
    var rows = Array.prototype.slice.call(box.querySelectorAll(".upv-row"));
    rows.sort(function (a, b) {
      try { return a.dataset.artist.localeCompare(b.dataset.artist, "zh-Hans-CN"); }
      catch (e) { return a.dataset.artist.localeCompare(b.dataset.artist); }
    });
    rows.forEach(function (r) { box.appendChild(r); });
  }
  document.body.addEventListener("htmx:afterSwap", function (e) {
    if (e.target.id === "upv-rows") { sortUpRows(); renderUpAvatars(); }
  });

  function upFaceCache() {
    try { return JSON.parse(sessionStorage.getItem("bmUpFaces") || "{}"); } catch (e) { return {}; }
  }
  // 列表头像立即全量渲染：逐行解析（bvid → face），命中期内缓存跳过请求；失败保留渐变字头占位
  async function renderUpAvatars() {
    var rows = document.querySelectorAll("#upv-rows .upv-row");
    var cache = upFaceCache();
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var name = row.dataset.artist, bvid = row.dataset.bvid;
      var ava = row.querySelector(".upv-ava");
      if (!ava || ava.dataset.done) continue;
      var info = cache[name];
      if (!info && bvid) {
        try {
          var r = await fetch("/web/up/resolve?bvid=" + encodeURIComponent(bvid));
          if (r.ok) {
            info = await r.json();
            cache = upFaceCache();
            cache[name] = info;
            try { sessionStorage.setItem("bmUpFaces", JSON.stringify(cache)); } catch (e) {}
          }
        } catch (e) {}
      }
      ava.dataset.done = "1";
      if (info && info.face) {
        ava.innerHTML = '<img src="' + escUp(info.face) + '" alt="" referrerpolicy="no-referrer">';
      }
    }
  }
  document.addEventListener("click", function (e) {
    var row = e.target.closest("#upv-rows .upv-row");
    if (row) window.selectUpArtist(row);
  });

  window.selectUpArtist = async function (row) {
    document.querySelectorAll("#upv-rows .upv-row").forEach(function (b) {
      b.classList.toggle("on", b === row);
    });
    var name = row.dataset.artist, bvid = row.dataset.bvid, count = row.dataset.count;
    var main = $("upv-main");
    if (!main) return;
    main.innerHTML = '<div class="empty">加载中…</div>';
    // 头像懒解析（bvid → face），sessionStorage 按 UP 名缓存；列表头像已由 renderUpAvatars 预热
    var info = upFaceCache()[name];
    if (!info && bvid) {
      try {
        var r = await fetch("/web/up/resolve?bvid=" + encodeURIComponent(bvid));
        if (r.ok) {
          info = await r.json();
          var cache = upFaceCache();
          cache[name] = info;
          try { sessionStorage.setItem("bmUpFaces", JSON.stringify(cache)); } catch (e) {}
        }
      } catch (e) {}
    }
    var face = info ? info.face || "" : "";
    var hue = info ? info.hue : null;
    var avaHtml = face
      ? '<img class="upv-face" src="' + escUp(face) + '" alt="" referrerpolicy="no-referrer">'
      : '<div class="upv-face"></div>';
    main.innerHTML =
      '<div class="upv-head"' + (hue ? ' style="--uph:' + hue + '"' : "") + ">" + avaHtml +
      '<div><div class="upv-title" id="upv-title" title="查看 UP 主作品页">' + escUp(name) + "</div>" +
      '<div class="upv-meta">' + escUp(count) + " 首 · 收藏的歌曲</div></div></div>" +
      // #43：PC 端这一栏只要「歌名 + 收藏」，表头跟着收窄（手机端维持原样）
      (window.matchMedia("(min-width: 901px)").matches
        ? '<div class="list-head list-head-mini"><span></span><span>歌名</span><span class="r">收藏</span></div>'
        : '<div class="list-head"><span style="text-align:center">#</span><span></span><span>标题</span><span>歌单</span><span>音质</span><span class="r">时长</span><span></span></div>') +
      '<div id="upv-songs"></div>';
    var titleEl = $("upv-title"); // 点姓名 → 打开该 UP 主的沉浸式作品页（复用 openUp）
    if (titleEl && bvid && window.openUp) {
      titleEl.addEventListener("click", function () { openUp(bvid); });
    }
    // 行头像回填（列表里的占位字头换成真头像）
    var ava = row.querySelector(".upv-ava");
    if (face && ava && !ava.querySelector("img")) {
      ava.innerHTML = '<img src="' + escUp(face) + '" alt="" referrerpolicy="no-referrer">';
    }
    if (window.htmx) {
      htmx.ajax("GET", "/partials/songs?artist=" + encodeURIComponent(name) +
        (window.matchMedia("(min-width: 901px)").matches ? "&compact=1" : ""), {
        target: "#upv-songs", swap: "innerHTML",
      });
    }
  };

  var mainEl = $("mainEl");

  // 详情页滚动时淡出面包屑（dt-top 已透明，避免文字与曲目行重叠）
  if (mainEl) {
    mainEl.addEventListener("scroll", function () {
      mainEl.classList.toggle("scrolled", mainEl.scrollTop > 64);
    }, { passive: true });

    // 移动端主页/曲库顶部下拉刷新；详情、弹层和输入控件不抢占手势。
    var pullStartY = 0, pullDistance = 0, pulling = false, refreshing = false;
    var pullIndicator = document.createElement("div");
    pullIndicator.className = "pull-refresh-indicator";
    pullIndicator.setAttribute("aria-live", "polite");
    pullIndicator.textContent = "下拉刷新";
    mainEl.prepend(pullIndicator);
    function pullEnabled(target) {
      var view = $("app").dataset.view;
      return window.matchMedia("(pointer: coarse)").matches &&
        (view === "home" || view === "library") && !document.body.classList.contains("in-detail") &&
        !target.closest("input,textarea,select,button,[contenteditable=true]");
    }
    mainEl.addEventListener("touchstart", function (e) {
      if (mainEl.scrollTop !== 0 || !e.touches[0] || !pullEnabled(e.target)) return;
      pullStartY = e.touches[0].clientY; pullDistance = 0; pulling = true;
    }, { passive: true });
    mainEl.addEventListener("touchmove", function (e) {
      if (!pulling || !e.touches[0]) return;
      pullDistance = Math.max(0, Math.min(96, e.touches[0].clientY - pullStartY));
      pullIndicator.style.setProperty("--pull-distance", pullDistance + "px");
      pullIndicator.classList.toggle("ready", pullDistance >= 64);
      if (pullDistance > 8 && e.cancelable) e.preventDefault();
    }, { passive: false });
    mainEl.addEventListener("touchend", function () {
      if (!pulling) return;
      pulling = false;
      if (pullDistance >= 64 && !refreshing) {
        refreshing = true; pullIndicator.classList.add("loading"); pullIndicator.textContent = "正在刷新…";
        if (window.htmx) htmx.trigger(document.body, "refreshSongs");
        setTimeout(function () {
          refreshing = false; pullIndicator.classList.remove("loading", "ready");
          pullIndicator.style.removeProperty("--pull-distance"); pullIndicator.textContent = "下拉刷新";
        }, 900);
      } else {
        pullIndicator.classList.remove("ready"); pullIndicator.style.removeProperty("--pull-distance");
      }
      pullDistance = 0;
    }, { passive: true });
  }

  // ---------- 侧栏拖宽（仅桌面有意义；范围 200–420） ----------
  (function () {
    var handle = $("side-handle"), app = $("app");
    if (!handle || !app) return;
    var sidebar = handle.closest(".sidebar");
    var dragging = false;
    function setWidth(width) {
      var w = Math.min(420, Math.max(200, width));
      // 放在 html 上，让主区与全屏覆盖层沿用同一侧栏宽度。
      document.documentElement.style.setProperty("--side", w + "px");
      handle.setAttribute("aria-valuenow", String(Math.round(w)));
    }
    handle.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      if (sidebar) sidebar.classList.add("is-resizing");
      handle.setPointerCapture(e.pointerId);
      document.body.style.cursor = "col-resize";
    });
    handle.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      setWidth(e.clientX);
    });
    var up = function () {
      dragging = false;
      if (sidebar) sidebar.classList.remove("is-resizing");
      document.body.style.cursor = "";
    };
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    handle.addEventListener("lostpointercapture", up);
    handle.addEventListener("keydown", function (e) {
      if (!sidebar || ["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(e.key) === -1) return;
      e.preventDefault();
      var width = sidebar.getBoundingClientRect().width;
      setWidth(e.key === "Home" ? 200 : e.key === "End" ? 420 : width + (e.key === "ArrowRight" ? 8 : -8));
    });
  })();

  // ---------- 用户设置弹层（侧栏点头像：外观/同步/退出登录）；未登录则弹登录窗 ----------
  (function () {
    var btn = $("side-user-btn"), pop = $("user-pop");
    var host = btn && btn.closest(".side-user");
    if (!btn || !pop || !host) return;
    btn.addEventListener("click", function (e) {
      if (document.body.dataset.auth === "0") {
        e.stopImmediatePropagation();
        if (window.openLogin) openLogin();
        return;
      }
    }, true);
    var setOpen = function (v) {
      host.classList.toggle("pop-open", v);
      btn.setAttribute("aria-expanded", String(v));
    };
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(!host.classList.contains("pop-open"));
    });
    pop.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".user-pop")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });
    // #41 退出登录：桌面侧栏弹层与手机账号页共用一份逻辑（带二次确认，避免误触清掉凭据）
    window.logoutNow = function () {
      var ask = window.__confirmModal
        ? window.__confirmModal("退出登录", "本机保存的 B 站凭据会被清除。曲库仍在 B 站收藏夹里，重新登录即可同步回来。")
        : Promise.resolve(window.confirm("退出登录？"));
      ask.then(function (ok) {
        if (!ok) return;
        fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
          .then(function () { location.href = "/"; });
      });
    };
    var sync = $("side-sync"), quit = $("side-logout");
    if (sync) sync.addEventListener("click", function () { setOpen(false); syncNow(); });
    if (quit) quit.addEventListener("click", function () { setOpen(false); window.logoutNow(); });
  })();

  // ---------- 导航 ----------
  function collapseOverlays() {
    var up = $("up-panel"), ly = $("lyrics-panel");
    if (up) window.__hidePanel(up);
    if (ly) { window.__hidePanel(ly); ly.classList.remove("showlyrics"); var bl = $("btn-lyrics"); if (bl) bl.classList.remove("on"); }
  }

  // 主页 htmx 区段兜底重拉（幂等：仅容器空时拉，#17——隐藏期间 load/revealed 触发器可能没跑过）
  function rehydrateHome() {
    if (!window.htmx) return;
    [
      ["recpl-rack", "/partials/rec-playlists"],
      ["recent-rack", "/partials/recent"],
      ["genre-shelves", "/partials/genre-shelves"],
    ].forEach(function (it) {
      var box = $(it[0]);
      if (box && !box.children.length) {
        htmx.ajax("GET", it[1], { target: "#" + it[0], swap: "innerHTML" });
      }
    });
  }

  // 详情态统一出口（#17）：view 还原 home、清 detail 标记；Tab 切换共用（未在详情态时空操作）
  // #34：关闭详情页时按来源回到原视图（从「资料库」进的歌单详情，返回应回资料库而不是主页）
  window.closeDetailTo = function () {
    if ($("app").dataset.view === "detail" && detailOrigin === "library") {
      $("app").dataset.view = "library";
      document.body.classList.remove("in-detail");
      if (window.switchView) switchView("library");
      var nav = document.querySelector('.m-tab[data-mtab="library"]');
      if (nav) {
        document.querySelectorAll(".m-tab").forEach(function (b) { b.classList.toggle("on", b === nav); });
      }
      return;
    }
    if (window.goHome) goHome();
  };

  // #34：手机端「资料库」Tab —— 列出所有歌单（复用 /partials/playlists 片段）
  window.openLibraryTab = function () {
    collapseOverlays();
    $("app").dataset.view = "library";
    document.body.classList.remove("in-detail");
    if (window.switchView) switchView("library");
    var box = $("mlib-pls");
    if (box && !box.children.length && window.htmx) {
      htmx.ajax("GET", "/partials/playlists", { target: "#mlib-pls", swap: "innerHTML" });
    }
    if (mainEl) mainEl.scrollTop = 0;
  };

  function closeDetail() {
    // #32：原来只认 "detail"，搜索详情态（data-view="search"）会被整段跳过 → 泛化为「非 home 即退」
    if ($("app").dataset.view === "home") return;
    $("app").dataset.view = "home";
    document.body.classList.remove("in-detail");
    if (window.switchView) switchView("home");
  }
  window.goHome = function () {
    collapseOverlays();
    $("app").dataset.view = "home"; // 无条件回主页：详情/搜索/推荐视图都由此退出
    document.body.classList.remove("in-detail");
    var sr = $("sr-body"); // #32：清掉搜索详情结果，避免退回主页后残留
    if (sr) sr.innerHTML = "";
    if (window.switchView) switchView("home");
    rehydrateHome();
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
  var detailOrigin = "home"; // #34：详情页从哪来（home/library），返回时回到原处而不是一律回主页

  // 侧栏标记正在看的页面；收藏目标仍由 app.js 的歌单选择状态管理。
  // 使用独立的 is-current，避免回到首页后旧歌单继续高亮，或异步刷新后丢失位置。
  function syncSidebar() {
    var app = $("app");
    if (!app) return;
    var view = app.dataset.view;
    var nav = view === "detail" ? (dtState.kind === "rec" ? "recommend" : "") : view;
    if (document.activeElement === $("search")) nav = "search";
    var playlist = nav !== "search" && view === "detail" && dtState.kind === "user" ? String(dtState.id) : null;
    document.querySelectorAll(".side-nav [data-nav]").forEach(function (button) {
      var selected = button.dataset.nav === nav;
      button.classList.toggle("on", selected);
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    document.querySelectorAll("#playlists-bar [data-pl]").forEach(function (button) {
      var selected = playlist !== null && button.dataset.pl === playlist;
      button.classList.toggle("is-current", selected);
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }
  if ($("app") && window.MutationObserver) {
    new MutationObserver(syncSidebar).observe($("app"), { attributes: true, attributeFilter: ["data-view"] });
  }
  if ($("search")) {
    $("search").addEventListener("focus", syncSidebar);
    $("search").addEventListener("blur", syncSidebar);
  }
  document.body.addEventListener("htmx:afterSwap", function (e) {
    if (e.target && e.target.id === "playlists-bar") syncSidebar();
  });
  syncSidebar();

  var albumDetailGeneration = 0;
  document.body.addEventListener("htmx:beforeSwap", function (event) {
    if (!event.detail || !event.detail.target || event.detail.target.id !== "dt-songs") return;
    var path = event.detail.requestConfig && event.detail.requestConfig.path || "";
    if ($("app").dataset.view !== "detail" || dtState.kind === "album") event.detail.shouldSwap = false;
    else if (path.indexOf("/partials/songs?") === 0 && (dtState.kind !== "user" || new URL(path, location.origin).searchParams.get("playlist_id") !== String(dtState.id))) event.detail.shouldSwap = false;
    else if (path.indexOf("/partials/rec-genre-tracks?") === 0 && dtState.kind !== "rec") event.detail.shouldSwap = false;
  });
  function isAlbumDetail(id, generation) {
    return $("app").dataset.view === "detail" && dtState.kind === "album" && dtState.id === String(id) && generation === albumDetailGeneration;
  }
  async function loadAlbumTracks(id, generation) {
    var response = await fetch("/partials/album-tracks?album_id=" + encodeURIComponent(id), { cache: "no-store" });
    if (!response.ok) throw new Error("专辑曲目加载失败，请重试");
    var html = await response.text();
    if (!isAlbumDetail(id, generation)) return;
    $("dt-songs").innerHTML = html;
    if (window.htmx) htmx.process($("dt-songs"));
  }
  async function fillAlbumDetail(el) {
    var id = String(el.dataset.album), generation = ++albumDetailGeneration;
    dtState = { kind: "album", id: id, name: el.dataset.name || "专辑" };
    $("app").dataset.view = "detail";
    document.body.classList.add("in-detail");
    $("dt-delete-album").hidden = false;
    $("dt-eyebrow").textContent = "专辑";
    $("dt-title").textContent = dtState.name;
    $("dt-crumb").textContent = "主页 / " + dtState.name;
    $("dt-meta").textContent = "正在加载专辑…";
    var cover = document.querySelector("#dt-hero .dt-cvr");
    cover.classList.remove("mosaic-host"); cover.replaceChildren();
    $("dt-songs").innerHTML = '<div class="empty" role="status">正在加载曲目…</div>';
    if (mainEl) mainEl.scrollTop = 0;
    try {
      var response = await fetch("/api/albums/" + encodeURIComponent(id), { cache: "no-store" });
      if (!response.ok) throw new Error("专辑加载失败，请重试");
      var album = await response.json();
      if (!isAlbumDetail(id, generation)) return;
      var isSeries = album.kind === "series";
      dtState.name = album.title; dtState.bvid = album.sourceBvid || album.bvid; dtState.albumKind = album.kind;
      dtState.shareUrl = album.shareUrl || "";  // #25：后端已拼好的真实 B 站链接（系列缺 mid 时为空）
      $("dt-title").textContent = album.title;
      $("dt-crumb").textContent = "主页 / " + album.title;
      $("dt-eyebrow").textContent = isSeries ? "合集" : "专辑";
      $("dt-meta").textContent = album.artist + " · " + album.totalPages + (isSeries ? " 个作品" : " 首 · 按分 P 顺序");
      var img = document.createElement("img"); img.src = album.coverUrl; img.alt = ""; img.referrerPolicy = "no-referrer";
      cover.classList.add("album-cover"); cover.replaceChildren(img);
      await loadAlbumTracks(id, generation);
    } catch (error) {
      if (!isAlbumDetail(id, generation)) return;
      $("dt-meta").textContent = "专辑暂时无法加载";
      $("dt-songs").innerHTML = '<div class="empty" role="alert">专辑加载失败。<button class="btn-share" type="button" onclick="retryAlbumDetail()">重试</button></div>';
    }
  }
  window.retryAlbumDetail = function () { if (dtState.kind === "album") fillAlbumDetail({ dataset: { album: dtState.id, name: dtState.name } }); };
  window.loadMoreAlbum = async function (button) {
    if (dtState.kind !== "album") return;
    var id = dtState.id, generation = albumDetailGeneration;
    button.disabled = true; button.textContent = "正在加载…";
    try {
      var response = await fetch("/api/albums/" + encodeURIComponent(id) + "/materialize", { method: "POST" });
      if (!response.ok) throw new Error("加载失败");
      await loadAlbumTracks(id, generation);
    } catch (error) {
      if (isAlbumDetail(id, generation)) { button.disabled = false; button.textContent = "加载失败，点击重试"; }
    }
  };
  window.deleteDetailAlbum = async function () {
    if (dtState.kind !== "album") return;
    var id = dtState.id, generation = albumDetailGeneration;
    var isSeries = dtState.albumKind === "series";
    var confirmed = await window.__confirmModal(
      (isSeries ? "删除合集「" : "删除专辑「") + dtState.name + "」？",
      isSeries
        ? "将取消这些视频的 B 站收藏（失败会稍后自动重试），并删除整个合集容器及其本地曲目。"
        : "将取消这个视频的 B 站收藏，并删除整张专辑及其本地曲目。仅移除一首歌请使用曲目行的隐藏按钮。"
    );
    if (!confirmed) return;
    try {
      var response = await fetch("/api/albums/" + encodeURIComponent(id), { method: "DELETE" });
      if (!response.ok) throw new Error("删除失败，专辑仍保留，请重试");
      if (isAlbumDetail(id, generation)) goHome();
      if (window.htmx) htmx.trigger(document.body, "refreshSongs");
    } catch (error) { window.__toast(error.message); }
  };

  function fillUserDetail(el) {
    $("dt-delete-album").hidden = true;
    document.querySelector("#dt-hero .dt-cvr").classList.remove("album-cover");
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
    document.getElementById("dt-crumb").textContent = (detailOrigin === "library" ? "资料库 / " : "主页 / ") + d.name;
    // 封面：取歌单内真实视频封面做艺术化拼贴（无封面/请求失败回退渐变底）
    var cvr0 = document.querySelector("#dt-hero .dt-cvr");
    if (cvr0) { cvr0.classList.remove("mosaic-host"); cvr0.innerHTML = ""; }
    fetch("/api/playlists/" + encodeURIComponent(d.pl) + "/covers")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.covers) || !data.covers.length) return;
        if ($("app").dataset.view !== "detail" || dtState.kind !== "user" || dtState.id !== d.pl) return; // 请求期间已切走
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
    // v0.5.0：曲库（全部歌曲 / 我的曲库默认歌单）按 B 站收藏夹口径，
    // 列表里也把多 P「合集」容器列出来（否则计数对上了、内容对不上）
    var collBox = document.getElementById("dt-collections");
    if (collBox) {
      var isCollection = d.pl === "0" || d.default === "1";
      collBox.hidden = !isCollection;
      if (isCollection && window.htmx) {
        htmx.ajax("GET", "/partials/albums", { target: "#dt-albums", swap: "innerHTML" });
      } else {
        var dtAlbums = document.getElementById("dt-albums");
        if (dtAlbums) dtAlbums.innerHTML = "";
      }
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
    $("dt-delete-album").hidden = true;
    document.querySelector("#dt-hero .dt-cvr").classList.remove("album-cover");
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
    detailOrigin = $("app").dataset.view === "library" ? "library" : "home"; // #34：记来源
    if (el.dataset.album !== undefined) { fillAlbumDetail(el); return; }
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
    if (dtState.kind === "album") { window.__toast("正在准备整张专辑播放队列…"); BiliPlayer.playAlbum(dtState.id); return; }
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
  // v2.1 A5：详情页「电台」＝打开漫游电台并从当前详情第一首开始播；队列见底自动按种子续
  window.playDetailRadio = function () {
    try { localStorage.setItem("bmRadio", "1"); } catch (e) {}
    if (window.__syncQueuePills) window.__syncQueuePills();
    window.playDetailFirst();
  };
  // 分享该歌单/专辑/合集：真实 B 站链接（#25 统一走 __share 的降级链：原生面板 → 系统分享 → 复制 → 弹窗）
  window.shareDetail = function () {
    if (dtState.kind === "album") {
      var kindLabel = dtState.albumKind === "series" ? "合集" : "专辑";
      if (dtState.shareUrl) {
        window.__share({ title: dtState.name, text: kindLabel + "「" + dtState.name + "」", url: dtState.shareUrl });
        return;
      }
      // 系列合集缺 mid 时 shareUrl 为空：让后端反查来源 UP 再拼链接
      fetch("/api/albums/" + String(dtState.id) + "/share-link")
        .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, t: t }; }); })
        .then(function (res) {
          var data = null;
          try { data = JSON.parse(res.t); } catch (e) {}
          if (!res.ok || !data || !data.link) {
            window.__toast((data && data.detail) || "拿不到分享链接");
            return;
          }
          window.__share({ title: dtState.name, text: kindLabel + "「" + dtState.name + "」", url: data.link });
        })
        .catch(function () { window.__toast("网络错误，请重试"); });
      return;
    }
    if (dtState.kind === "rec") { window.__toast("线上推荐歌单不支持分享"); return; }
    fetch("/api/playlists/" + String(dtState.id) + "/share-link")
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, t: t }; }); })
      .then(function (res) {
        var data = null;
        try { data = JSON.parse(res.t); } catch (e) {}
        if (!res.ok) { window.__toast((data && data.detail) || "获取分享链接失败"); return; }
        var link = (data && data.link) || "";
        if (!link) { window.__toast("这个歌单还没有可分享的链接"); return; }
        var extra = (data && data.folderCount > 1) ? "（共 " + data.folderCount + " 夹，链接为首夹）" : "";
        window.__share({
          title: (data && data.name) || dtState.name,
          text: "歌单「" + ((data && data.name) || dtState.name) + "」" + extra,
          url: link,
        });
      })
      .catch(function () { window.__toast("网络错误，请重试"); });
  };

  // 推荐行点击 → 实时流试听（胶囊接管）；同列表的歌组成试听队列（上一首/下一首在队列内切换）
  window.__trialQueue = null;
  window.playRecRow = function (row) {
    if (!window.playStream) return;
    var scope = row.closest(
      ".rack,.tracklist,.dc-track,.sr-grid,.rec-grid,.up-songs,.up-videos,#history-rack,#sd-web"
    ) || row.parentElement;
    if (scope) {
      var items = [], seen = {};
      scope.querySelectorAll("[data-bvid]").forEach(function (el) {
        if (!el.dataset.bvid || seen[el.dataset.bvid]) return;
        seen[el.dataset.bvid] = 1;
        var im2 = el.querySelector("img");
        items.push({
          bvid: el.dataset.bvid,
          title: (el.querySelector(".t1,.sd-t") || {}).textContent || el.title || "",
          artist: el.dataset.artist || (el.querySelector(".t2") || {}).textContent || "",
          cover: im2 ? im2.src : "",
        });
      });
      for (var qi = 0; qi < items.length; qi++) {
        if (items[qi].bvid === row.dataset.bvid) { window.__trialQueue = { items: items, i: qi }; break; }
      }
    }
    var img = row.querySelector("img");
    window.playStream(row.dataset.bvid, {
      title: (row.querySelector(".t1,.sd-t") || {}).textContent || "",
      artist: row.dataset.artist || (row.querySelector(".t2") || {}).textContent || "",
      cover: img ? img.src : "",
    }, null);
  };

  // 歌单增删改后：刷新侧栏；正在看的用户歌单没了就回主页（推荐歌单详情不受影响）
  document.body.addEventListener("playlistsChanged", function () {
    if ($("app").dataset.view !== "detail" || dtState.kind !== "user") return;
    var el = document.querySelector('.side-pl[data-pl="' + dtState.id + '"]');
    if (el) fillUserDetail(el);
    else goHome();
  });

  // ---------- 轻提示已停用：全部操作反馈不再弹胶囊，调用点保留为空实现 ----------
  window.__toast = function () {};

  // ---------- 界面切换过渡：覆盖层开（淡入上浮）/ 关（淡出后隐藏） ----------
  // #30：UP 详情页全屏不透明层会盖住底部 dock；`:has()` 在 minSdk 26 的老 WebView 里整条被丢弃，
  //      所以用 body.up-open 这个显式 class 兜底（CSS 里两套规则都写）。
  function syncUpOpen() {
    var up = $("up-panel");
    document.body.classList.toggle("up-open", !!up && !up.classList.contains("hidden"));
  }
  window.__showPanel = function (el) {
    if (!el) return;
    el.classList.remove("hidden", "closing");
    el.classList.add("opening");
    if (el.id === "up-panel") syncUpOpen();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.remove("opening"); });
    });
  };
  window.__hidePanel = function (el) {
    if (!el || el.classList.contains("hidden")) return;
    if (el.id === "lyrics-panel" && window.__resetQueueView) window.__resetQueueView(); // 关歌词页复位队列视图
    el.classList.add("closing");
    var ms = el.id === "lyrics-panel" ? 420 : 300; // 歌词页推拉动画更长，等它播完再隐藏
    setTimeout(function () {
      el.classList.add("hidden");
      el.classList.remove("closing");
      if (el.id === "up-panel") syncUpOpen(); // 动画结束再降回 dock
    }, ms);
  };

  // ---------- UP 主作品页（Apple Music 沉浸式艺术家页） ----------
  window.openUp = async function (bvid) {
    if (!bvid) return;
    await __resolveUp("/web/up/resolve?bvid=" + encodeURIComponent(bvid));
  };
  window.openUpByMid = async function (mid, name) {
    if (!mid) return;
    await __resolveUp("/web/up/resolve?mid=" + encodeURIComponent(mid));
  };
  async function __resolveUp(url) {
    var p = $("up-panel");
    if (!p) return;
    // 歌词页还开着时进 UP 页：先收歌词页（其全屏沉浸态会隐藏侧栏，且面板层级在 UP 之下）
    var ly = $("lyrics-panel");
    if (ly && !ly.classList.contains("hidden")) {
      window.__hidePanel(ly);
      var bl = $("btn-lyrics");
      if (bl) bl.classList.remove("on");
    }
    try {
      var r = await fetch(url);
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
  }
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
      var upName = ($("up-name") || {}).textContent || "";
      window.__share({ title: upName || "UP 主页", text: upName ? upName + " 的 B 站主页" : "", url: link });
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
      // #29 第二轮：串流态播放条上写的是「远端那首」的作者 → 点开也得是那首的 up 主页
      if (window.BiliBarMirror && BiliBarMirror.isOn && BiliBarMirror.isOn()) {
        var ms = BiliBarMirror.song ? BiliBarMirror.song() : null;
        if (ms && ms.bvid) { openUp(ms.bvid); return; }
      }
      var t = window.BiliPlayer && BiliPlayer.trialInfo ? BiliPlayer.trialInfo() : null;
      var s = window.BiliPlayer && BiliPlayer.currentSong ? BiliPlayer.currentSong() : null;
      var bvid = t ? t.bvid : (s ? s.bvid : null);
      if (bvid) openUp(bvid); else window.__toast("当前没有播放的歌");
    }
    // 歌词页顶栏 / 播放条 / 手机播放页大封面下的 UP 名，点它进 UP 主页（#38 补上第三种）
    ["lyrics-artist", "player-artist", "ly-artist-big"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("click", upFromPlayer);
    });
  })();

  // ---------- 已收藏状态：播放条星星（灰=未收藏，粉=已在曲库）；#33 点已收藏 = 取消收藏 ----------
  // #44：收藏按「bvid + cid」记，**不能只按 bvid** —— 多分 P 视频里每个分集是不同歌曲，
  // 只按 bvid 记会让「收藏了第 3 分集」把同视频的第 7 分集也点亮（用户实测报的 bug）。
  var collected = {}, collectedIds = {};
  function songKey(bvid, cid) { return String(bvid || "") + ":" + String(cid || 0); }
  function currentRef() {
    var t = window.BiliPlayer && BiliPlayer.trialInfo ? BiliPlayer.trialInfo() : null;
    if (t && t.bvid) return { bvid: t.bvid, cid: 0, id: 0 };   // 试听/推荐流：没有本地曲库行
    var s = window.BiliPlayer && BiliPlayer.currentSong ? BiliPlayer.currentSong() : null;
    return s && s.bvid ? { bvid: s.bvid, cid: s.cid || 0, id: s.id || 0 } : null;
  }
  function currentBvid() {
    var r = currentRef();
    return r ? r.bvid : null;
  }
  function currentKey() {
    var r = currentRef();
    return r ? songKey(r.bvid, r.cid) : null;
  }
  function markStar() {
    var k = currentKey();
    var on = !!k && !!collected[k];
    document.querySelectorAll("#btn-star, #ly-star, #ly-star-big").forEach(function (star) {
      star.classList.toggle("on", on);
    });
  }
  function markOne(ref) {
    var k = songKey(ref.bvid, ref.cid);
    collected[k] = 1;
    if (ref.id) collectedIds[k] = ref.id;
    markStar();
  }
  function loadCollected() {
    if (!window.BiliPlayer || !BiliPlayer.songs) return;
    BiliPlayer.songs("").then(function (songs) {
      collected = {};
      collectedIds = {};
      (songs || []).forEach(function (s) {
        if (!s.collected) return; // 以服务端 collected 为准（合集子作品可能未收藏）
        var k = songKey(s.bvid, s.cid);
        collected[k] = 1;
        if (s.id) collectedIds[k] = s.id; // #33：取消收藏要按 song.id 调 DELETE
      });
      markStar();
    }).catch(function () {});
  }
  window.__markCollected = function (bvid, id) {
    // 整视频收藏（发现页收藏卡 / 导入完成）：把当前正在播的同 bvid 那一首一并点亮
    if (bvid) {
      var r = currentRef();
      if (r && r.bvid === bvid) {
        var k = songKey(r.bvid, r.cid);
        collected[k] = 1;
        if (id || r.id) collectedIds[k] = id || r.id;
      }
      collected[songKey(bvid, 0)] = 1; // 试听流（无 cid）也认
      if (id) collectedIds[songKey(bvid, 0)] = id;
    }
    markStar();
  };
  document.body.addEventListener("refreshSongs", loadCollected);
  loadCollected();

  // 取消收藏（v2.0.1 三处入口统一走 /uncollect，服务端按容器分流）：
  // 单视频＝删行并取消 B 站收藏；paged＝仅该行退出曲库（逐分 P 挑歌，B 站与容器不动）；
  // series＝该视频行退出并取消其 B 站收藏。整张专辑的移除走专辑详情页的删除按钮。
  function uncollectCurrent(ref) {
    var key = songKey(ref.bvid, ref.cid);
    var id = collectedIds[key] || ref.id;
    if (!id) { window.__toast("这首还没入库"); return; }
    fetch("/api/songs/" + id + "/uncollect", { method: "POST" })
      .then(function (r) { if (!r.ok) throw new Error("uncollect"); })
      .then(function () {
        delete collected[key];
        delete collectedIds[key];
        markStar();
        window.__toast("已移出曲库");
        if (window.htmx) htmx.trigger(document.body, "refreshSongs");
      })
      .catch(function () { window.__toast("取消收藏失败，请稍后重试"); });
  }

  // 星星点击：未收藏 → 收藏当前播放的歌；已收藏 → 取消收藏（#33 / #44）
  function collectCurrent() {
    var ref = currentRef();
    if (!ref) { window.__toast("当前没有播放的歌"); return; }
    if (collected[songKey(ref.bvid, ref.cid)]) { uncollectCurrent(ref); return; }
    // 曲库内已知行（含合集子作品）：精确认领这一首——多分 P 只收藏当前分集，
    // 不再整视频导入（否则合集子作品永远收藏不上，星点了也没反应）
    if (ref.id) {
      fetch("/api/songs/" + ref.id + "/collect", { method: "POST" })
        .then(function (r) {
          if (!r.ok) throw new Error("collect");
          markOne(ref);
          window.__toast("已收藏 · 已加入我的曲库");
          if (window.htmx) htmx.trigger(document.body, "refreshSongs");
        })
        .catch(function () { window.__toast("收藏失败，请稍后重试"); });
      return;
    }
    fetch("/web/import", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: "https://www.bilibili.com/video/" + ref.bvid, playlist_id: "0" }),
    })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, t: t }; }); })
      .then(function (res) {
        if (!res.ok) { window.__toast("收藏失败，请稍后重试"); return; }
        window.__markCollected(ref.bvid);
        window.__toast("已收藏 · 已同步 B 站收藏夹");
      })
      .catch(function () { window.__toast("网络错误，请重试"); });
  }
  ["btn-star", "ly-star", "ly-star-big"].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener("click", collectCurrent);
  });
  // 切歌（曲库歌 ⇄ 试听流）时歌名变化 → 星星跟随当前歌刷新
  (function () {
    var titleEl = $("player-title");
    if (titleEl && window.MutationObserver) {
      new MutationObserver(markStar).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  })();

  // ---------- #37：搜索结果里的「合集」卡 → 收藏为容器并打开 ----------
  // 已是容器（data-album-id）直接进；否则先 POST /web/collect-album 建容器再进
  document.addEventListener("click", function (e) {
    var card = e.target.closest(".sr-coll");
    if (!card) return;
    e.preventDefault();
    var open = function (albumId, name) {
      window.openDetailFrom({ dataset: { album: String(albumId), name: name || "合集" } });
    };
    if (card.dataset.albumId) { open(card.dataset.albumId, card.dataset.albumName); return; }
    if (card.dataset.busy) return;
    card.dataset.busy = "1";
    card.style.opacity = ".55";
    fetch("/web/collect-album", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "HX-Request": "true" },
      body: new URLSearchParams({ bvid: card.dataset.bvid }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) throw new Error((res.d && res.d.error) || "收藏失败");
        card.dataset.albumId = String(res.d.albumId);
        window.__toast && window.__toast("已收藏为合集 · 点开逐个收藏");
        if (window.htmx) htmx.trigger(document.body, "refreshSongs");
        open(res.d.albumId, res.d.title);
      })
      .catch(function (err) {
        window.__toast && window.__toast((err && err.message) || "收藏失败，请稍后重试");
      })
      .then(function () {
        delete card.dataset.busy;
        card.style.opacity = "";
      });
  }, true);

  // ---------- 搜索下拉：曲库命中（点击即播）+ B 站结果（♥ 收藏） ----------
  (function () {
    var input = $("search"), drop = $("search-drop"), lib = $("sd-lib"), web = $("sd-web");
    if (!input || !drop) return;
    var LINK = /^\s*(https?:\/\/|b23\.|bv|av)/i;
    var timer = null, lastQ = null;

    // 面板贴住搜索框：不再依赖 CSS 里的固定 top（62px 会盖住输入框 9px），
    // 滚动、改窗口、侧栏宽度变化都重新量一次；搜索框滚出视口时面板一并收起，
    // 免得它孤零零钉在页面上、跟输入框脱节。
    var wantOpen = false;

    // #39b：结果面板恒定夹在「播放条」与「搜索胶囊」中间——把播放条顶到面板上方。
    // 面板高度是动态的（结果条数、键盘避让都会变），所以用实测的 rect 反推播放条该抬多高：
    // 播放条底距 = 视口底到面板顶的距离 + 10px 间隙。
    function liftPlayerBar() {
      var pb = $("player-bar");
      if (!pb) return;
      var mobile = document.documentElement.clientWidth <= 900;
      if (!mobile || drop.hidden || !document.body.classList.contains("msearching")) {
        pb.style.bottom = "";
        return;
      }
      var r = drop.getBoundingClientRect();
      if (!r.height || r.top <= 0) { pb.style.bottom = ""; return; }
      // 矮屏 + 键盘同时出现时面板只剩几十像素，这时硬顶会把播放条推到状态栏上，宁可不动
      if (r.height < 180) { pb.style.bottom = ""; return; }
      pb.style.bottom = Math.round(window.innerHeight - r.top + 10) + "px";
    }
    window.__liftPlayerBar = liftPlayerBar;
    if (window.ResizeObserver) new ResizeObserver(function () { liftPlayerBar(); }).observe(drop);

    function place() {
      if (!wantOpen) return;
      if (document.documentElement.clientWidth <= 900) {
        // 手机端是底部胶囊，沿用 CSS 的 bottom 定位
        drop.style.top = ""; drop.style.left = ""; drop.style.width = ""; drop.style.maxHeight = "";
        drop.hidden = false;
        liftPlayerBar();
        return;
      }
      var bar = $("tbSearch") || input;
      var r = bar.getBoundingClientRect();
      if (!r.width) { drop.hidden = true; return; }
      if (r.bottom < 4 || r.top > window.innerHeight - 4) { drop.hidden = true; return; } // 搜索框滚出视口
      drop.hidden = false;
      drop.style.left = r.left + "px";
      drop.style.width = r.width + "px";
      drop.style.top = (r.bottom + 8) + "px";
      drop.style.maxHeight = Math.max(160, Math.min(560, window.innerHeight - r.bottom - 32)) + "px";
    }
    var placeRaf = 0;
    function placeSoon() {
      if (placeRaf) return;
      placeRaf = requestAnimationFrame(function () { placeRaf = 0; place(); });
    }
    var mainScrollEl = $("mainEl");
    if (mainScrollEl) mainScrollEl.addEventListener("scroll", placeSoon, { passive: true });
    window.addEventListener("scroll", placeSoon, { passive: true });
    window.addEventListener("resize", placeSoon);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", placeSoon);

    function open() { wantOpen = true; place(); }
    function close() {
      wantOpen = false;
      drop.hidden = true;
      var tb = $("topbar"); // 手机端：搜索胶囊随关闭一并收起
      if (tb) { tb.classList.remove("searching"); tb.style.bottom = ""; }
      document.body.classList.remove("msearching");
      var d = $("search-drop"); if (d) d.style.bottom = "";
      var pb = $("player-bar"); if (pb) pb.style.bottom = ""; // 播放条落回原位（#39b）
      if (window.__searchBarPortal) window.__searchBarPortal(false); // 胶囊放回 .main
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
      // 系列明链给「收藏为合集」的专门文案（v0.5.0）；短链/其余按视频收藏
      var series = /space\.bilibili\.com\/\d+\/channel\/collectiondetail/i.test(url);
      lib.innerHTML = '<div class="sd-collect">' +
        '<span style="font-size:24px;flex:none">' + (series ? "📚" : "🎬") + '</span>' +
        '<div class="sd-meta"><div class="sd-t">' + (series ? "识别到系列（合集）链接" : "识别到视频链接") + '</div>' +
        '<div class="sd-s">' + (series ? "收藏为合集容器 · 点开逐个收藏" : esc(url)) + '</div></div>' +
        '<button class="sd-go" type="button">' + (series ? "♥ 收藏合集" : "♥ 收藏") + '</button></div>';
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
    // #27 关键：中文输入法组合期间**绝不重渲染下拉**。
    // 旧代码每次 input 都排一个 350ms 的 AJAX；拼音打字间隙一超过 350ms 就会在组合中途
    // 换掉 #sd-lib/#sd-web 的内容，输入法候选随之被打断。改为：组合中只清定时器，组合结束再搜。
    function scheduleSearch() {
      clearTimeout(timer);
      var q = input.value.trim();
      if (!q) {
        // #38：删到空不再关掉搜索态（原来 close() 会把手机端胶囊整个收掉，
        // 用户得重新点底部圆钮）。手机端只清结果、保留面板与焦点；桌面端输入框常驻，仍收起面板。
        lastQ = null;
        lib.innerHTML = '<div class="sd-empty">输入关键词，搜曲库和 B 站</div>';
        web.innerHTML = "";
        if (document.documentElement.clientWidth <= 900) { open(); drop.hidden = false; }
        else { close(); }
      } else {
        open();
        timer = setTimeout(function () { run(q); }, 350);
      }
      syncClose();
    }
    input.addEventListener("input", function (e) {
      if (e.isComposing || imeActive) { clearTimeout(timer); return; }
      scheduleSearch();
    });
    input.addEventListener("compositionend", function () { scheduleSearch(); });
    // 回车 → 搜索详情页（上排 UP 主圆形卡、下方歌曲方形网格）
    input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var q = input.value.trim();
      if (!q) return;
      close();
      input.blur();
      var app = $("app");
      if (!app || !window.htmx) return;
      app.dataset.view = "search";
      if (window.switchView) switchView("search");
      document.body.classList.remove("in-detail");
      var body = $("sr-body");
      if (body) body.innerHTML = '<div class="empty">搜索中…</div>';
      if (mainEl) mainEl.scrollTop = 0;
      htmx.ajax("GET", "/partials/search-detail?q=" + encodeURIComponent(q), { target: "#sr-body", swap: "innerHTML" });
    });
    input.addEventListener("focus", function () {
      if (input.value.trim()) open();
    });
    if (closeBtn) closeBtn.addEventListener("click", function () {
      input.value = "";
      close();
      input.blur();
      syncClose();
      // 搜索详情页点 ✕：清空并返回主页
      if ($("app").dataset.view === "search" && window.goHome) goHome();
    });
    lib.addEventListener("click", function (e) {
      var row = e.target.closest("[data-song]");
      if (row && window.BiliPlayer) { BiliPlayer.playById(Number(row.dataset.song)); close(); }
    });
    // B 站结果：UP 主行进作品页；视频行在线试听（收藏走播放条星星）
    web.addEventListener("click", function (e) {
      var upRow = e.target.closest(".sd-up");
      if (upRow) {
        close();
        if (window.openUpByMid) openUpByMid(upRow.dataset.mid, upRow.dataset.name);
        return;
      }
      var row = e.target.closest(".sd-row");
      if (!row || !row.dataset.bvid || !window.playStream) return;
      window.playRecRow(row);
      close();
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest("#search-drop") && !e.target.closest("#tbSearch")) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
  })();

  // ---------- 音量（双 audio 元素同步；--p 驱动滑条粉色填充；歌词页 ly-vol 双向同步） ----------
  (function () {
    var vol = $("vol"), lyVol = $("ly-vol");
    var apply = function (v) {
      ["audio", "audio2"].forEach(function (id) {
        var el = $(id);
        if (el) el.volume = v;
      });
      // 试听流音量：主音量此前没覆盖 recAudio（试听时调音量无效），这里一并修
      if (window.BiliPlayer && BiliPlayer.activeMedia) {
        var m = BiliPlayer.activeMedia();
        if (m && m.volume !== undefined && m.id !== "audio" && m.id !== "audio2") m.volume = v;
      }
    };
    var syncLy = function (v) {
      if (!lyVol) return;
      lyVol.value = Math.round(v * 100);
    };
    // #19 音量条粉色填充：--p 由 JS 同步（CSS 渐变消费；#vol 旋转后自下而上填充）
    var syncFill = function (el) {
      if (el) el.style.setProperty("--p", el.value + "%");
    };
    syncFill(vol); syncFill(lyVol);
    if (lyVol) syncLy(vol.value / 100);
    vol.addEventListener("input", function () {
      // #27 镜像态：这条音量条 = 在放的那台设备的音量（不是本机的）
      if (window.BiliBarMirror && BiliBarMirror.isOn()) {
        syncFill(vol);
        if (window.__sessionSync) window.__sessionSync.setRemoteVolume(Number(vol.value));
        return;
      }
      var v = vol.value / 100;
      apply(v);
      syncLy(v);
      syncFill(vol); syncFill(lyVol);
    });
    if (lyVol) lyVol.addEventListener("input", function () {
      var v = lyVol.value / 100;
      apply(v);
      syncLy(v);
      syncFill(vol); syncFill(lyVol);
      vol.value = lyVol.value;
    });
  })();

  // ---------- 点封面 → 歌词详情页（曲库歌 / 试听歌都支持） ----------
  (function () {
    var c = $("player-cover"), lc = $("lyrics-cover");
    if (c && window.toggleLyrics) c.addEventListener("click", function () { toggleLyrics(); });
    if (lc && window.BiliPlayer) lc.addEventListener("click", function () {
      // 手机端歌词视图：点顶栏小封面回到大封面视图（封面元素飞回居中）；其余情况维持原"点封面播放/暂停"
      var panel = $("lyrics-panel");
      if (panel.classList.contains("showlyrics") && matchMedia("(max-width: 900px)").matches) {
        goCover($("lyrics-cover")); // 歌词视图点小封面 = 回播放页（无动效）
        return;
      }
      BiliPlayer.toggle();
    });
  })();

  // ---------- 手机端播放页：封面 ↔ 歌词 ↔ 队列 三视图切换（无动效，用户定稿 2026-09-11） ----------
  // v2.1 共享元素封面飞行曾实现后按用户要求整体回退；切换均为瞬时。
  (function () {
    var panel = $("lyrics-panel");
    if (!panel) return;
    // v2.1 三个视图的统一切换：封面飞行追踪 + 状态收口（手机端）
  function queueViewActive() { var qv = $("queue-view"); return !!qv && !qv.hidden; }
  function goCover() { // 任意视图 → 播放页（封面视图）
    panel.classList.remove("showlyrics", "queue-mode");
    var qv = $("queue-view"); if (qv) qv.hidden = true;
    var ls = $("lyrics-scroll"); if (ls) ls.hidden = false;
  }
  function goLyrics() { // 播放页 → 歌词页
    if (panel.classList.contains("hidden")) window.__showPanel(panel); // 桌面直进：面板可能还关着
    panel.classList.add("showlyrics");
    panel.classList.remove("queue-mode");
    var qv = $("queue-view"); if (qv) qv.hidden = true;
    var ls = $("lyrics-scroll"); if (ls) ls.hidden = false;
  }
  function goQueue() { // 任意视图 → 播放列表页
    if (panel.classList.contains("hidden")) window.__showPanel(panel); // 桌面直进：面板可能还关着
    panel.classList.add("showlyrics", "queue-mode");
    var qv = $("queue-view"); if (qv) qv.hidden = false;
    var ls = $("lyrics-scroll"); if (ls) ls.hidden = true;
    if (window.__renderQueueView) window.__renderQueueView();
  }
  window.__goQueueView = goQueue;
  window.__goCoverView = goCover;
  window.__toggleQueueView = function () { queueViewActive() ? goCover($("lyrics-cover")) : goQueue(); };
  var big = $("lyrics-cover-big");
    if (big) big.addEventListener("click", function () { goLyrics(); });
    var small = $("lyrics-cover");
    if (small) small.addEventListener("click", function () {
      if (panel.classList.contains("showlyrics") && matchMedia("(max-width: 900px)").matches) { goCover(small); return; }
      BiliPlayer.toggle();
    });
    var bubble = $("ly-bubble");
    if (bubble) bubble.addEventListener("click", function () {
      if (queueViewActive()) { goCover($("lyrics-cover")); return; } // 队列态 → 播放页（封面飞回）
      panel.classList.contains("showlyrics") ? goCover($("lyrics-cover")) : goLyrics();
    });
    function queueViewActive() { var qv = $("queue-view"); return !!qv && !qv.hidden; }
    // 播放列表：桌面=右侧栏抽屉，手机=播放页内视图（队列态再按 = 回播放页）
    var lq = $("ly-queue");
    if (lq) lq.addEventListener("click", function () {
      if (window.__isDesktop && window.__isDesktop()) { window.__toggleQueueDrawer(); return; }
      if (window.__toggleQueueView) window.__toggleQueueView();
    });
  })();

  // ---------- 歌词页控制条：进度/时间跟随当前媒体（曲库歌或试听流），seek 双向 ----------
  (function () {
    var seekEl = $("ly-seek");
    if (!seekEl || !window.BiliPlayer) return;
    var dragging = false;
    var panelOpen = function () { return !$("lyrics-panel").classList.contains("hidden"); };
    var syncFill = function () { seekEl.style.setProperty("--p", (seekEl.value / 10) + "%"); };
    syncFill();

    setInterval(function () {
      if (!panelOpen()) return;
      if (remote()) return;   // 串流态：进度由远端会话驱动（app.js 的镜像绘制负责），别读本机 audio
      var m = BiliPlayer.activeMedia();
      if (!m || !m.duration || !isFinite(m.duration)) return;
      if (!dragging) {
        seekEl.value = Math.round((m.currentTime / m.duration) * 1000);
        syncFill();
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
      window.__lySeekDragging = true;   // app.js 镜像绘制据此别抢滑条
      syncFill();
      var m = BiliPlayer.activeMedia();
      if (m && m.duration) $("ly-cur").textContent = fmtTime((seekEl.value / 1000) * m.duration);
    });
    seekEl.addEventListener("change", function () {
      if (remote()) {   // 串流态：拖的是远端的进度
        var lv = BiliBarMirror && BiliBarMirror.live ? BiliBarMirror.live() : null;
        if (lv && lv.duration && window.__sessionSync) {
          window.__sessionSync.remoteSeek((seekEl.value / 1000) * lv.duration);
        }
      } else {
        var m = BiliPlayer.activeMedia();
        if (m && m.duration) {
          try { m.currentTime = (seekEl.value / 1000) * m.duration; } catch (e) {}
        }
      }
      syncFill();
      dragging = false;
      window.__lySeekDragging = false;
    });
    // #29 第二轮：串流态下详情页的控制条＝遥控「在放的那台」（本机不出声、不改本机状态）
    var remote = function () { return window.BiliBarMirror && BiliBarMirror.isOn && BiliBarMirror.isOn(); };
    var lt = $("ly-toggle");
    if (lt) lt.addEventListener("click", function () {
      if (remote() && window.__sessionSync) { window.__sessionSync.barAction(); return; }
      BiliPlayer.toggle();
    });
    var lp = $("ly-prev");
    if (lp) lp.addEventListener("click", function () {
      if (remote() && window.__sessionSync) { window.__sessionSync.remoteCommand("prev"); return; }
      BiliPlayer.skip(-1);
    });
    var ln = $("ly-next");
    if (ln) ln.addEventListener("click", function () {
      if (remote() && window.__sessionSync) { window.__sessionSync.remoteCommand("next"); return; }
      BiliPlayer.skip(1);
    });

    // 循环钮：顺序 → 列表循环 → 单曲循环。只管 bmLoop 一条轴——随机与电台在队列面板里各自
    // 独立开关，不再像旧版那样和循环挤在同一个 bmPlayMode 枚举里互相顶掉（引擎见 app.js）。
    var LOOPS = [
      { k: "off", name: "顺序播放" },
      { k: "all", name: "列表循环" },
      { k: "one", name: "单曲循环" },
    ];
    var lm = $("ly-mode"), lsh = $("ly-shuffle");
    var curLoop = function () {
      var cur = localStorage.getItem("bmLoop") || "off";
      return LOOPS.filter(function (x) { return x.k === cur; })[0] || LOOPS[0];
    };
    var toggleAxis = function (kind) {   // app.js 未就绪时兜底：只翻本地开关
      if (window.__togglePlayAxis) { window.__togglePlayAxis(kind); return; }
      if (kind === "shuffle") localStorage.setItem("bmShuffle", localStorage.getItem("bmShuffle") === "1" ? "0" : "1");
      else { var cur = localStorage.getItem("bmLoop") || "off"; localStorage.setItem("bmLoop", cur === "off" ? "all" : (cur === "all" ? "one" : "off")); }
    };
    var applyShuffle = function () {
      if (!lsh) return;
      var on = localStorage.getItem("bmShuffle") === "1";
      lsh.classList.toggle("on", on);
      lsh.setAttribute("aria-pressed", on ? "true" : "false");
      lsh.title = on ? "随机播放：开（点按恢复原顺序）" : "随机播放：关（点按打乱播放顺序）";
    };
    var applyMode = function () {
      if (lm) {
        var m = curLoop();
        lm.title = "循环：" + m.name + (m.k === "off" ? "（点按开启列表循环）" : "（点按切换）");
        lm.classList.toggle("on", m.k !== "off");
        lm.classList.toggle("one", m.k === "one");
      }
      applyShuffle();
    };
    if (lm) lm.addEventListener("click", function () {
      toggleAxis("loop");
      applyMode();
      if (window.__toast) window.__toast("循环模式：" + curLoop().name);
    });
    if (lsh) lsh.addEventListener("click", function () {
      toggleAxis("shuffle");
      applyShuffle();
      if (window.__toast) window.__toast("随机播放：" + (localStorage.getItem("bmShuffle") === "1" ? "开" : "关"));
    });
    applyMode();
    window.__syncLyMode = applyMode; // 队列面板改了循环 / 随机 → 这边跟着刷新

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

    // ··· 详情菜单：加入歌单 / 分享 / 推荐相似歌曲（试听歌无曲库 id，无相似推荐）/ 在 B 站打开
    // 歌词视图顶栏的 ··· 与播放页歌名右侧的 ··· 共用这一份逻辑
    function openSongMenu(anchor) {
      var sm = $("song-menu");
      if (!sm) return;
      var trial = window.BiliPlayer && BiliPlayer.trialInfo();
      var song = trial ? null : (BiliPlayer.currentSong() || null);
      var bvid = trial ? trial.bvid : (song ? song.bvid : null);
      if (!bvid) { window.__toast("当前没有播放的歌"); return; }
      var url = "https://www.bilibili.com/video/" + bvid;
      var items = [
        '<button type="button" class="pm-item" data-act="pl">加入歌单</button>',
        '<button type="button" class="pm-item" data-act="share">分享</button>',
      ];
      if (song) items.push('<button type="button" class="pm-item" data-act="similar">推荐相似歌曲</button>');
      items.push('<button type="button" class="pm-item" data-act="bili">在 B 站打开</button>');
      sm.innerHTML = items.join("");
      sm.hidden = false;
      var r = anchor.getBoundingClientRect();
      var mh = sm.offsetHeight, mw = sm.offsetWidth;
      sm.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + "px";
      sm.style.top = (r.top - mh - 8 > 8 ? r.top - mh - 8 : r.bottom + 8) + "px";
      sm.dataset.bvid = bvid;
      sm.dataset.url = url;
      sm.dataset.trial = trial ? "1" : "";
      sm.dataset.songid = song ? song.id : "";
      // #25：分享时带上歌名/UP 名（分享文本更可读；没有就只发链接）
      sm.dataset.title = (trial ? trial.title : (song ? song.title : "")) || "";
      sm.dataset.artist = (trial ? trial.artist : (song ? song.artist : "")) || "";
    }
    ["ly-more", "ly-more-big"].forEach(function (id) {
      var btn = $(id);
      if (btn) btn.addEventListener("click", function (e) { e.stopPropagation(); openSongMenu(btn); });
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
        var st = sm2.dataset.title || "", sa = sm2.dataset.artist || "";
        // 歌名里常已含 UP 名（「UP - 歌名」），重复就不再拼一遍
        var line = st && sa && st.indexOf(sa) < 0 ? st + " - " + sa : st;
        window.__share({ title: st || "分享一首歌", text: line, url: link });
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
      if (sm && !sm.hidden && !e.target.closest("#song-menu") && !e.target.closest("#ly-more") && !e.target.closest("#ly-more-big")) sm.hidden = true;
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

  // ---------- 空格 = 全局播放/暂停（#8；#27 修 IME 劫持） ----------
  // 输入场景（输入框/可编辑区）与弹窗打开时不接管；capture + preventDefault：
  // 页面不滚动，聚焦按钮也不会被空格误触（统一走播放开关，含试听态）
  // #27：macOS WKWebView 组合态下 isComposing 常为 false、target 也未必是输入框，
  //      只靠这两道判断会吞掉输入法的空格选词 → 再补三重防线（组合标志 / keyCode 229 / activeElement）
  var imeActive = false;
  document.addEventListener("compositionstart", function () { imeActive = true; }, true);
  document.addEventListener("compositionend", function () {
    // 组合结束后仍可能补发一个 keydown（keyCode 229 / 空格选词），延迟一小段再复位
    setTimeout(function () { imeActive = false; }, 60);
  }, true);
  function inEditable(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
  }
  document.addEventListener("keydown", function (e) {
    if (e.key !== " " || !window.BiliPlayer) return;
    if (e.isComposing || e.keyCode === 229 || imeActive) return;
    if (inEditable(e.target) || inEditable(document.activeElement)) return;
    if (e.target && e.target.closest && e.target.closest("#tbSearch, #search-drop")) return;
    // #27 硬保险：搜索下拉开着 = 用户正在搜索（含 WKWebView 组合态下 activeElement 变 body 的情况），不抢空格
    var sd = $("search-drop");
    if (sd && !sd.hidden) return;
    var login = $("login-modal"), modal = $("mini-modal");
    if ((login && !login.classList.contains("hidden")) || (modal && !modal.classList.contains("hidden"))) return;
    e.preventDefault();
    BiliPlayer.toggle();
  }, true);

  // ---------- 任务轮询：仅前台每 2s 拉一次（后台/锁屏零请求，#5） ----------
  // base.html 只保留 load 首拉；后续轮询在这里按可见性驱动
  (function () {
    var box = $("task-list");
    if (!box || !box.hasAttribute("hx-get")) return; // 未登录：任务区不轮询
    var busy = false;
    function poll() {
      if (document.hidden || busy || !window.htmx) return;
      var r = htmx.ajax("GET", "/partials/tasks", { target: "#task-list", swap: "innerHTML" });
      if (r && r.then) {
        busy = true;
        r.then(function () { busy = false; }, function () { busy = false; });
      }
    }
    setInterval(poll, 2000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) poll(); // 回前台立即补一次
    });
  })();

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
    // Tab 切换不压栈且清空已压栈（#1）；任何 Tab 都先退出详情态（#17：原来到不了曲库的根因）
    if (name === "library") { window.openLibraryTab(); return; } // #34：资料库有自己的视图
    goHome();
    if (mainEl) mainEl.scrollTop = 0;
  };
  // #38b：`.main` 带 position:absolute + z-index:0，**自成层叠上下文**，所以搜索胶囊待在
  // .main 里时无论 z-index 写多高，都压不过 .main(0) 之上的 #up-panel(90)——UP 作品页里
  // 表现为「结果面板出来了、搜索框却看不见」。搜索态时把胶囊临时挂到 #app 下（这时它是
  // position:fixed，视觉位置不变，节点搬家不丢事件），关掉搜索再放回 .main 首位。
  window.__searchBarPortal = function (on) {
    var tb = $("topbar"), app = $("app"), main = $("mainEl");
    if (!tb || !app || !main) return;
    if (on) {
      if (tb.parentElement !== app) app.appendChild(tb);
    } else if (tb.parentElement !== main) {
      main.insertBefore(tb, main.firstChild);
    }
  };
  window.orbSearch = function (e) {
    if (e) e.stopPropagation(); // 防止开启搜索的这次点击冒泡到 document 触发"点击外部关闭"
    var tb = $("topbar");
    if (!tb) return;
    if (getComputedStyle(tb).display === "none") {
      // 手机端：搜索胶囊从底部圆钮位置向左展开
      window.__searchBarPortal(true);
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

  // #38 键盘弹起：把输入法占位高度写成 --kb，CSS 里的搜索胶囊/结果面板据此整体上移。
  // 原来只在已进入搜索态时改行内 bottom——结果面板往往是「后出现」的（要等接口返回），
  // 那时早已错过了 resize 事件，于是列表落在键盘下面。改成变量后，谁看谁生效。
  (function () {
    var vv = window.visualViewport;
    if (!vv) return;
    function syncKeyboard() {
      var overlap = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty("--kb", overlap + "px");
      var tb = $("topbar");
      if (tb) tb.style.bottom = ""; // 清掉旧版写法留下的行内值，统一交给 CSS
      var d = $("search-drop");
      if (d) d.style.bottom = "";
      if (window.__liftPlayerBar) window.__liftPlayerBar(); // 键盘一变，面板高度跟着变，播放条要重算（#39b）
    }
    syncKeyboard();
    vv.addEventListener("resize", syncKeyboard);
    vv.addEventListener("scroll", syncKeyboard);
    window.addEventListener("orientationchange", function () { setTimeout(syncKeyboard, 120); });
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

  // 搜索详情页：UP 主圆卡进作品页（歌曲卡 onclick=playRecRow 内联）
  document.addEventListener("click", function (e) {
    var up = e.target.closest(".sr-up");
    if (up && window.openUpByMid) openUpByMid(up.dataset.mid, up.dataset.name);
  });

  // ---------- SSE：曲库变更实时推送（收藏入库完成 / B 站同步删除）----------
  // 后端 /api/events 推 libraryChanged / playlistsChanged → 防抖后自动刷新
  // 各视图（最近收藏架、推荐架、侧栏计数、详情页曲目表），免手动刷新页面。
  if (window.EventSource) {
    var libEs = new EventSource("/api/events");
    var libEsTimer = null;
    var libRefresh = function () {
      clearTimeout(libEsTimer);
      libEsTimer = setTimeout(function () {
        if (!window.htmx) return;
        htmx.trigger(document.body, "refreshSongs"); // 最近收藏/推荐架/播放队列/已收藏心
        htmx.ajax("GET", "/partials/playlists", { target: "#playlists-bar", swap: "innerHTML" });
        if ($("app").dataset.view === "detail" && dtState.kind === "user" && dtState.id !== "0") {
          htmx.ajax("GET", "/partials/songs?playlist_id=" + encodeURIComponent(dtState.id), {
            target: "#dt-songs", swap: "innerHTML",
          });
        }
      }, 600);
    };
    // #23：跨端会话事件（Phase 1 快照 / Phase 2 命令与移交）转成 DOM 事件给 session-sync.js，
    // 复用这一条 SSE，不再开第二条连接
    ["sessionChanged", "sessionCommand", "transferRequest", "transferIn", "transferPosition"]
      .forEach(function (evName) {
        libEs.addEventListener(evName, function (e) {
          var detail = {};
          try { detail = JSON.parse(e.data || "{}"); } catch (err) {}
          document.dispatchEvent(new CustomEvent("bm:" + evName, { detail: detail }));
        });
      });
    libEs.addEventListener("libraryChanged", libRefresh);
    libEs.addEventListener("playlistsChanged", libRefresh);
    // （重）连上即全量刷新：断线/服务重启期间错过的推送事件用一次拉取补齐
    libEs.onopen = libRefresh;
  }

  // ---------- v0.5.0：打开 App 即同步一次 ----------
  // 让本地曲库以 B 站收藏夹为准并跨设备对齐；每次打开只触发一次（sessionStorage 计数）。
  if (document.body && document.body.dataset.auth === "1" && !sessionStorage.getItem("bm_synced_open")) {
    sessionStorage.setItem("bm_synced_open", "1");
    setTimeout(function () { if (window.syncNow) syncNow(); }, 1200);
  }
})();
