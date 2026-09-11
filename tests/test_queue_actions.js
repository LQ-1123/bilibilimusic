const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app/web/static/app.js', 'utf8');

// 队列行的移除 / 清除（v2.1 右侧栏）：只切片这两个纯函数，容器与时钟全用 stub
function harness(state = {}) {
  const notices = [];
  const context = vm.createContext({
    playlist: state.playlist || [],
    current: state.current === undefined ? -1 : state.current,
    window: Object.assign({}, state.window, { __toast: (m) => notices.push(m) }),
    renderQueue() { context.rendered = (context.rendered || 0) + 1; },
    planChain() { context.planned = (context.planned || 0) + 1; },
  });
  vm.runInContext(
    source.slice(source.indexOf('  function removeQueueItem('), source.indexOf('  // v2.1 队列双壳（手机=播放页内视图')),
    context,
  );
  return { context, notices };
}

test('移除：曲库队列删一首后重排决策链，游标跟着前移', () => {
  const songs = [{id: 1}, {id: 2}, {id: 3}];
  const {context} = harness({playlist: songs.slice(), current: 2});
  context.removeQueueItem(songs[0]);
  assert.deepEqual(Array.from(context.playlist, (s) => s.id), [2, 3]);
  assert.equal(context.current, 1);       // 当前歌在删除项之后，下标前移
  assert.equal(context.planned, 1);       // 顺序交给决策链重排
  assert.equal(context.rendered, undefined); // 不自己渲染，由 planChain 收口
});

test('移除：试听队列删项后游标不被跳过', () => {
  const items = [{bvid: 'A'}, {bvid: 'B'}, {bvid: 'C'}];
  const queue = {items: items, i: 2};     // 正在放 C
  const {context} = harness({window: {__trialQueue: queue}});
  context.removeQueueItem(items[0]);       // 删掉排在前面的 A
  assert.equal(queue.i, 1);                // 游标跟着前移，仍指向 C
  assert.deepEqual(Array.from(queue.items, (it) => it.bvid), ['B', 'C']);
  assert.equal(context.rendered, 1);
});

test('清除：留着正在放的那首，只清后面待播的', () => {
  const songs = [{id: 1}, {id: 2}, {id: 3}];
  const {context} = harness({playlist: songs.slice(), current: 1});
  context.clearUpcoming();
  assert.deepEqual(Array.from(context.playlist, (s) => s.id), [2]);
  assert.equal(context.current, 0);
  assert.equal(context.planned, 1);
});

test('清除：试听队列同步收敛到当前项', () => {
  const items = [{bvid: 'A'}, {bvid: 'B'}, {bvid: 'C'}];
  const queue = {items: items, i: 1};
  const {context} = harness({window: {__trialQueue: queue}});
  context.clearUpcoming();
  assert.deepEqual(Array.from(queue.items, (it) => it.bvid), ['B']);
  assert.equal(queue.i, 0);
});
