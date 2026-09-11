const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app/web/static/app.js', 'utf8');

// 播放三轴（随机 / 循环 / 电台）的引擎切片：只取状态读写 + 链上取下一首这两段纯逻辑，
// 队列、当前歌、专辑上下文全用 stub。
function harness(store = {}, state = {}) {
  const data = Object.assign({}, store);
  const context = vm.createContext({
    albumQueueId: state.albumQueueId === undefined ? null : state.albumQueueId,
    playlist: state.playlist || [],
    current: state.current === undefined ? -1 : state.current,
    chainOrder: state.chainOrder || [],
    localStorage: {
      getItem: key => (key in data ? data[key] : null),
      setItem: (key, value) => { data[key] = String(value); },
      removeItem: key => { delete data[key]; },
    },
  });
  vm.runInContext(
    source.slice(source.indexOf('  // ---------- 播放三轴'), source.indexOf('  // ---------- 会话记忆')),
    context,
  );
  return {context, data};
}
const axes = data => ({bmShuffle: data.bmShuffle, bmLoop: data.bmLoop});
const ids = n => Array.from({length: n}, (_, i) => ({id: i + 1}));
const sorted = chain => Array.from(chain).sort((a, b) => a - b);

test('随机与循环是两条独立的轴：任一方开合都不动另一方', () => {
  const {context: c} = harness();
  assert.equal(c.shuffleOn(), false);
  assert.equal(c.loopMode(), 'off');
  c.setShuffleOn(true);
  c.setLoopMode('all');
  assert.equal(c.shuffleOn(), true);
  assert.equal(c.loopMode(), 'all');  // 旧版把随机写进 bmPlayMode，这里会把循环顶掉
  c.setShuffleOn(false);
  assert.equal(c.loopMode(), 'all');  // 关随机同样不牵连循环
  c.setLoopMode('one');
  assert.equal(c.shuffleOn(), false);
  assert.equal(c.loopMode(), 'one');
});

test('循环轴取值收敛：非 all/one 一律当 off，电台仍独立', () => {
  const {context: c, data} = harness({bmLoop: 'bogus', bmShuffle: '1', bmRadio: '1'});
  assert.equal(c.loopMode(), 'off');
  c.setLoopMode('off');
  assert.equal(data.bmLoop, 'off');
  assert.equal(data.bmRadio, '1');    // 循环的写入碰不到电台
  assert.equal(c.shuffleOn(), true);
});

test('迁移：旧的单一 bmPlayMode 拆成随机/循环两条轴', () => {
  assert.deepEqual(axes(harness({bmPlayMode: 'order'}).data), {bmShuffle: '0', bmLoop: 'off'});
  assert.deepEqual(axes(harness({bmPlayMode: 'loop'}).data), {bmShuffle: '0', bmLoop: 'all'});
  assert.deepEqual(axes(harness({bmPlayMode: 'random'}).data), {bmShuffle: '1', bmLoop: 'off'});
  assert.deepEqual(axes(harness({bmRepeatOne: '1'}).data), {bmShuffle: '0', bmLoop: 'one'});
  // 旧版下这两个键可以同时为真（随机胶囊亮着、循环胶囊也亮着）→ 两条轴都保留
  assert.deepEqual(axes(harness({bmRepeatOne: '1', bmPlayMode: 'random'}).data), {bmShuffle: '1', bmLoop: 'one'});
});

test('迁移只跑一次：已写过新键就不再被旧键覆盖', () => {
  const {data} = harness({bmShuffle: '1', bmLoop: 'one', bmPlayMode: 'order', bmRepeatOne: '0'});
  assert.equal(data.bmShuffle, '1');
  assert.equal(data.bmLoop, 'one');
});

test('随机顺序是队列的一个排列，且当前歌排头（不循环也放得完整队）', () => {
  const {context: c} = harness({bmShuffle: '1'}, {playlist: ids(8), current: 4});
  const chain = c.shuffleChainIds();
  assert.equal(chain.length, 8);
  assert.deepEqual(sorted(chain), [1, 2, 3, 4, 5, 6, 7, 8]); // 不漏一首、不重一首
  assert.equal(chain[0], 5);                                   // playlist[current].id
});

test('切歌不重排随机顺序；重新开启随机才作废缓存', () => {
  const {context: c} = harness({bmShuffle: '1'}, {playlist: ids(8), current: 4});
  const before = c.shuffleChainIds();
  c.current = 6;                                  // 播到下一首
  assert.deepEqual(c.shuffleChainIds(), before);  // 顺序不动，上一首/下一首才有意义
  c.setShuffleOn(true);
  assert.equal(c.shuffleIds, null);               // 重新开启＝重掷一套
  c.current = 4;
  assert.deepEqual(sorted(c.shuffleChainIds()), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('循环 off 到队尾即止，all 才环绕', () => {
  const off = harness({}, {playlist: ids(3), current: 2, chainOrder: [1, 2, 3]}).context;
  assert.equal(off.chainNextIndex(1), -1);   // 队尾不再往下走
  off.setLoopMode('all');
  assert.equal(off.chainNextIndex(1), 0);    // 环绕回第一首

  const head = harness({bmLoop: 'all'}, {playlist: ids(3), current: 0, chainOrder: [1, 2, 3]}).context;
  assert.equal(head.chainNextIndex(-1), 2);  // 队首往回 → 末尾
});

test('随机＋列表循环：环绕也走在打乱后的顺序上', () => {
  const {context: c} = harness({bmShuffle: '1', bmLoop: 'all'}, {playlist: ids(6), current: 0});
  const chain = c.shuffleChainIds();
  c.chainOrder = chain;
  for (let i = 0; i < chain.length; i++) {
    c.current = c.chainNextIndex(1);
    assert.notEqual(c.current, -1);          // 环绕：绕着打乱顺序一直有下一首
  }
});

test('专辑队列无视随机与循环，始终按源顺序走到头就停', () => {
  const {context: c} = harness(
    {bmShuffle: '1', bmLoop: 'all'},
    {playlist: ids(3), current: 2, chainOrder: [1, 2, 3], albumQueueId: '9'},
  );
  assert.equal(c.shuffleOn(), true);
  c.setLoopMode('all');
  assert.equal(c.chainNextIndex(1), -1);     // 专辑不环绕
});
