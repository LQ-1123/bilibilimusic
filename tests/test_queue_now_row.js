const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app/web/static/app.js', 'utf8');

// 「正在播放」行（v2.2）：renderQueue 把当前曲目排在队列列表里的原位——
// 已播放的行压暗（q-done）、当前行粉字＋脉动（q-now）、待播原样，三段同一张列表。
function harness(state = {}) {
  const el = (id) => ({ id, innerHTML: '', hidden: false, _src: null,
    querySelector() { return this._src; } });
  const els = { main: [el('main')], radio: [el('radio')], next: [el('next')], rsec: [el('rsec')] };
  els.next[0]._src = el('next-src');
  const map = {
    '[data-qlist="main"]': els.main, '[data-qlist="radio"]': els.radio,
    '[data-qsec="next"]': els.next, '[data-qsec="radio"]': els.rsec,
  };
  const context = vm.createContext({
    playlist: state.playlist || [],
    current: state.current === undefined ? -1 : state.current,
    recActive: !!state.recActive,
    window: Object.assign({}, state.window),
    queueDisplayItems: [],
    escapeHtml: (s) => String(s || ""),
    fmt: () => "3:00",
    _qRowCover: (s) => "<cvr:" + (s.title || s.bvid) + ">",
    _qRowMore: () => "<more>",
    syncQueuePills() {},
    closeQueueMenu() {},
    document: { querySelectorAll: (sel) => map[sel] || [] },
  });
  vm.runInContext(
    source.slice(source.indexOf('  function renderQueue()'), source.indexOf('  function _qRowMore()')),
    context,
  );
  context.renderQueue();
  return { context, els };
}

const rows = (html) => html.split('<li ').slice(1);

test('曲库队列：整张队列连着排，当前行卡在原位、之前的压暗', () => {
  const songs = [{ id: 1, title: 'A' }, { id: 2, title: 'B' }, { id: 3, title: 'C' }];
  const { els, context } = harness({ playlist: songs, current: 1 });
  const html = els.main[0].innerHTML;
  assert.equal(rows(html).length, 3);                            // 已播放 + 正在播放 + 待播
  assert.match(rows(html)[0], /class="q-done"/);                 // 上一首：压暗
  assert.match(rows(html)[1], /class="q-now"/);                  // 正在播放：粉字＋脉动
  assert.match(rows(html)[1], /<cvr:B>/);
  assert.doesNotMatch(rows(html)[2], /class="q-(now|done)"/);    // 下一首：原样
  assert.match(rows(html)[1], /class="q-eq"/);
  assert.equal((rows(html)[1].match(/<i><\/i>/g) || []).length, 3); // 三根脉动条
  assert.equal(context.queueDisplayItems.length, 3);             // 下标映射＝整张队列
  assert.equal(els.next[0]._src.textContent, '正在播放第 2 首 · 共 3 首');
});

test('试听队列：同样整队连着排，电台歌走下面的 ∞ 分区', () => {
  const items = [{ bvid: 'A', title: 'A' }, { bvid: 'B', title: 'B' },
                 { bvid: 'R', title: 'R', radio: true }, { bvid: 'C', title: 'C' }];
  const { els } = harness({ recActive: true, window: { __trialQueue: { items, i: 1 } } });
  const html = els.main[0].innerHTML;
  assert.equal(rows(html).length, 3);                            // 电台歌不算在主列表
  assert.match(rows(html)[1], /class="q-now"/);
  assert.match(rows(html)[1], /<cvr:B>/);
  assert.match(els.radio[0].innerHTML, /<cvr:R>/);
  assert.equal(els.next[0]._src.textContent, '正在播放第 2 首 · 共 3 首');
});

test('空队列只剩占位行', () => {
  const { els } = harness({ playlist: [], current: -1 });
  assert.match(els.main[0].innerHTML, /q-empty/);
  assert.equal(els.next[0].hidden, true);
});
