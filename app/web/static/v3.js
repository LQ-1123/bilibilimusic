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

  // ---------- 问候语 ----------
  (function () {
    var el = $("hero-hi");
    if (!el) return;
    var h = new Date().getHours();
    var hi = h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
    el.textContent = hi + "，该听歌了";
  })();

  // ---------- 顶栏滚动态 ----------
  var mainEl = $("mainEl"), topbar = $("topbar");
  if (mainEl && topbar) {
    mainEl.addEventListener("scroll", function () {
      topbar.classList.toggle("scrolled", mainEl.scrollTop > 12);
    });
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
      app.style.setProperty("--side", w + "px");
    });
    var up = function () { dragging = false; document.body.style.cursor = ""; };
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  })();

  // ---------- 导航 ----------
  window.goHome = function () {
    $("app").dataset.view = "home";
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

  // ---------- 歌单详情 ----------
  var dtState = { id: "0", name: "全部歌曲", hue: 340 };

  function fillDetail(el) {
    var d = el.dataset;
    dtState.id = d.pl;
    dtState.name = d.name;
    dtState.hue = d.hue || 340;
    $("app").dataset.view = "detail";
    var hero = document.getElementById("dt-hero");
    if (hero) hero.style.setProperty("--dh", dtState.hue);
    document.getElementById("dt-eyebrow").textContent =
      d.pl === "0" ? "ALL · 全部收藏" :
      d.default === "1" ? "MAIN · 默认歌单 · bilimusic 夹" : "PLAYLIST · bilimusic-" + d.name + " 夹";
    document.getElementById("dt-title").textContent = d.name;
    document.getElementById("dt-meta").innerHTML =
      "<b>" + d.count + " 首</b><span>·</span><span>已同步 B 站收藏夹</span>";
    document.getElementById("dt-crumb").textContent = "主页 / " + d.name;
    if (window.htmx) {
      htmx.ajax("GET", "/partials/songs?playlist_id=" + encodeURIComponent(d.pl), {
        target: "#dt-songs",
        swap: "innerHTML",
      });
    }
    if (mainEl) mainEl.scrollTop = 0;
  }

  window.openDetailFrom = function (el, autoplay) {
    // 先选中歌单（决定收藏目标 + 主页列表联动），再进详情
    if (window.selectPlaylist) selectPlaylist(el.dataset.pl, el);
    fillDetail(el);
    if (autoplay) setTimeout(window.playDetailFirst, 700); // 等曲目列表加载完成
  };

  window.playDetailFirst = function () {
    var row = document.querySelector("#dt-songs [data-play]");
    if (row && window.BiliPlayer) BiliPlayer.playById(row.dataset.play);
  };
  window.shuffleDetail = function () {
    var rows = document.querySelectorAll("#dt-songs [data-play]");
    if (!rows.length) return;
    var row = rows[Math.floor(Math.random() * rows.length)];
    if (window.BiliPlayer) BiliPlayer.playById(row.dataset.play);
  };
  window.detailMenu = function () {
    if (String(dtState.id) === "0") { focusSearchBar(); return; }
    var act = prompt(
      "歌单「" + dtState.name + "」操作：\n· 输入新名称 → 改名（B 站夹同步）\n· 输入 del → 删除（歌曲移入我的曲库）",
      "");
    if (!act) return;
    act = act.trim();
    if (act.toLowerCase() === "del") {
      if (window.deletePlaylist) deletePlaylist(dtState.id, dtState.name);
    } else if (act && act !== dtState.name) {
      if (window.renamePlaylist) renamePlaylist(dtState.id, dtState.name);
    }
  };

  // 歌单增删改后：刷新海报架的同时同步详情页（歌单没了就回主页）
  document.body.addEventListener("playlistsChanged", function () {
    if ($("app").dataset.view !== "detail") return;
    var el = document.querySelector('.side-pl[data-pl="' + dtState.id + '"]');
    if (el) fillDetail(el);
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
    if (e.target && (e.target.id === "sd-web" || e.target.id === "rec-list")) markHearts();
  });
  loadCollected();

  // ---------- 搜索下拉：曲库命中（点击即播）+ B 站结果（♥ 收藏） ----------
  (function () {
    var input = $("search"), drop = $("search-drop"), lib = $("sd-lib"), web = $("sd-web");
    if (!input || !drop) return;
    var LINK = /^\s*(https?:\/\/|b23\.|bv|av)/i;
    var timer = null, lastQ = null;

    function open() { drop.hidden = false; }
    function close() { drop.hidden = true; }

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

    input.addEventListener("input", function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (!q) { close(); lastQ = null; return; }
      open();
      timer = setTimeout(function () { run(q); }, 350);
    });
    input.addEventListener("focus", function () {
      if (input.value.trim()) open();
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

  // ---------- 音量（双 audio 元素同步） ----------
  (function () {
    var vol = $("vol");
    if (!vol) return;
    vol.addEventListener("input", function () {
      var v = vol.value / 100;
      var a = $("audio"), b = $("audio2");
      if (a) a.volume = v;
      if (b) b.volume = v;
    });
  })();

  // ---------- 点封面 → 歌词（试听态无歌词，跳过） ----------
  (function () {
    var c = $("player-cover"), lc = $("lyrics-cover");
    if (c && window.toggleLyrics) c.addEventListener("click", function () {
      if (document.body.classList.contains("trial")) return;
      toggleLyrics();
    });
    if (lc && window.BiliPlayer) lc.addEventListener("click", function () { BiliPlayer.toggle(); });
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

  // ---------- 移动端 Tab / 搜索圆钮 ----------
  window.mTab = function (name, btn) {
    document.body.dataset.mtab = name;
    document.querySelectorAll(".m-tab").forEach(function (b) {
      b.classList.toggle("on", b === btn);
    });
    if (name === "home" && $("app").dataset.view === "detail") goHome();
    if (mainEl) mainEl.scrollTop = 0;
  };
  window.orbSearch = function () {
    document.body.dataset.mtab = "home";
    var t = document.querySelector('.m-tab[data-mtab="home"]');
    if (t) t.classList.add("on");
    document.querySelectorAll(".m-tab").forEach(function (b) {
      b.classList.toggle("on", b === t);
    });
    focusSearchBar();
  };

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
