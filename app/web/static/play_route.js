/* 点歌路由的纯逻辑：按 id 在队列里查歌（字符串/数字 id 混用安全）。
   契约：曲库/队列点歌＝只播查到的这首，绝不因 song.albumId 展开整张专辑——
   「从这首播整张」只属于专辑/合集详情行的显式 data-album 入口（点击委托分支）。
   浏览器挂载 window.BiliPlayRoute；node --test 可直接 require（同 norm.js 惯例）。 */
(function (root) {
  "use strict";

  function findSong(playlist, want) {
    var key = String(want);
    for (var i = 0; i < playlist.length; i++) {
      if (String(playlist[i].id) === key) return playlist[i];
    }
    return null;
  }

  var BiliPlayRoute = { findSong: findSong };
  root.BiliPlayRoute = BiliPlayRoute;
  if (typeof module !== "undefined" && module.exports) module.exports = BiliPlayRoute;
})(typeof window !== "undefined" ? window : globalThis);
