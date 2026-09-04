/* Smart Transition 打分/规划/策略单测：node --test tests/test_transition.js */
const test = require("node:test");
const assert = require("node:assert");
const ST = require("../app/web/static/transition.js");

const mkPoint = (over) =>
  Object.assign(
    { t: 0, score: 1, energy: 0.5, vocalProbability: 0, beatAligned: true, barAligned: true, phraseAligned: true, type: "phrase" },
    over
  );
const mkTrack = (over) =>
  Object.assign(
    {
      duration: 200,
      bpm: 120,
      bpmConfidence: 0.8,
      exitPoints: [],
      entryPoints: [],
      energyCurve: [[0, 0.5], [200, 0.5]],
      vocalCurve: [[0, 0.2], [200, 0.2]],
      centroidCurve: [[0, 0.5], [200, 0.5]],
    },
    over
  );

test("权重合计为 1", () => {
  const sum = Object.values(ST.WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("完美配对得分接近 1", () => {
  const a = mkTrack({ exitPoints: [mkPoint({ t: 100 })] });
  const b = mkTrack({ entryPoints: [mkPoint({ t: 0 })] });
  const s = ST.scorePair(a, b, 100, 0);
  assert.ok(s > 0.95, `score=${s}`);
});

test("双人声叠加被重罚", () => {
  const a = mkTrack({ exitPoints: [mkPoint({ t: 100, vocalProbability: 0.9 })] });
  const b = mkTrack({ entryPoints: [mkPoint({ t: 0, vocalProbability: 0.9 })] });
  const s = ST.scorePair(a, b, 100, 0);
  // vocal 权重 0.15，双重 0.9 的最大惩罚 ≈ 0.12
  assert.ok(s < 0.9, `score=${s}`);
  const a2 = mkTrack({ exitPoints: [mkPoint({ t: 100, vocalProbability: 0 })] });
  const b2 = mkTrack({ entryPoints: [mkPoint({ t: 0, vocalProbability: 0 })] });
  const s2 = ST.scorePair(a2, b2, 100, 0);
  assert.ok(s2 > s + 0.1, `s2=${s2} s=${s}`);
});

test("BPM 差异考虑倍频等价", () => {
  assert.ok(ST.bpmDiff(120, 60) <= 0.5);
  assert.ok(ST.bpmDiff(120, 125) === 5);
});

test("manual 规划只取窗口内 exit 且近处优先", () => {
  const a = mkTrack({
    exitPoints: [mkPoint({ t: 110, energy: 0.4 }), mkPoint({ t: 115.5, energy: 0.3 }), mkPoint({ t: 190 })],
  });
  const b = mkTrack({ entryPoints: [mkPoint({ t: 0 })] });
  const plan = ST.planTransition(a, b, 109, { type: "manual" });
  assert.ok(plan, "应有计划");
  assert.ok(plan.exitT >= 109.3 && plan.exitT <= 117, `exitT=${plan.exitT}`);
  assert.ok(plan.duration <= 6, "手动过渡不超过 6s");
  assert.ok(plan.score > 0.5);
});

test("natural 全配对取最优", () => {
  const a = mkTrack({ exitPoints: [mkPoint({ t: 170, energy: 0.3 }), mkPoint({ t: 196, energy: 0.2 })] });
  const b = mkTrack({ entryPoints: [mkPoint({ t: 0, energy: 0.3 }), mkPoint({ t: 8, energy: 0.7 })] });
  const plan = ST.planTransition(a, b, 0, { type: "natural" });
  assert.ok(plan && plan.exitT >= 165 && plan.exitT <= 200, `exitT=${plan && plan.exitT}`);
  assert.ok(plan.entryT <= 30);
});

test("natural 低分回退普通 crossfade", () => {
  const a = mkTrack({
    bpm: 70,
    bpmConfidence: 0.1,
    exitPoints: [mkPoint({ t: 190, vocalProbability: 1, energy: 0.9, beatAligned: false, barAligned: false, phraseAligned: false })],
  });
  const b = mkTrack({
    bpm: 160,
    bpmConfidence: 0.1,
    entryPoints: [mkPoint({ t: 12, vocalProbability: 1, energy: 0.05, beatAligned: false, barAligned: false, phraseAligned: false })],
  });
  const plan = ST.planTransition(a, b, 0, { type: "natural" });
  assert.ok(plan);
  assert.equal(plan.strategy, "FALLBACK_CROSSFADE");
  assert.equal(plan.duration, 3);
});

test("策略：BPM 近+高置信 → BEAT_MATCH", () => {
  const s = ST.selectStrategy(
    { bpm: 120, bpmConfidence: 0.8 }, { bpm: 121, bpmConfidence: 0.8 },
    mkPoint({}), mkPoint({}), 0.8
  );
  assert.equal(s.type, "BEAT_MATCH");
  assert.ok(s.duration >= 8 && s.duration <= 16);
});

test("策略：人声密集 → VOCAL_SAFE（优先于 BEAT_MATCH）", () => {
  const s = ST.selectStrategy(
    { bpm: 120, bpmConfidence: 0.8 }, { bpm: 121, bpmConfidence: 0.8 },
    mkPoint({ vocalProbability: 0.9 }), mkPoint({}), 0.8
  );
  assert.equal(s.type, "VOCAL_SAFE");
});

test("策略：BPM 差大 → PHRASE_CROSSFADE", () => {
  const s = ST.selectStrategy(
    { bpm: 90, bpmConfidence: 0.9 }, { bpm: 160, bpmConfidence: 0.9 },
    mkPoint({}), mkPoint({}), 0.6
  );
  assert.equal(s.type, "PHRASE_CROSSFADE");
});

test("策略：低分 → HARD_CUT", () => {
  const s = ST.selectStrategy(
    { bpm: 0, bpmConfidence: 0 }, { bpm: 0, bpmConfidence: 0 },
    mkPoint({ vocalProbability: 1, energy: 1, beatAligned: false, phraseAligned: false }),
    mkPoint({ vocalProbability: 1, energy: 0, beatAligned: false, phraseAligned: false }),
    0.15
  );
  assert.equal(s.type, "HARD_CUT");
  assert.equal(s.duration, 0);
});
