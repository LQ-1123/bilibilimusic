/* ============================================================
   应用壳 + 交互编排（demo：内存模拟；真实实现替换为 /api/* 调用）
   ============================================================ */
import { ICONS as K, esc, fmt, coverArt, $ } from './ui.js';
import { DB } from './data.js';
import {
  state, render, renderChrome, renderPlaybar, renderNowPlaying, renderQueue,
  renderJobs, applyTheme, go, openDetail, goBack,
  toast, openModal, closeModal, openSheet, openLogin,
} from './views.js';

/* ================= 静态骨架 ================= */
$('#app').innerHTML = `
  <!-- 桌面侧栏 -->
  <aside class="sidebar">
    <div class="sidebar__brand">
      <img class="sidebar__logo" src="../app/web/static/logo.png" alt="" onerror="this.outerHTML='<span class=&quot;avatar&quot; style=&quot;border-radius:8px&quot;>B</span>'">
      <span class="sidebar__name">Bili<em>Music</em></span>
    </div>
    <nav class="nav" aria-label="主导航"></nav>
    <div class="sidebar__section">
      <div class="sidebar__section-head"><span>歌单</span>
        <button class="icon-btn" id="side-pl-new" aria-label="新建歌单">${K.plus}</button></div>
      <div class="plist"></div>
    </div>
    <div class="sidebar__foot">
      <button class="account-chip" id="account-chip">
        <span class="avatar">${esc(DB.account.username.slice(0, 1))}</span>
        <span class="account-chip__meta">
          <span class="account-chip__name"></span>
          <span class="account-chip__sub"></span>
        </span>
        ${K.settings}
      </button>
    </div>
  </aside>

  <!-- 主区 -->
  <div class="main">
    <header class="topbar">
      <div class="topbar__nav">
        <button class="icon-btn" id="nav-back" aria-label="后退">${K.back}</button>
        <button class="icon-btn" id="nav-fwd" aria-label="前进" disabled>${K.forward}</button>
      </div>
      <div class="searchbox" role="search">
        ${K.search}
        <input id="global-q" placeholder="搜索 B 站视频、UP 主，或粘贴链接导入" aria-label="全局搜索">
      </div>
      <div class="topbar__right">
        <button class="btn btn--ghost btn--sm" id="top-import">${K.import} 导入</button>
        <button class="icon-btn" id="jobs-toggle" aria-label="任务">${K.download}</button>
        <button class="icon-btn" id="theme-toggle" aria-label="切换主题">${state.theme === 'light' ? K.moon : K.sun}</button>
      </div>
    </header>
    <div class="main__scroll" tabindex="-1"></div>
  </div>

  <!-- 底部播放条 -->
  <footer class="playbar" style="display:none">
    <div class="playbar__track"></div>
    <div class="playbar__center">
      <div class="playbar__btns"></div>
      <div class="playbar__seek"></div>
    </div>
    <div class="playbar__tools"></div>
  </footer>

  <!-- 移动底部 Tab -->
  <nav class="tabbar" aria-label="主导航"></nav>

  <!-- 全屏播放页 -->
  <section class="nowplaying" aria-label="正在播放">
    <div class="nowplaying__bg"></div>
    <div class="nowplaying__top">
      <button class="icon-btn icon-btn--lg" id="np-close" aria-label="收起">${K.collapse}</button>
      <span class="nowplaying__srclabel">正在播放 · <span id="np-src">曲库</span></span>
      <button class="icon-btn icon-btn--lg" aria-label="更多">${K.more}</button>
    </div>
    <div class="nowplaying__body">
      <div class="np-left"></div>
      <div class="np-lyrics" aria-label="歌词"></div>
    </div>
  </section>

  <!-- 队列抽屉 -->
  <aside class="queue-panel" aria-label="播放队列">
    <div class="queue-panel__head">
      <span class="queue-panel__title">播放队列</span>
      <button class="btn btn--sm btn--ghost" id="q-clear">清空</button>
    </div>
    <div class="queue-panel__list"></div>
  </aside>

  <!-- 任务抽屉 -->
  <aside class="jobs-panel hidden" aria-label="任务">
    <div class="jobs-panel__head"><span class="jobs-panel__title">导入与同步</span>
      <button class="icon-btn" id="jobs-close">${K.close}</button></div>
    <div class="jobs-panel__list"></div>
  </aside>

  <div class="toast-wrap" aria-live="polite"></div>
`;

/* ================= 播放器（模拟时钟） ================= */
let clock = null;
function playSong(song, list, src) {
  if (list) {
    state.queue = list.map(s => ({ ...s, _src: src }));
    state.queueIndex = state.queue.findIndex(s => s.id === song.id);
  } else if (!state.queue.some(q => q.id === song.id)) {
    state.queue.push({ ...song, _src: src });
    state.queueIndex = state.queue.length - 1;
  } else {
    state.queueIndex = state.queue.findIndex(q => q.id === song.id);
  }
  state.position = 0;
  state.duration = song.duration;
  state.playing = true;
  document.body.classList.add('is-playing');
  startClock();
  renderPlaybar(); renderQueue();
  if (state.nowOpen) renderNowPlaying();
}
function startClock() {
  clearInterval(clock);
  clock = setInterval(() => {
    if (!state.playing) return;
    state.position = Math.min(state.position + 1, state.duration);
    // 只更新数值与填充，不重渲整条播放条（性能 #6）
    const pct = state.duration ? state.position / state.duration * 100 : 0;
    $('.playbar')?.style.setProperty('--pb', pct + '%');
    document.querySelectorAll('.playbar__time').forEach(n => {
      n.textContent = fmt(n === n.parentElement.firstElementChild ? state.position : state.duration);
    });
    ['#pb-seek', '#np-seek'].forEach(sel => { const s = $(sel); if (s && document.activeElement !== s) { s.value = state.position; s.style.setProperty('--val', pct + '%'); } });
    if (state.position >= state.duration) next();
  }, 1000);
}
function toggle() {
  state.playing = !state.playing;
  document.body.classList.toggle('is-playing', state.playing);
  document.querySelectorAll('[data-toggle]').forEach(b => b.innerHTML = state.playing ? K.pause : K.play);
}
function next() {
  if (!state.queue.length) return;
  if (state.mode === 'one') { state.position = 0; return; }
  if (state.mode === 'random') state.queueIndex = Math.floor(Math.random() * state.queue.length);
  else state.queueIndex = (state.queueIndex + 1) % state.queue.length;
  playSong(state.queue[state.queueIndex], null, state.queue[state.queueIndex]._src);
}
function prevSong() {
  if (state.position > 4) { state.position = 0; return; }
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  playSong(state.queue[state.queueIndex], null, state.queue[state.queueIndex]._src);
}
const MODE_NEXT = { order: 'loop', loop: 'random', random: 'one', one: 'order' };
const MODE_LABEL = { order: '顺序播放', loop: '列表循环', random: '随机播放', one: '单曲循环' };

/* ================= 单曲菜单（Action Sheet） ================= */
function songMenu(id) {
  const s = DB.songs.find(x => x.id === id) || state.queue.find(x => x.id === id);
  if (!s) return;
  openSheet([
    { icon: 'play', label: '播放', onPick: () => playSong(s, null, '曲库') },
    { icon: 'queue', label: '下一首播放', onPick: () => { state.queue.splice(state.queueIndex + 1, 0, { ...s, _src: '曲库' }); renderQueue(); toast('已加入下一首播放'); } },
    { icon: 'plus', label: '添加到歌单…', onPick: () => pickPlaylist(s) },
    { icon: s.liked ? 'starFill' : 'star', label: s.liked ? '移出曲库' : '星标收藏', onPick: () => { s.liked = !s.liked; toast(s.liked ? '已星标' : '已移出曲库'); renderPlaybar(); } },
    { icon: 'album', label: '进入专辑', onPick: () => openDetail('album', s.albumId || 11) },
    { icon: 'share', label: '分享', onPick: () => toast('已复制 B 站链接') },
    { icon: 'trash', label: '删除（同步取消 B 站收藏）', danger: true, onPick: () => confirmDelete(s) },
  ], s.title);
}
function pickPlaylist(s) {
  openSheet(DB.playlists.map(p => ({
    icon: 'folder', label: p.name, onPick: () => { s.playlistId = p.id; toast(`已加入「${p.name}」`); render(); }
  })), '添加到歌单');
}
function confirmDelete(s) {
  openModal(`
    <div class="modal__head"><span class="modal__title">删除「${esc(s.title)}」？</span></div>
    <div class="modal__body" style="font-size:var(--fs-md);color:var(--text-2);line-height:1.7">
      将从本地曲库移除，并<strong style="color:var(--text)">同步取消 B 站收藏</strong>。<br>
      若取消收藏失败，会在下次同步时自动重试。
    </div>
    <div class="modal__foot">
      <button class="btn btn--ghost" onclick="this.closest('.modal-mask').remove()">取消</button>
      <button class="btn" style="background:var(--red);color:#fff;border-color:transparent" id="del-ok">删除</button>
    </div>`);
  $('#del-ok').onclick = () => {
    const i = DB.songs.findIndex(x => x.id === s.id);
    if (i >= 0) DB.songs.splice(i, 1);
    closeModal(); toast('已删除，B 站收藏将同步取消'); render();
  };
}

/* ================= 事件编排 ================= */
document.addEventListener('click', e => {
  const t = e.target;

  const nav = t.closest('[data-nav]');
  if (nav) { go(nav.dataset.nav); return; }

  const pl = t.closest('[data-pl]');
  if (pl) { openDetail('playlist', +pl.dataset.pl); return; }
  const plsel = t.closest('[data-plsel]');
  if (plsel) { state.playlistId = +plsel.dataset.plsel; render(); return; }

  const songEl = t.closest('[data-song]');
  if (songEl && !t.closest('[data-menu]') && !t.closest('[data-album]')) {
    const s = DB.songs.find(x => x.id === +songEl.dataset.song);
    if (s) {
      const list = [...songEl.closest('.tracklist, .quickgrid').querySelectorAll('[data-song]')]
        .map(n => DB.songs.find(x => x.id === +n.dataset.song)).filter(Boolean);
      playSong(s, list, songEl.dataset.src === 'album' ? '专辑' : '曲库');
    }
    return;
  }

  const menu = t.closest('[data-menu]');
  if (menu) { songMenu(+menu.dataset.menu); return; }
  const alb = t.closest('[data-album]');
  if (alb) { openDetail('album', +alb.dataset.album); return; }

  const cd = t.closest('[data-card-kind]');
  if (cd) {
    const { cardKind, cardId } = cd.dataset;
    if (cardKind === 'album') openDetail('album', +cardId);
    else if (cardKind === 'radio') toast('打开电台：' + cardId);
    else toast('试听推荐曲目');
    return;
  }
  const up = t.closest('[data-up]');
  if (up) { openDetail('up', +up.dataset.up); return; }

  if (t.closest('#nav-back')) { goBack(); return; }
  if (t.closest('#theme-toggle')) {
    document.documentElement.classList.add('theme-anim');
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('bmTheme', state.theme);
    applyTheme();
    $('#theme-toggle').innerHTML = state.theme === 'light' ? K.moon : K.sun;
    setTimeout(() => document.documentElement.classList.remove('theme-anim'), 350);
    return;
  }

  if (t.closest('[data-toggle]')) { toggle(); return; }
  if (t.closest('[data-next]')) { next(); return; }
  if (t.closest('[data-prev]')) { prevSong(); return; }
  if (t.closest('[data-mode]')) {
    state.mode = MODE_NEXT[state.mode];
    localStorage.setItem('bmPlayMode', state.mode);
    toast(MODE_LABEL[state.mode]);
    renderPlaybar(); if (state.nowOpen) renderNowPlaying();
    return;
  }
  if (t.closest('[data-like]')) { const c = state.queue[state.queueIndex]; if (c) { c.liked = !c.liked; renderPlaybar(); } return; }

  if (t.closest('#np-open') || t.closest('[data-lyric-open]')) { state.nowOpen = true; renderNowPlaying(); return; }
  if (t.closest('#np-close')) { state.nowOpen = false; renderNowPlaying(); return; }
  if (t.closest('[data-queue-open]')) { state.queueOpen = !state.queueOpen; renderQueue(); return; }
  if (t.closest('#q-clear')) { state.queue = []; state.queueIndex = -1; state.playing = false; renderQueue(); renderPlaybar(); return; }
  const qj = t.closest('[data-qjump]');
  if (qj && !t.closest('[data-qrm]')) { state.queueIndex = +qj.dataset.qjump; playSong(state.queue[state.queueIndex], null, '队列'); return; }
  const qrm = t.closest('[data-qrm]');
  if (qrm) { state.queue.splice(+qrm.dataset.qrm, 1); renderQueue(); return; }

  if (t.closest('#jobs-toggle')) { state.jobsOpen = !state.jobsOpen; renderJobs(); return; }
  if (t.closest('#jobs-close')) { state.jobsOpen = false; renderJobs(); return; }

  if (t.closest('#account-chip')) { go('account'); return; }
  if (t.closest('#top-import') || t.closest('#import-btn')) { go('library'); setTimeout(() => $('#import-input')?.focus(), 50); return; }
  if (t.closest('#pl-new') || t.closest('#side-pl-new')) {
    openModal(`
      <div class="modal__head"><span class="modal__title">新建歌单</span></div>
      <div class="modal__body">
        <div class="field"><label class="field__label">名称</label>
          <input class="field__input" id="pl-name" maxlength="16" placeholder="最多 16 个字">
          <span class="field__hint">将在 B 站同步创建收藏夹「bilimusic- 名称」</span></div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" onclick="this.closest('.modal-mask').remove()">取消</button>
        <button class="btn btn--primary" id="pl-create">创建</button>
      </div>`);
    $('#pl-create').onclick = () => {
      const name = $('#pl-name').value.trim();
      if (!name) return;
      DB.playlists.push({ id: Math.max(...DB.playlists.map(p => p.id)) + 1, name, deletable: true, folderIds: [] });
      closeModal(); toast(`已创建「${name}」，B 站收藏夹同步建立中`); render();
    };
    return;
  }
  if (t.closest('[data-play-daily]')) { playSong(DB.songs[0], DB.songs.slice(0, 8), '每日精选'); toast('播放每日精选'); return; }
  if (t.closest('[data-refresh-recs]')) { toast('已换一批推荐'); return; }
  if (t.closest('#sync-now')) { toast('同步中：拉取 B 站收藏夹…'); setTimeout(() => toast('同步完成：拉取 12 首 · 补收藏 2 首'), 1400); return; }
  if (t.closest('#logout')) {
    openModal(`
      <div class="modal__head"><span class="modal__title">退出登录？</span></div>
      <div class="modal__body" style="color:var(--text-2);line-height:1.7">将清除本机的登录凭据与缓存（队列 / 歌词 / 封面），不影响 B 站收藏。</div>
      <div class="modal__foot">
        <button class="btn btn--ghost" onclick="this.closest('.modal-mask').remove()">取消</button>
        <button class="btn" style="background:var(--red);color:#fff;border-color:transparent" onclick="this.closest('.modal-mask').remove()">退出登录</button>
      </div>`);
    return;
  }
  if (t.closest('#export-open')) { toast('导出任务已创建（demo）'); state.jobsOpen = true; renderJobs(); return; }
  if (t.closest('#materialize')) { toast('正在补建剩余分 P…（懒物化）'); return; }
  if (t.closest('[data-detail-menu]')) {
    const d = state.detail;
    openSheet([
      { icon: 'edit', label: '重命名', onPick: () => toast('重命名（demo）') },
      { icon: 'share', label: '分享到 B 站', onPick: () => toast('已复制分享链接') },
      { icon: 'trash', label: d?.kind === 'album' ? '删除合集（批量取消 B 站收藏）' : '删除歌单（歌曲移入默认）', danger: true, onPick: () => { goBack(); toast('已删除'); } },
    ], '操作');
    return;
  }
  const lyr = t.closest('.lyric-line');
  if (lyr) { state.position = +lyr.dataset.t; renderPlaybar(); renderNowPlaying(); return; }
});

/* 输入与滑条 */
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'lib-q') { state.libQuery = t.value; render(); $('#lib-q')?.focus(); return; }
  if (t.classList?.contains('slider')) {
    const pct = (t.value - t.min) / (t.max - t.min) * 100;
    t.style.setProperty('--val', pct + '%');
    if (t.id === 'pb-vol') { state.volume = +t.value; localStorage.setItem('bmVolume', state.volume); }
    else { state.position = +t.value; document.querySelectorAll('.playbar__time').forEach((n, i) => n.textContent = fmt(i % 2 ? state.duration : state.position)); }
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'lib-sort') { state.libSort = t.value; render(); }
  if (t.id === 'theme-sel') { state.theme = t.value; localStorage.setItem('bmTheme', t.value); applyTheme(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); const { nowOpen, queueOpen } = state; if (nowOpen) { state.nowOpen = false; renderNowPlaying(); } if (queueOpen) { state.queueOpen = false; renderQueue(); } }
  // 空格播放/暂停（#8：焦点在输入框时不劫持）
  if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
    e.preventDefault(); toggle();
  }
  if (e.key === 'Enter' && e.target.id === 'global-q') { state.searchQuery = e.target.value; go('search'); }
  if (e.key === 'Enter' && e.target.id === 'import-input') { toast('已提交导入任务'); state.jobsOpen = true; renderJobs(); e.target.value = ''; }
});

/* 启动后再绑定搜索框（骨架已注入 DOM） */
$('#global-q').addEventListener('input', e => { state.searchQuery = e.target.value; if (state.view === 'search') render(); });
$('#global-q').addEventListener('keydown', e => { if (e.key === 'Enter') { state.searchQuery = e.target.value; go('search'); } });

/* 系统主题跟随 */
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.theme === 'system') applyTheme(); });

/* ================= 启动 ================= */
applyTheme();
render();
renderJobs();
// 演示：预置一个播放中的状态，让播放条可见
playSong(DB.songs[15], DB.songs, '曲库');
state.playing = false;
document.body.classList.remove('is-playing');
renderPlaybar();
if (!state.loggedIn) openLogin();
