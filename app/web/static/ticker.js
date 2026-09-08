/* BiliMusic 标题走马灯（#13）：仅"正在播放"标题超宽时在窗口内来回滚动。
   用法：BiliTicker.set(el) —— 文本变更后调用；溢出才启用，悬停/按住暂停，
   切歌重置，prefers-reduced-motion 下退化为省略号（不启用）。
   按元素各管各的实例：播放条与歌词页标题互不干扰。 */
(function () {
  "use strict";
  var SPEED = 30;  // px/s
  var PAUSE = 750; // 两端停顿 ms

  var running = new Map(); // el -> {dist, pos, dir, wait, raf}
  var last = 0;

  function reduced() {
    return window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function stop(el) {
    var st = running.get(el);
    if (!st) return;
    if (st.raf) cancelAnimationFrame(st.raf);
    running.delete(el);
    el.classList.remove("ticker-on");
    el.scrollLeft = 0;
    last = 0;
  }

  function frame(now) {
    var dt = last ? Math.min(64, now - last) : 16;
    last = now;
    running.forEach(function (st, el) {
      if (el.dataset.tickerPause) return;
      if (st.wait > 0) {
        st.wait -= dt;
      } else {
        st.pos += st.dir * SPEED * dt / 1000;
        if (st.pos >= st.dist) { st.pos = st.dist; st.dir = -1; st.wait = PAUSE; }
        else if (st.pos <= 0) { st.pos = 0; st.dir = 1; st.wait = PAUSE; }
      }
      // 滚动内容而不是平移盒子：盒子即裁切容器，transform 会把文字整体甩出容器
      el.scrollLeft = st.pos;
    });
    if (running.size) requestAnimationFrame(frame);
    else last = 0; // 全部停了就结束循环，下次 set 重新拉起
  }

  function watch(el) {
    if (el.dataset.tickerWatch) return;
    el.dataset.tickerWatch = "1";
    var on = function () { el.dataset.tickerPause = "1"; };
    var off = function () { delete el.dataset.tickerPause; };
    el.addEventListener("mouseenter", on);
    el.addEventListener("mouseleave", off);
    el.addEventListener("touchstart", on, { passive: true });
    el.addEventListener("touchend", off);
    el.addEventListener("touchcancel", off);
  }

  window.BiliTicker = {
    set: function (el) {
      if (!el) return;
      stop(el);
      if (reduced()) return;
      watch(el);
      // 等一帧让新文本完成布局再测溢出
      requestAnimationFrame(function () {
        if (running.has(el) || !el.clientWidth) return;
        var overflow = el.scrollWidth - el.clientWidth;
        if (overflow <= 2) return;
        el.classList.add("ticker-on"); // 滚动期间关省略号（裁切缘的省略号会钉住）
        running.set(el, { dist: overflow, pos: 0, dir: 1, wait: PAUSE, raf: 0 });
        if (running.size === 1) requestAnimationFrame(frame);
      });
    },
  };

  // 视口变化后重新测量（逐个来）
  var rsTimer = 0;
  window.addEventListener("resize", function () {
    if (!running.size) return;
    var els = Array.from(running.keys());
    clearTimeout(rsTimer);
    rsTimer = setTimeout(function () { els.forEach(window.BiliTicker.set); }, 200);
  });
})();
