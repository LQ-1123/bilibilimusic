/* A4 音量均衡 + gapless 纯逻辑单测：node --test tests/test_norm.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../app/web/static/norm.js");

test("已知响度按目标换算增益", () => {
  // 目标 -16：曲子 -22 → 抬 +6dB ≈ 2.0 倍
  assert.ok(Math.abs(N.gainFor(-22) - Math.pow(10, 6 / 20)) < 1e-9);
  // 曲子正好 -16 → 不动
  assert.equal(N.gainFor(-16), 1);
  // 曲子 -10 → 压 -6dB
  assert.ok(Math.abs(N.gainFor(-10) - Math.pow(10, -6 / 20)) < 1e-9);
});

test("增益有上下限，防极端母带与底噪放大", () => {
  assert.equal(N.gainFor(-60), Math.pow(10, N.MAX_LIFT_DB / 20));
  assert.equal(N.gainFor(0), Math.pow(10, -N.MAX_CUT_DB / 20));
});

test("未知/非法响度返回 1（不动）", () => {
  assert.equal(N.gainFor(null), 1);
  assert.equal(N.gainFor(undefined), 1);
  assert.equal(N.gainFor(NaN), 1);
  assert.equal(N.gainFor("x"), 1);
});

function feedTone(meter, db, frames) {
  // 生成指定 RMS dBFS 的正弦帧喂给表（正弦 RMS = 峰值/√2，故峰值 = RMS×√2）
  const amp = Math.pow(10, db / 20) * Math.SQRT2;
  const buf = new Float32Array(2048);
  for (let i = 0; i < buf.length; i++) buf[i] = amp * Math.sin((2 * Math.PI * i * 40) / 48000);
  for (let f = 0; f < frames; f++) meter.push(buf);
}

test("响度表：静音门外的帧不参与统计", () => {
  const m = new N.LoudnessMeter(48000);
  feedTone(m, -18, 400); // 400×2048/48000 ≈ 17s 门内
  feedTone(m, -80, 10);  // 乐间静默，应被 -60dB 绝对门滤掉
  assert.ok(m.confident(), "应有足够样本");
  const est = m.estimate();
  assert.ok(Math.abs(est - (-18)) < 1, `估计值 ${est} 应接近 -18`);
});

test("响度表：样本不足时拒绝估计", () => {
  const m = new N.LoudnessMeter(48000);
  feedTone(m, -18, 30); // 30×2048/48000 ≈ 1.3s < 4s
  assert.ok(!m.confident());
  assert.equal(m.estimate(), null);
});

test("响度表：听满 20s 才可落库", () => {
  const m = new N.LoudnessMeter(48000);
  feedTone(m, -18, 300); // ≈12.8s
  assert.ok(!m.savable());
  feedTone(m, -18, 200); // ≈+8.5s
  assert.ok(m.savable());
});

test("响度表：统计窗口有上限，长歌不无限膨胀", () => {
  const m = new N.LoudnessMeter(48000);
  feedTone(m, -18, 20000);
  assert.ok(m.frames.length <= 1200);
  assert.ok(isFinite(m.estimate()));
});

test("预载可用性：索引、歌曲对象、档位任一变化即作废", () => {
  const song = { bvid: "BV1" };
  const p = { idx: 2, song, tier: "best" };
  assert.ok(N.preloadUsable(p, 2, song, "best"));
  assert.ok(!N.preloadUsable(null, 2, song, "best"));
  assert.ok(!N.preloadUsable(p, 3, song, "best"), "队列顺序变了");
  assert.ok(!N.preloadUsable(p, 2, { bvid: "BV1" }, "best"), "播放列表重建了");
  assert.ok(!N.preloadUsable(p, 2, song, "64"), "弱网降档了");
});
