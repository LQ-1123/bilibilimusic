/* 手机底部导航的「液态玻璃」选中块（#移动端导航动效）
 *
 * 行为：
 * - 跟手拖动：选中块中心贴着手指走，横向滞后量转成「水珠」形变（变窄、变高、更圆）；
 * - 长按：立刻给一个基础形变，松手复原；
 * - 松手：欠阻尼弹簧回弹，吸附到最近一格并切换 Tab；
 * - 任何地方切换选中项（mTab / openLibraryTab / orbSearch）都会让玻璃块跟上。
 *
 * 位置与形变通过 CSS 变量 --pill-x / --pill-sx / --pill-sy 交给 style.css，
 * 本文件只负责算数；JS 不可用时样式表退回 :not(.liquid) 的百分比定位。
 */
(function () {
  var tabs = document.querySelector(".m-tabs");
  if (!tabs) return;
  var btns = [].slice.call(tabs.querySelectorAll(".m-tab"));
  if (btns.length < 2) return;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 拖动中：跟手要快，但保留一点滞后——滞后量就是「水珠」形变的来源
  var K_DRAG = 0.24, D_DRAG = 0.42;
  // 松手落位 / 程序切换：慢一些、基本不过冲（实测 ≈400ms 落位，0 过冲）
  var K_SETTLE = 0.14, D_SETTLE = 0.84;
  // 形变本身也走缓动：点击/按下时不再「一步到位」，约 0.3~0.45s 缓慢变形（时间常数 0.15s）
  var SHAPE_TAU = 0.15;
  var baseCx = 0;             // translateX(0) 时选中块的中心
  var step = 0;               // 每格位移（= 选中块宽度）
  var pos = 0, vel = 0, target = 0;   // 当前 / 目标 translateX（px）
  var shapeSx = 1, shapeSy = 1, shapeTs = 0;   // 实际画出来的形变（缓动后）
  var raf = 0, down = false, dragging = false, pid = null, startX = 0, moved = 0, press = 0;

  function measure() {
    var w = tabs.clientWidth;
    if (!w) return false;
    // 选中块四周留白由 CSS 的 --nav-pad 决定，这里读同一个值，改 CSS 即可整体缩放
    var pad = parseFloat(getComputedStyle(tabs).getPropertyValue("--nav-pad")) || 5;
    // 与 CSS 的 inset / width:calc((100% - pad*2)/n) 对齐：按「内区等分」定位，
    // 而不是按 tab 中心，这样最左/最右两格与导航条内缘同心、四周间距一致
    step = (w - pad * 2) / btns.length;
    baseCx = pad + step / 2;
    tabs.style.setProperty("--pill-w", step.toFixed(2) + "px");
    return true;
  }
  function offsetOf(i) { return i * step; }
  function activeIndex() {
    for (var i = 0; i < btns.length; i++) if (btns[i].classList.contains("on")) return i;
    return 0;
  }
  function shapeT() {
    var span = Math.max(1, tabs.clientWidth / btns.length);
    // 滞后越远，水珠越短越粗越圆；长按时给一个基础形变
    return Math.max(press, Math.min(1, Math.abs(target - pos) / (span * 0.5)));
  }
  function shapeWant() {
    var t = shapeT();
    // 最窄 0.94（≈79px，和纵向 83px 基本相当）；最高 1.60：52px × 1.60 = 83.2px
    return { sx: reduce ? 1 : 1 - 0.06 * t, sy: reduce ? 1 : 1 + 0.60 * t };
  }
  function shapeBusy() {
    var want = shapeWant();
    return Math.abs(want.sx - shapeSx) > 0.002 || Math.abs(want.sy - shapeSy) > 0.002;
  }
  // snap = true 时立刻到位（首屏、旋转屏、减少动效）
  function paint(ts, snap) {
    var want = shapeWant();
    if (reduce || snap || !SHAPE_TAU) {
      shapeSx = want.sx; shapeSy = want.sy;
    } else if (ts) {
      var dt = shapeTs ? Math.min(64, Math.max(0, ts - shapeTs)) : 16;
      var a = 1 - Math.exp(-dt / (SHAPE_TAU * 1000));
      shapeSx += (want.sx - shapeSx) * a;
      shapeSy += (want.sy - shapeSy) * a;
    }
    if (ts) shapeTs = ts;
    tabs.style.setProperty("--pill-x", pos.toFixed(2) + "px");
    tabs.style.setProperty("--pill-sx", shapeSx.toFixed(3));
    tabs.style.setProperty("--pill-sy", shapeSy.toFixed(3));
  }
  function tick(ts) {
    raf = 0;
    var live = down && dragging;      // 手指还在拖 → 跟手参数；已松手 → 慢速落位参数
    var k = live ? K_DRAG : K_SETTLE;
    var d = live ? D_DRAG : D_SETTLE;
    vel += (target - pos) * k - vel * d;
    pos += vel;
    var moving = Math.abs(target - pos) >= 0.3 || Math.abs(vel) >= 0.3;
    if (!moving) { pos = target; vel = 0; }
    paint(ts);
    // 位置停了但形变还在缓动 → 继续跑帧，否则形变会卡在半路
    if (moving || shapeBusy()) raf = requestAnimationFrame(tick);
  }
  function kick() {
    if (reduce) { pos = target; vel = 0; paint(0, true); return; }  // 减少动效：直接落位，不做弹簧
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function sync(instant) {
    if (!measure()) return;
    target = offsetOf(activeIndex());
    if (instant) { pos = target; vel = 0; paint(0, true); return; }  // 首屏/旋转屏：立刻落位，不等下一帧
    kick();
  }
  function swallowNextClick() {
    var stop = function (ev) { ev.preventDefault(); ev.stopPropagation(); };
    document.addEventListener("click", stop, true);
    setTimeout(function () { document.removeEventListener("click", stop, true); }, 320);
  }

  function onDown(e) {
    if (e.button != null && e.button !== 0) return;
    if (!measure()) return;
    down = true; dragging = false; pid = e.pointerId;
    startX = e.clientX; moved = 0;
    press = reduce ? 0 : 0.55;          // 长按立刻有明显形变
    target = pos;
    paint(performance.now());           // 按下就要有反馈，不等下一帧（形变本身仍是缓动的）
    kick();
  }
  function onMove(e) {
    if (!down || e.pointerId !== pid) return;
    var dx = Math.abs(e.clientX - startX);
    if (dx > moved) moved = dx;
    if (!dragging && moved > 2) dragging = true;
    if (!dragging) return;
    var left = tabs.getBoundingClientRect().left;
    var x = e.clientX - left - baseCx;   // 让选中块中心贴着手指
    target = Math.min(offsetOf(btns.length - 1), Math.max(offsetOf(0), x));
    kick();
  }
  function onUp(e) {
    if (!down || (pid !== null && e.pointerId !== pid)) return;
    down = false; press = 0;
    pid = null;
    if (!dragging) { target = offsetOf(activeIndex()); kick(); return; }
    // 吸附判定放宽：当前格加 0.15 格惩罚，离开当前格只需走 35%（原先要过半）
    var here = activeIndex();
    var best = here, bestD = Infinity;
    for (var i = 0; i < btns.length; i++) {
      var d = Math.abs(pos - offsetOf(i)) + (i === here ? step * 0.15 : 0);
      if (d < bestD) { bestD = d; best = i; }
    }
    // 甩动：松手时还带着明显速度、位置又还停在当前格，就顺方向认一格
    if (best === here && Math.abs(vel) > 7) {
      var flick = here + (vel > 0 ? 1 : -1);
      if (flick >= 0 && flick < btns.length) best = flick;
    }
    target = offsetOf(best);
    dragging = false;
    // 松手时的手指速度只保留一小部分：否则慢速落位也会被甩出一个过冲
    vel = Math.max(-5, Math.min(5, vel * 0.25));
    kick();
    var btn = btns[best];
    if (!btn.classList.contains("on")) {
      swallowNextClick();   // 拖动结束时浏览器可能再补一个 click，别切两次
      if (window.mTab) window.mTab(btn.dataset.mtab, btn);
    }
  }

  tabs.classList.add("liquid");
  tabs.addEventListener("pointerdown", onDown);
  tabs.addEventListener("pointermove", onMove);
  tabs.addEventListener("pointerup", onUp);
  tabs.addEventListener("pointercancel", onUp);
  // 任何地方切换选中项（mTab / openLibraryTab / orbSearch）都要让玻璃块跟上
  if (window.MutationObserver) {
    var mo = new MutationObserver(function () { sync(false); });
    btns.forEach(function (b) { mo.observe(b, { attributes: true, attributeFilter: ["class"] }); });
  }
  window.addEventListener("resize", function () { sync(true); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () { sync(true); });
  }
  sync(true);
  // 字体/图标加载完宽度会变，补测一次
  setTimeout(function () { sync(true); }, 350);

  // 供调试/测试：程序化模拟一次拖动（真实设备用不到）
  window.__navPill = {
    state: function () { return { pos: pos, target: target, dragging: dragging }; },
    sync: sync
  };
})();
