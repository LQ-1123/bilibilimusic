/* v2.2 A4 音量均衡 + gapless 的纯逻辑：响度估计、增益换算、预载可用性判定。
   浏览器挂载 window.BiliNorm；node --test 可直接 require（同 transition.js 惯例）。 */
(function (root) {
  "use strict";

  var TARGET_DB = -16;           // 归一目标（RMS dBFS）：对齐流媒体常见响度口径
  var MAX_LIFT_DB = 9;           // 抬升上限：过大倍数会连底噪一起放大
  var MAX_CUT_DB = 12;           // 压低上限：保护极端响的母带，也留足削波余量
  var MIN_CONFIDENT_SECONDS = 4; // 实时估计的最小可信门内时长（低于它不调增益）
  var SAVE_AFTER_SECONDS = 20;   // 门内听满该时长即视为已学到本曲响度，可落库
  var ABS_GATE_DB = -60;         // 绝对静音门：乐间静默、淡入淡出头部不参与统计
  var MAX_FRAMES = 1200;         // 统计窗口上限（约 5 分钟），足够代表全曲

  /** 已知响度 → 增益倍数；未知/非法返回 1（不动）。 */
  function gainFor(trackDb) {
    if (typeof trackDb !== "number" || !isFinite(trackDb)) return 1;
    var delta = TARGET_DB - trackDb;
    if (delta > MAX_LIFT_DB) delta = MAX_LIFT_DB;
    if (delta < -MAX_CUT_DB) delta = -MAX_CUT_DB;
    return Math.pow(10, delta / 20);
  }

  /** 在线响度表：喂媒体输出帧，门控均值估整曲响度（两级门，思路同 BS.1770 简化版）。
      push(samples, dt)：dt 是距上次推送的真实秒数（帧只是响度采样点，计时要按听的时间算——
      fftSize 2048 只有 46ms 音频，250ms 抽一帧时按帧长计时会漏掉 83% 的收听时长）。 */
  function LoudnessMeter(sampleRate) {
    this.sampleRate = sampleRate || 48000;
    this.frames = [];  // 门内帧的 dBFS
    this.seconds = 0;  // 门内累计时长
  }
  LoudnessMeter.prototype.push = function (samples, dt) {
    if (!samples || !samples.length) return;
    var sum = 0;
    for (var i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    var db = 10 * Math.log10(sum / samples.length + 1e-12);
    if (db < ABS_GATE_DB) return;
    if (this.frames.length >= MAX_FRAMES) return;
    this.frames.push(db);
    this.seconds += typeof dt === "number" ? dt : samples.length / this.sampleRate;
  };
  LoudnessMeter.prototype.confident = function () {
    return this.seconds >= MIN_CONFIDENT_SECONDS;
  };
  LoudnessMeter.prototype.savable = function () {
    return this.seconds >= SAVE_AFTER_SECONDS;
  };
  LoudnessMeter.prototype.estimate = function () {
    if (!this.confident() || !this.frames.length) return null;
    var first = mean(this.frames);
    var gated = [];
    for (var i = 0; i < this.frames.length; i++) {
      if (this.frames[i] >= first - 10) gated.push(this.frames[i]);
    }
    return gated.length ? mean(gated) : first;
  };
  function mean(xs) {
    var s = 0;
    for (var i = 0; i < xs.length; i++) s += xs[i];
    return s / xs.length;
  }

  /** 预载（gapless）到点时仍可用：队列没有重排、没有用户降档、预载的就是下一首。 */
  function preloadUsable(pending, nextIdx, nextSong, tierNow) {
    return (
      !!pending &&
      pending.idx === nextIdx &&
      pending.song === nextSong &&
      pending.tier === tierNow
    );
  }

  var BiliNorm = {
    TARGET_DB: TARGET_DB,
    MAX_LIFT_DB: MAX_LIFT_DB,
    MAX_CUT_DB: MAX_CUT_DB,
    MIN_CONFIDENT_SECONDS: MIN_CONFIDENT_SECONDS,
    SAVE_AFTER_SECONDS: SAVE_AFTER_SECONDS,
    gainFor: gainFor,
    LoudnessMeter: LoudnessMeter,
    preloadUsable: preloadUsable,
  };
  root.BiliNorm = BiliNorm;
  if (typeof module !== "undefined" && module.exports) module.exports = BiliNorm;
})(typeof window !== "undefined" ? window : globalThis);
