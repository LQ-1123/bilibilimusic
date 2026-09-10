const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/web/static/app.js', 'utf8');
function harness(pages) {
  const calls = [], played = [], notices = [];
  let page = 0;
  const context = vm.createContext({
    albumQueueId: null, queueGeneration: 0, refreshGeneration: 0, currentQuery: '', playlist: [], current: -1,
    sessionRestored: true, chainOrder: [], naturalPlan: null, recActive: false, repeatOne: true,
    localStorage: {getItem: () => 'random'},
    window: {__toast: message => notices.push(message)},
    fetch: async (url, options) => {calls.push([url, options.method]); if (options.method === 'POST') page++; return {ok: true, json: async () => pages[page]};},
    fetchSongs: async () => [{id: 900, trackNo: 1}],
    audio: {pause() {context.paused = true;}},
    cancelTransition() {}, restoreSession() {},
    planChain() { context.chainOrder = context.playlist.map(song => song.id); },
    playSong(song) {context.current = context.playlist.findIndex(item => item.id === song.id); played.push(song.id); context.planChain();},
    stopTrial() {}, smartEnabled: () => false,
    mirror: null,   // app.js 的镜像态开关（#29）；skip() 切片执行时需要这个初始值
  });
  vm.runInContext(source.slice(source.indexOf('  function orderedAlbumSongs('), source.indexOf('  function playSong(song)')), context);
  vm.runInContext(source.slice(source.indexOf('  function playMode()'), source.indexOf('  // ---------- 会话记忆')), context);
  vm.runInContext(source.slice(source.indexOf('  function skip(delta)'), source.indexOf('  document.addEventListener("click"', source.indexOf('  function skip(delta)'))), context);
  return {context, calls, played, notices};
}
const song = n => ({id: n, trackNo: n});
test('whole album loads bounded pages and clicked P follows source order despite random mode', async () => {
  const {context: c, calls, played} = harness([
    {songs: [song(2)], hasMore: true, materializedPages: 1},
    {songs: [song(3), song(1), song(2)], hasMore: false, materializedPages: 3},
  ]);
  await c.playAlbum(4, 2);
  assert.deepEqual(calls.map(call => call[1]), ['GET', 'POST']);
  assert.deepEqual(Array.from(c.playlist, item => item.id), [1, 2, 3]);
  c.skip(1); c.skip(1);
  assert.deepEqual(played, [2, 3]);
  assert.equal(c.paused, true);
});
test('refresh retains album context, removes hidden tracks, never truncates to global library', async () => {
  const data = {songs: [song(3), song(1), song(2)], hasMore: false};
  const {context: c} = harness([data]);
  await c.playAlbum(5, 1);
  data.songs = [song(3), song(1)];
  await c.refreshPlaylist();
  assert.equal(c.albumQueueId, '5');
  assert.deepEqual(Array.from(c.playlist, item => item.id), [1, 3]);
  assert.equal(c.current, 0);
  data.songs = [song(3)]; await c.refreshPlaylist(); assert.equal(c.paused, true);
  c.albumQueueId = null; ++c.queueGeneration;
  await c.refreshPlaylist();
  assert.deepEqual(Array.from(c.playlist, item => item.id), [900]);
});
test('late album response cannot replace a newer playback selection', async () => {
  const {context: c, played} = harness([]);
  let finish;
  c.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = c.playAlbum(8);
  ++c.queueGeneration;
  finish({ok: true, json: async () => ({songs: [song(1)], hasMore: false})});
  await pending;
  assert.deepEqual(played, []);
  assert.equal(c.albumQueueId, null);
});
test('partial load failure leaves existing queue intact and reports failure', async () => {
  const {context: c, played, notices} = harness([{songs: [song(1)], hasMore: true, materializedPages: 1}]);
  c.playlist = [song(99)];
  c.fetch = async (url, options) => options.method === 'POST' ? {ok: false, status: 503} : {ok: true, json: async () => ({songs: [song(1)], hasMore: true, materializedPages: 1})};
  await c.playAlbum(8);
  assert.deepEqual(played, []);
  assert.equal(c.playlist[0].id, 99);
  assert.equal(notices.length, 1);
});
