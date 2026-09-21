/* 点歌路由回归（bug：合集单曲收藏进曲库后，点播被整张合集接管队列）：
   findSong 只按 id 查歌、返回单曲本身——路由决策已在 app.js 收敛为
   「详情行显式 data-album 才 playAlbum，其余一律 playSongSmart(findSong(...))」。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../app/web/static/play_route.js');

test('按 id 查歌：字符串/数字 id 混用安全，返回单曲本体', () => {
  const playlist = [{id: 7, albumId: 3, title: '合集单曲'}, {id: 8}];
  assert.equal(R.findSong(playlist, '7'), playlist[0]);
  assert.equal(R.findSong(playlist, 7), playlist[0]);
  assert.equal(R.findSong(playlist, 8), playlist[1]);
});

test('查不到返回 null（调用方据此走「拉全量再重试」路径）', () => {
  assert.equal(R.findSong([{id: 1}], '99'), null);
  assert.equal(R.findSong([], '1'), null);
});

test('契约：结果不做任何专辑展开——单曲返回时 albumId 原样保留但路由方不再消费它', () => {
  const hit = R.findSong([{id: 7, albumId: 3}], '7');
  assert.equal(hit.albumId, 3); // 数据仍在（详情页「进专辑」入口要用）
  assert.deepEqual(Object.keys(R), ['findSong']); // 模块只提供查歌，展开只存在于详情行 data-album 分支
});
