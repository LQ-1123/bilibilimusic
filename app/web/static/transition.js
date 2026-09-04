/* Smart Transition 打分与规划（纯函数，无 DOM 依赖）。
   浏览器挂载 window.SmartTransition；node --test 可直接 require。 */
(function (global) {
  "use strict";

  // 规范第十七节权重
  var WEIGHTS = {
    phrase: 0.25,
    beat: 0.2,
    bpm: 0.15,
    vocal: 0.15,
    energy: 0.1,
    spectral: 0.1,
    boundary: 0.05,
  };

  var FALLBACK_THRESHOLD = 0.35; // 自然播放匹配分低于此 → 普通 crossfade

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  function curveAt(curve, t) {
    if (!curve || !curve.length) return 0;
    if (t <= curve[0][0]) return curve[0][1];
    for (var i = 1; i < curve.length; i++) {
      if (curve[i][0] >= t) {
        var t0 = curve[i - 1][0], t1 = curve[i][0], v0 = curve[i - 1][1], v1 = curve[i][1];
        if (t1 - t0 < 1e-6) return v1;
        var x = (t - t0) / (t1 - t0);
        return v0 * (1 - x) + v1 * x;
      }
    }
    return curve[curve.length - 1][1];
  }

  function findPoint(points, t) {
    var best = null, bestDist = Infinity;
    for (var i = 0; i < points.length; i++) {
      var d = Math.abs(points[i].t - t);
      if (d < bestDist) { bestDist = d; best = points[i]; }
    }
    return best;
  }

  // BPM 差异考虑整倍频等价（120 与 240、120 与 60 算同族）
  function bpmDiff(a, b) {
    if (!(a > 0) || !(b > 0)) return 0;
    return Math.min(Math.abs(a - b), Math.abs(a * 2 - b), Math.abs(a - b * 2));
  }

  /* 候选点配对打分：全部子分 0~1，加权合计 0~1。 */
  function scorePair(a, b, exitT, entryT) {
    var ep = findPoint(a.exitPoints || [], exitT) ||
      { beatAligned: false, barAligned: false, phraseAligned: false, vocalProbability: 0.5, energy: 0.5 };
    var ip = findPoint(b.entryPoints || [], entryT) ||
      { beatAligned: false, barAligned: false, phraseAligned: false, vocalProbability: 0.5, energy: 0.5 };

    // PhraseScore：phrase 1 / bar 0.8 / beat 0.5 / 非 beat 0.1（取两侧较弱的）
    function rank(p) {
      if (p.phraseAligned) return 1;
      if (p.barAligned) return 0.8;
      if (p.beatAligned) return 0.5;
      return 0.1;
    }
    var phraseScore = Math.min(rank(ep), rank(ip));
    var beatScore = ep.beatAligned && ip.beatAligned ? 1 : ep.beatAligned || ip.beatAligned ? 0.5 : 0.1;

    var bpmScore = a.bpm > 0 && b.bpm > 0 ? clamp01(1 - bpmDiff(a.bpm, b.bpm) / 10) : 0.5;

    var av = ep.vocalProbability != null ? ep.vocalProbability : curveAt(a.vocalCurve, exitT);
    var bv = ip.vocalProbability != null ? ip.vocalProbability : curveAt(b.vocalCurve, entryT);
    var vocalScore = clamp01(1 - av * bv); // 双人声叠加重罚

    var enA = ep.energy != null ? ep.energy : curveAt(a.energyCurve, exitT);
    var enB = ip.energy != null ? ip.energy : curveAt(b.energyCurve, entryT);
    var energyScore = clamp01(1 - Math.abs(enA - enB) / 0.8);

    var cA = curveAt(a.centroidCurve, exitT), cB = curveAt(b.centroidCurve, entryT);
    var spectralScore = clamp01(1 - Math.abs(cA - cB) / 0.5);

    var boundaryScore = entryT < 0.1 ? 1 : 0.6; // 从 B 真开头进入加分

    var score =
      WEIGHTS.phrase * phraseScore +
      WEIGHTS.beat * beatScore +
      WEIGHTS.bpm * bpmScore +
      WEIGHTS.vocal * vocalScore +
      WEIGHTS.energy * energyScore +
      WEIGHTS.spectral * spectralScore +
      WEIGHTS.boundary * boundaryScore;
    return clamp01(score);
  }

  /* 规范第二十三节：按特征自动选策略与过渡时长（秒）。 */
  function selectStrategy(a, b, exitP, entryP, score) {
    var bpmA = a.bpm || 0, bpmB = b.bpm || 0;
    var conf = Math.min(a.bpmConfidence || 0, b.bpmConfidence || 0);
    var d = bpmA > 0 && bpmB > 0 ? bpmDiff(bpmA, bpmB) : 99;
    var vMax = Math.max(exitP.vocalProbability || 0, entryP.vocalProbability || 0);
    var eA = exitP.energy != null ? exitP.energy : 0.5;
    var eB = entryP.energy != null ? entryP.energy : 0.5;

    if (score < 0.22) return { type: "HARD_CUT", duration: 0 };
    if (vMax > 0.75) return { type: "VOCAL_SAFE", duration: 2 + Math.round(score * 2) };
    if (d <= 3 && conf >= 0.3) return { type: "BEAT_MATCH", duration: 8 + Math.round(score * 8) };
    if (d > 15) return { type: "PHRASE_CROSSFADE", duration: 3 + Math.round(score * 2) };
    if (Math.min(eA, eB) > 0.7) return { type: "SHORT_CROSSFADE", duration: 1 + Math.round(score) };
    if (Math.max(eA, eB) < 0.35) return { type: "LONG_CROSSFADE", duration: 8 + Math.round(score * 4) };
    var dur = score > 0.7 ? 6 : score > 0.5 ? 4 : score > 0.35 ? 2.5 : 1.5;
    return { type: "SHORT_CROSSFADE", duration: dur };
  }

  function candidatesInWindow(points, from, to) {
    return (points || []).filter(function (p) { return p.t >= from && p.t <= to; });
  }

  /* 核心：规划一次 A→B 过渡。
     context.type = "manual"（用户点 Next，响应优先）| "natural"（自然播完，音乐性优先）。 */
  function planTransition(a, b, position, context) {
    context = context || {};
    var natural = context.type === "natural";
    var aDur = (a && a.duration) || 0;

    var exitWin, entryWin;
    if (natural) {
      exitWin = [Math.max(0, aDur - 35), Math.max(0, aDur - 0.15)];
      entryWin = [0, 30];
    } else {
      exitWin = [position + 0.3, position + 8];
      entryWin = [0, 30];
    }

    var exits = candidatesInWindow(a.exitPoints, exitWin[0], exitWin[1]);
    if (!exits.length) {
      var fbExit = natural ? Math.max(0, aDur - 0.15) : position + 1.5;
      exits = [{ t: fbExit, beatAligned: false, barAligned: false, phraseAligned: false, vocalProbability: 0.5, energy: 0.5 }];
    }
    var entries = candidatesInWindow(b.entryPoints, entryWin[0], entryWin[1]);
    if (!entries.length) {
      entries = [{ t: 0, beatAligned: false, barAligned: false, phraseAligned: false, vocalProbability: 0.5, energy: 0.5 }];
    }

    var best = null;
    for (var i = 0; i < exits.length; i++) {
      for (var j = 0; j < entries.length; j++) {
        var s = scorePair(a, b, exits[i].t, entries[j].t);
        if (!natural) s -= Math.max(0, exits[i].t - position - 0.3) * 0.01; // 手动：近处优先
        if (!best || s > best.score) {
          best = { exitT: exits[i].t, entryT: entries[j].t, score: s, exitP: exits[i], entryP: entries[j] };
        }
      }
    }
    if (!best) return null;

    var strategy = selectStrategy(a, b, best.exitP, best.entryP, best.score);
    var duration = strategy.duration;
    if (!natural) duration = Math.min(duration, 6); // 手动切歌不过久等待
    if (aDur) duration = Math.min(duration, Math.max(0.3, aDur - best.exitT - 0.1));

    // 自然播放但匹配质量差 → 回退为结尾普通 3 秒 crossfade
    if (natural && best.score < FALLBACK_THRESHOLD) {
      var fd = Math.min(3, Math.max(0.5, aDur - 0.3));
      return {
        exitT: Math.round((aDur - fd) * 1000) / 1000,
        entryT: 0,
        score: Math.round(best.score * 100) / 100,
        strategy: "FALLBACK_CROSSFADE",
        duration: Math.round(fd * 100) / 100,
        mode: "natural",
      };
    }

    return {
      exitT: Math.round(best.exitT * 1000) / 1000,
      entryT: Math.round(best.entryT * 1000) / 1000,
      score: Math.round(clamp01(best.score) * 100) / 100,
      strategy: duration <= 0 ? "HARD_CUT" : strategy.type,
      duration: Math.round(duration * 100) / 100,
      mode: natural ? "natural" : "manual",
    };
  }

  var SmartTransition = {
    WEIGHTS: WEIGHTS,
    FALLBACK_THRESHOLD: FALLBACK_THRESHOLD,
    bpmDiff: bpmDiff,
    curveAt: curveAt,
    scorePair: scorePair,
    selectStrategy: selectStrategy,
    planTransition: planTransition,
  };

  global.SmartTransition = SmartTransition;
  if (typeof module !== "undefined" && module.exports) module.exports = SmartTransition;
})(typeof window !== "undefined" ? window : globalThis);
