/* BiliMusic 返回语义统一层（#1）：应用内浮层 ⇆ 浏览器历史一一对齐。
   Android 物理返回 / 桌面浏览器后退 / iOS 侧滑 = 关闭栈顶浮层；根态返回 = 离开应用。
   不侵入各开合函数：MutationObserver 观察 DOM 状态统一对账——
   UI 关闭 → history.back() 同步弹出历史；popstate 关闭 → 走 silent 关层不再回退，
   保证「UI 按钮」与「系统返回」走同一条状态路径不分叉。 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  var layers = []; // 注册表 [{id, el, isOpen(), close()}]
  var open = [];   // 当前记录为打开的层 id（LIFO）
  var silent = {}; // popstate 触发的关闭：observer 对账时不再 history.back()

  function byId(id) {
    for (var i = 0; i < layers.length; i++) if (layers[i].id === id) return layers[i];
    return null;
  }

  function reg(id, el, isOpen, close) {
    layers.push({ id: id, isOpen: isOpen, close: close });
    if (el) {
      new MutationObserver(sync).observe(el, {
        attributes: true, attributeFilter: ["class", "hidden"],
      });
    }
  }

  function sync() {
    var backs = 0;
    var added = [];
    layers.forEach(function (l) {
      var now;
      try { now = l.isOpen(); } catch (e) { return; }
      var tracked = open.indexOf(l.id) !== -1;
      if (now) {
        // tracked && silent = 系统返回触发的关闭动画进行中（hidden 延迟 300~420ms）：
        // DOM 还开着也不能再推历史，否则一次返回会凭空多出一条记录
        if (!tracked && !silent[l.id]) {
          open.push(l.id);
          added.push(l.id);
        }
      } else if (tracked) {
        open.splice(open.indexOf(l.id), 1);
        if (silent[l.id]) delete silent[l.id]; // popstate 已出栈：不再回退
        else backs++;                          // UI 关闭：历史同步出栈
      }
    });
    added.forEach(function (id) {
      var state = { bm: "layer", id: id, depth: open.indexOf(id) + 1 };
      // Closing a dropdown while opening its result page replaces the same entry.
      if (backs) { history.replaceState(state, ""); backs--; }
      else history.pushState(state, "");
    });
    for (var i = 0; i < backs; i++) history.back();
  }

  function popTo(depth) {
    open.slice(depth).forEach(function (id) {
      var l = byId(id);
      if (!l) return;
      silent[id] = true; // open[] 交给 sync 在 DOM 实际关闭时出账
      try { l.close(); } catch (e) {}
    });
  }

  window.addEventListener("popstate", function (e) {
    var depth = e.state && e.state.bm === "layer" ? e.state.depth : 0;
    popTo(depth); // 系统返回：严格 LIFO 逐层关
  });

  // 壳层桥（Android onBackPressed）：返回值>0 表示页面内有层开着，壳应走 history.back()
  window.__backStackDepth = function () { return open.length; };

  // 底部 Tab 切换/主导航：不压栈且清空已压栈（历史回根；层 DOM 交给调用方收口）
  window.__backStackReset = function () {
    open = [];
    silent = {};
    try { history.replaceState(null, ""); } catch (e) {}
  };

  function init() {
    // 刷新/恢复会话时当前条目可能残留 layer 状态（SPA 初始全关）：
    // 归一化回根态，避免之后 popstate 的 depth 与实际栈对不上
    try { if (history.state && history.state.bm === "layer") history.replaceState(null, ""); } catch (e) {}
    var app = $("app");
    reg("login", $("login-modal"),
      function () { return !$("login-modal").classList.contains("hidden"); },
      function () { if (window.closeLogin) closeLogin(); });
    reg("modal", $("mini-modal"),
      function () { return !$("mini-modal").classList.contains("hidden"); },
      function () { var c = $("mm-cancel"); if (c) c.click(); }); // 返回 = 取消弹窗
    reg("search", $("search-drop"),
      function () { return !$("search-drop").hidden; },
      function () { var c = $("search-close"); if (c) c.click(); });
    reg("lyrics", $("lyrics-panel"),
      function () { return !$("lyrics-panel").classList.contains("hidden"); },
      function () { var c = $("btn-lyrics-close"); if (c) c.click(); });
    reg("queue", $("queue-panel"),
      function () { return !$("queue-panel").classList.contains("hidden"); },
      function () { var b = $("btn-queue"); if (b) b.click(); });
    reg("up", $("up-panel"),
      function () { return !$("up-panel").classList.contains("hidden"); },
      function () { var c = $("up-close"); if (c) c.click(); });
    if (app) {
      // #32：不只认 "detail"——搜索详情（search）也是同一层语义；推荐/UP 视图同样可返回。
      // 但 Tab 拥有的视图（library，见 #34）不算层：Tab 切换按 #1 设计不压栈。
      reg("detail", app,
        function () {
          var v = app.dataset.view;
          return !!v && v !== "home" && v !== "library";
        },
        function () {
          if (window.closeDetailTo) closeDetailTo();
          else if (window.goHome) goHome();
        });
      new MutationObserver(sync).observe(app, {
        attributes: true, attributeFilter: ["data-view"],
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
