/* ============================================================
   视图层：渲染各页面 + 交互（demo 用内存数据模拟）
   真实实现时：把 DB 换成 /api/* fetch，行为不变
   ============================================================ */
import { ICONS as K, esc, fmt, coverArt, heroColor, $, el } from './ui.js';
import { DB, LYRICS } from './data.js';

export const state = {
  view: 'home',           // home | library | search | account | detail
  detail: null,           // {kind:'album'|'playlist'|'up', id}
  playlistId: 0,
  libQuery: '', libSort: 'createdAt',
  searchQuery: '', searchTab: 'all',
  theme: localStorage.getItem('bmTheme') || 'dark',
  queue: [], queueIndex: -1, queueSrc: '',
  playing: false, position: 0, duration: 0,
  mode: localStorage.getItem('bmPlayMode') || 'order',   // order | loop | one | random
  volume: +(localStorage.getItem('bmVolume') ?? .8),
  nowOpen: false, queueOpen: false,
  jobsOpen: false,
  backStack: [],
  loggedIn: DB.account.loggedIn,
};

/* ================= 框架渲染 ================= */
export function applyTheme() {
  document.documentElement.dataset.theme = state.theme === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : state.theme;
}

const NAV = [
  { key: 'home', label: '首页', icon: 'home' },
  { key: 'library', label: '曲库', icon: 'library' },
  { key: 'search', label: '搜索', icon: 'search' },
  { key: 'account', label: '账号', icon: 'account' },
];

export function renderChrome() {
  // 侧栏
  $('.nav').innerHTML = NAV.map(n => `
    <button class="nav__item ${state.view === n.key && !state.detail ? 'is-active' : ''}" data-nav="${n.key}" aria-label="${n.label}">
      ${K[n.icon]}<span>${n.label}</span>
    </button>`).join('');
  // 侧栏歌单
  $('.plist').innerHTML = DB.playlists.map(p => `
    <button class="plist__item ${state.detail?.kind === 'playlist' && state.detail.id === p.id ? 'is-active' : ''}" data-pl="${p.id}">
      <span class="plist__icon">${K.folder}</span>
      <span class="ellip">${esc(p.name)}</span>
      <span class="plist__count num">${DB.songs.filter(s => s.playlistId === p.id || p.id === 0).length}</span>
    </button>`).join('');
  // 账户 chip
  $('.account-chip__name').textContent = state.loggedIn ? DB.account.username : '未登录';
  $('.account-chip__sub').innerHTML = state.loggedIn
    ? `<span class="account-chip__dot"></span>在线 · ${DB.account.maxQuality}`
    : '点击扫码登录';
  // 移动 Tab
  $('.tabbar').innerHTML = NAV.map(n => `
    <button class="tabbar__item ${state.view === n.key && !state.detail ? 'is-active' : ''}" data-nav="${n.key}">
      ${K[n.icon]}<span>${n.label}</span>
    </button>`).join('');
}

/* ================= 曲目行 ================= */
function trackRow(s, i, opts = {}) {
  const cur = state.queue[state.queueIndex];
  const isPlaying = !!cur && ((s.id && cur.id === s.id) || (s.bvid && cur.bvid === s.bvid));
  return `
  <div class="track ${isPlaying ? 'is-playing' : ''}" role="button" tabindex="0" data-song="${s.id}" data-src="${opts.src || 'library'}" aria-label="播放 ${esc(s.title)}">
    <div class="track__idx"><span class="num">${i + 1}</span><span class="eq"><i></i><i></i><i></i></span></div>
    <div class="cover track__cover"><img src="${coverArt(s.title, 96)}" alt="" loading="lazy"></div>
    <div class="track__main">
      <div class="track__title">${esc(s.title)} ${s.qualityLabel ? `<span class="badge">${s.qualityLabel}</span>` : ''}</div>
      <div class="track__artist">${esc(s.artist)}</div>
    </div>
    ${s.albumId ? `<button class="track__album" data-album="${s.albumId}" title="进入专辑">${K.album} ${esc(DB.albums.find(a => a.id === s.albumId)?.title || '专辑')}</button>` : `<span class="track__album" style="pointer-events:none"></span>`}
    <div class="track__dur num">${fmt(s.duration)}</div>
    <button class="icon-btn track__more" data-menu="${s.id}" aria-label="更多操作">${K.more}</button>
  </div>`;
}

function card(item, { sub, round = false, kind, id }) {
  return `
  <button class="card ${round ? 'card--round' : ''}" data-card-kind="${kind}" data-card-id="${id}">
    <div class="card__art">
      ${round || !item.mosaic ? `<img src="${item.cover || coverArt(item.title || item.name, 340)}" alt="" loading="lazy">` : item.mosaic}
      <span class="card__play" role="presentation">${K.play}</span>
    </div>
    <div class="card__title ellip">${esc(item.title || item.name)}</div>
    <div class="card__sub ellip">${esc(sub)}</div>
  </button>`;
}

/* ================= 页面：首页 ================= */
function viewHome() {
  const hour = new Date().getHours();
  const hi = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  const recent = DB.songs.slice(0, 6);
  const daily = DB.recs.slice(0, 3);
  const genreShelves = DB.genres.slice(0, 4);

  return `
  <div class="home-greet">
    <div class="home-greet__hi">${hi}</div>
    <div class="home-greet__date">${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })} · 曲库 ${DB.songs.length} 首</div>
  </div>

  <div class="quickgrid">
    ${recent.map(s => `
      <button class="quick" data-song="${s.id}">
        <span class="cover quick__cover"><img src="${coverArt(s.title, 120)}" alt="" loading="lazy"></span>
        <span class="quick__title ellip">${esc(s.title)}</span>
        <span class="eq quick__eq"><i></i><i></i><i></i></span>
      </button>`).join('')}
  </div>

  <section class="section">
    <div class="daily">
      <div class="daily__covers">
        ${daily.map(r => `<span class="cover"><img src="${coverArt(r.title, 200)}" alt=""></span>`).join('')}
      </div>
      <div class="daily__meta">
        <div class="daily__kicker">每日精选</div>
        <div class="daily__title">为你挑选的 ${DB.recs.length} 首</div>
        <div class="daily__desc">基于你最近播放的「${esc(DB.songs[0].title)}」 · 每天更新，当天不变</div>
      </div>
      <div class="daily__actions">
        <button class="btn btn--play-hero" data-play-daily>${K.play} 播放</button>
        <button class="btn btn--ghost" data-refresh-recs>${K.refresh} 换一批</button>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="section__head"><h2 class="section__title">推荐歌单</h2><button class="section__more">查看全部 ${K.forward}</button></div>
    <div class="shelf">
      ${DB.radios.map(r => card({ ...r, cover: coverArt(r.name, 340) }, { sub: r.desc, kind: 'radio', id: r.key })).join('')}
    </div>
  </section>

  ${genreShelves.map(g => `
  <section class="section">
    <div class="section__head"><h2 class="section__title">${esc(g)}</h2><button class="section__more">更多 ${K.forward}</button></div>
    <div class="shelf">
      ${DB.recs.concat(DB.songs.slice(0, 6)).slice(0, 8).map((r, i) =>
        card({ ...r, cover: coverArt(r.title + g + i, 340) }, { sub: r.artist, kind: 'rec', id: r.bvid || r.id })).join('')}
    </div>
  </section>`).join('')}

  <section class="section">
    <div class="section__head"><h2 class="section__title">合集 / 专辑</h2></div>
    <div class="shelf">
      ${DB.albums.map(a => card({ ...a, cover: coverArt(a.title, 340) }, { sub: `${a.artist} · ${a.kind === 'paged' ? `${a.totalPages} 首` : `${a.totalPages} 个作品`}`, kind: 'album', id: a.id })).join('')}
    </div>
  </section>`;
}

/* ================= 页面：曲库 ================= */
function viewLibrary() {
  const songs = DB.songs
    .filter(s => state.playlistId === 0 || s.playlistId === state.playlistId)
    .filter(s => !state.libQuery || (s.title + s.artist).toLowerCase().includes(state.libQuery.toLowerCase()));
  return `
  <div class="page-head">
    <h1 class="page-head__title">曲库</h1>
    <div class="page-head__sub">共 ${songs.length} 首 · 与 B 站收藏夹实时同步</div>
  </div>

  <div class="importbar" role="search">
    ${K.import}
    <input id="import-input" placeholder="粘贴 B 站视频 / 收藏夹 / 系列链接，回车导入" aria-label="导入链接">
    <button class="btn btn--primary btn--sm" id="import-btn">导入</button>
  </div>

  <div class="lib">
    <div class="lib__lists">
      <button class="pl-card ${state.playlistId === 0 ? 'is-active' : ''}" data-plsel="0">
        <span class="pl-card__art mosaic">${DB.songs.slice(0, 4).map(s => `<img src="${coverArt(s.title, 120)}" alt="">`).join('')}</span>
        <span class="pl-card__name">全部歌曲</span>
        <span class="pl-card__count num">${DB.songs.length} 首</span>
      </button>
      ${DB.playlists.filter(p => p.id !== 0).map(p => `
      <button class="pl-card ${state.playlistId === p.id ? 'is-active' : ''}" data-plsel="${p.id}">
        <span class="pl-card__art"><img src="${coverArt(p.name, 240)}" alt=""></span>
        <span class="pl-card__name">${esc(p.name)}</span>
        <span class="pl-card__count num">${DB.songs.filter(s => s.playlistId === p.id).length} 首</span>
      </button>`).join('')}
      <button class="pl-card pl-card--new" id="pl-new">${K.plus}<span>新建歌单</span></button>
    </div>

    <div>
      <div class="lib__toolbar">
        <div class="searchbox">
          ${K.search}<input id="lib-q" placeholder="在曲库中搜索" value="${esc(state.libQuery)}" aria-label="曲库内搜索">
        </div>
        <div class="lib__sort">
          <label for="lib-sort">排序</label>
          <select id="lib-sort">
            <option value="createdAt" ${state.libSort === 'createdAt' ? 'selected' : ''}>收藏时间</option>
            <option value="title" ${state.libSort === 'title' ? 'selected' : ''}>标题</option>
            <option value="artist" ${state.libSort === 'artist' ? 'selected' : ''}>UP 主</option>
            <option value="duration" ${state.libSort === 'duration' ? 'selected' : ''}>时长</option>
          </select>
        </div>
        <span class="lib__count num">${songs.length} 首</span>
      </div>
      <div class="tracklist" role="list">
        ${songs.length ? songs.map((s, i) => trackRow(s, i)).join('') : `
          <div class="empty">
            <div class="empty__icon">${K.music}</div>
            <div class="empty__title">没有找到歌曲</div>
            <div class="empty__desc">试试其他关键词，或在上方粘贴 B 站链接导入</div>
          </div>`}
      </div>
    </div>
  </div>`;
}

/* ================= 页面：搜索 ================= */
function viewSearch() {
  const q = state.searchQuery;
  if (!q) return `
    <div class="page-head"><h1 class="page-head__title">搜索</h1>
      <div class="page-head__sub">搜索 B 站视频、UP 主；粘贴链接或 BV 号可直接导入</div>
    </div>
    <div class="empty" style="margin-top:60px">
      <div class="empty__icon">${K.search}</div>
      <div class="empty__title">搜索 B 站音乐</div>
      <div class="empty__desc">在顶部输入关键词；识别为链接 / BV 号时会自动转为导入任务</div>
    </div>`;

  const isLink = /bilibili\.com|b23\.tv|^BV\w+/i.test(q);
  if (isLink) return `
    <div class="page-head"><h1 class="page-head__title">识别为导入链接</h1></div>
    <div class="daily">
      <div class="daily__meta">
        <div class="daily__kicker">导入</div>
        <div class="daily__title" style="font-size:var(--fs-xl)">${esc(q)}</div>
        <div class="daily__desc">将提交智能批量导入：自动识别单视频 / 收藏夹 / 系列</div>
      </div>
      <div class="daily__actions"><button class="btn btn--primary" id="search-import">开始导入</button></div>
    </div>`;

  const ups = DB.ups.filter(u => u.name.includes(q) || q.includes('音乐') || q.includes('piano'));
  const cols = DB.searchHits.filter(h => h.isCollection);
  const hits = DB.searchHits.filter(h => !h.isCollection);
  return `
  <div class="page-head"><h1 class="page-head__title">「${esc(q)}」的搜索结果</h1></div>
  <div class="search-cats">
    <section>
      <div class="search-cat__head"><span class="search-cat__title">UP 主</span><span class="search-cat__count">${ups.length}</span></div>
      ${ups.map(u => `
        <button class="up-row" data-up="${u.mid}">
          <span class="avatar" style="background:hsl(${u.hue},55%,45%)">${esc(u.name.slice(0, 1))}</span>
          <span class="up-row__meta"><span class="up-row__name">${esc(u.name)}</span><span class="up-row__sub">${u.videos} 个投稿 · ${esc(u.desc)}</span></span>
          ${K.forward}
        </button>`).join('')}
    </section>
    <section>
      <div class="search-cat__head"><span class="search-cat__title">合集</span><span class="search-cat__count">${cols.length}</span></div>
      ${cols.map(h => `
        <div class="hit" data-hit="${h.bvid}">
          <span class="hit__cover"><img src="${coverArt(h.title, 120)}" alt=""><span class="hit__dur">${esc(h.durationText)}</span></span>
          <span class="hit__meta"><span class="hit__title">${esc(h.title)}</span><span class="hit__sub"><span>${esc(h.artist)}</span><span>${esc(h.play)} 播放</span></span></span>
          <span class="hit__acts">
            <button class="icon-btn" title="收藏整个合集">${K.plus}</button>
          </span>
        </div>`).join('')}
    </section>
    <section>
      <div class="search-cat__head"><span class="search-cat__title">视频</span><span class="search-cat__count">${hits.length}</span></div>
      ${hits.map(h => `
        <div class="hit" data-hit="${h.bvid}">
          <span class="hit__cover"><img src="${coverArt(h.title, 120)}" alt=""><span class="hit__dur">${esc(h.durationText)}</span></span>
          <span class="hit__meta"><span class="hit__title">${esc(h.title)}</span><span class="hit__sub"><span>${esc(h.artist)}</span><span>${esc(h.play)} 播放</span></span></span>
          <span class="hit__acts">
            <button class="icon-btn" data-preview="${h.bvid}" title="试听">${K.play}</button>
            <button class="icon-btn" title="收藏入库">${K.plus}</button>
            <button class="icon-btn" title="打开 UP 主">${K.account}</button>
          </span>
        </div>`).join('')}
    </section>
  </div>`;
}

/* ================= 页面：详情（专辑 / 歌单 / UP） ================= */
function viewDetail() {
  const d = state.detail;
  if (d.kind === 'up') {
    const u = DB.ups.find(x => x.mid === d.id);
    const vids = DB.searchHits.filter(h => !h.isCollection).concat(DB.searchHits);
    return `
    <div class="detail-hero" style="--hero-color:hsl(${u.hue},45%,30%)">
      <span class="avatar" style="width:120px;height:120px;font-size:40px;background:hsl(${u.hue},55%,45%)">${esc(u.name.slice(0, 1))}</span>
      <div class="detail-hero__meta">
        <div class="detail-hero__kind">UP 主</div>
        <h1 class="detail-hero__title">${esc(u.name)}</h1>
        <div class="detail-hero__sub">${u.videos} 个投稿 · ${esc(u.desc)}</div>
        <div class="detail-hero__actions">
          <button class="btn btn--play-hero">${K.play} 播放热门</button>
          <button class="btn btn--ghost">${K.external} B 站主页</button>
        </div>
      </div>
    </div>
    <section class="section">
      <div class="section__head"><h2 class="section__title">热门投稿</h2></div>
      <div class="tracklist">${vids.slice(0, 10).map((h, i) => `
        <div class="hit" data-hit="${h.bvid}">
          <span class="track__idx num">${i + 1}</span>
          <span class="hit__cover"><img src="${coverArt(h.title + i, 120)}" alt=""><span class="hit__dur">${esc(h.durationText)}</span></span>
          <span class="hit__meta"><span class="hit__title">${esc(h.title)}</span><span class="hit__sub"><span>${esc(h.play)} 播放</span></span></span>
          <span class="hit__acts"><button class="icon-btn" title="试听">${K.play}</button><button class="icon-btn" title="收藏入库">${K.plus}</button></span>
        </div>`).join('')}</div>
    </section>`;
  }

  const isAlbum = d.kind === 'album';
  const a = isAlbum ? DB.albums.find(x => x.id === d.id) : null;
  const p = !isAlbum ? DB.playlists.find(x => x.id === d.id) : null;
  const title = isAlbum ? a.title : p.name;
  const artist = isAlbum ? a.artist : `${DB.songs.filter(s => s.playlistId === d.id || d.id === 0).length} 首`;
  const tracks = isAlbum ? (DB.albumTracks[a.id] || []) : DB.songs.filter(s => d.id === 0 || s.playlistId === d.id);
  const kindLabel = isAlbum ? (a.kind === 'paged' ? `多 P 视频 · ${a.totalPages} 首` : `合集 · ${a.totalPages} 个作品`) : '歌单';

  return `
  <div class="detail-hero" style="--hero-color:${heroColor(title)}">
    <div class="detail-hero__cover"><img src="${coverArt(title, 400)}" alt=""></div>
    <div class="detail-hero__meta">
      <div class="detail-hero__kind">${kindLabel}</div>
      <h1 class="detail-hero__title">${esc(title)}</h1>
      <div class="detail-hero__sub">
        ${esc(artist)}
        ${isAlbum && a.kind === 'series' ? `<span class="badge badge--pink">逐视频收藏</span>` : ''}
        ${isAlbum && a.materializedPages < a.totalPages ? `<span class="badge badge--amber">已载入 ${a.materializedPages}/${a.totalPages}</span>` : ''}
      </div>
      <div class="detail-hero__actions">
        <button class="btn btn--play-hero">${K.play} 播放</button>
        <button class="icon-btn icon-btn--lg" style="border:1px solid var(--stroke)" title="随机播放">${K.shuffle}</button>
        <button class="icon-btn icon-btn--lg" style="border:1px solid var(--stroke)" title="分享到 B 站">${K.share}</button>
        <button class="icon-btn icon-btn--lg" style="border:1px solid var(--stroke)" title="更多" data-detail-menu>${K.more}</button>
      </div>
    </div>
  </div>
  <div class="tracklist" role="list">
    ${tracks.map((s, i) => trackRow(s, i, { src: isAlbum ? 'album' : 'playlist' })).join('')}
  </div>
  ${isAlbum && a.materializedPages < a.totalPages ? `
    <div style="text-align:center;padding:var(--sp-6)">
      <button class="btn btn--ghost" id="materialize">${K.download} 加载剩余 ${a.totalPages - a.materializedPages} 首</button>
    </div>` : ''}`;
}

/* ================= 页面：账号 ================= */
function viewAccount() {
  return `
  <div class="page-head"><h1 class="page-head__title">账号</h1></div>
  <div class="account">
    <div class="account__profile">
      <span class="avatar">${esc(DB.account.username.slice(0, 1))}</span>
      <div style="flex:1;min-width:0">
        <div class="account__name">${esc(DB.account.username)}</div>
        <div class="account__sub"><span class="account-chip__dot"></span>B 站已登录 · 最高音质 ${DB.account.maxQuality} · MID ${DB.account.mid}</div>
      </div>
      <button class="btn btn--ghost" id="logout">${K.logout} 退出</button>
    </div>

    <div class="account__group-title">同步</div>
    <div class="account__group">
      <div class="setting-row">
        <div class="setting-row__meta">
          <div class="setting-row__title">与 B 站收藏夹对账</div>
          <div class="setting-row__desc">曲库以 B 站收藏夹为准；打开应用时已自动同步一次</div>
        </div>
        <button class="btn btn--primary" id="sync-now">${K.refresh} 立即同步</button>
      </div>
      <div class="setting-row sync-card">
        <div class="setting-row__meta">
          <div class="setting-row__title">上次同步结果</div>
          <div class="sync-card__row">
            <div class="sync-stat sync-stat--down"><div class="sync-stat__num">${DB.sync.pulled}</div><div class="sync-stat__label">拉取</div></div>
            <div class="sync-stat sync-stat--up"><div class="sync-stat__num">${DB.sync.pushed}</div><div class="sync-stat__label">补收藏</div></div>
            <div class="sync-stat"><div class="sync-stat__num">${DB.sync.removed}</div><div class="sync-stat__label">移除</div></div>
            <div class="sync-stat"><div class="sync-stat__num">${DB.sync.adopted}</div><div class="sync-stat__label">认领</div></div>
            <div class="sync-stat"><div class="sync-stat__num">${DB.sync.backfilled}</div><div class="sync-stat__label">回填</div></div>
          </div>
        </div>
      </div>
    </div>

    <div class="account__group-title">外观</div>
    <div class="account__group">
      <div class="setting-row">
        <div class="setting-row__meta"><div class="setting-row__title">主题</div><div class="setting-row__desc">亮色 / 暗色 / 跟随系统</div></div>
        <select id="theme-sel" style="height:32px;border-radius:var(--r-pill);border:1px solid var(--stroke);background:var(--bg-raise);padding:0 12px;color:var(--text);font-family:inherit">
          <option value="dark" ${state.theme === 'dark' ? 'selected' : ''}>暗色</option>
          <option value="light" ${state.theme === 'light' ? 'selected' : ''}>亮色</option>
          <option value="system" ${state.theme === 'system' ? 'selected' : ''}>跟随系统</option>
        </select>
      </div>
    </div>

    <div class="account__group-title">数据</div>
    <div class="account__group">
      <div class="setting-row">
        <div class="setting-row__meta"><div class="setting-row__title">导出 / 分享曲库</div><div class="setting-row__desc">把本地曲库导出为 B 站公开收藏夹并生成分享链接</div></div>
        <button class="btn btn--ghost" id="export-open">${K.share} 导出</button>
      </div>
      <div class="setting-row">
        <div class="setting-row__meta"><div class="setting-row__title">清除本地缓存</div><div class="setting-row__desc">清空队列、歌词与封面缓存；不影响 B 站收藏</div></div>
        <button class="btn btn--ghost btn--danger" id="clear-cache">清除</button>
      </div>
      <div class="setting-row">
        <div class="setting-row__meta"><div class="setting-row__title">关于 BiliMusic</div><div class="setting-row__desc">v1.0.2 · 重设计预览 · 纯在线流媒体，不做离线下载</div></div>
        <button class="btn btn--ghost">${K.external} 开源地址</button>
      </div>
    </div>
  </div>`;
}

/* ================= 路由渲染 ================= */
export function render() {
  const main = $('.main__scroll');
  const v = state.detail ? viewDetail()
    : state.view === 'home' ? viewHome()
    : state.view === 'library' ? viewLibrary()
    : state.view === 'search' ? viewSearch()
    : viewAccount();
  main.innerHTML = v;
  renderChrome();
  renderPlaybar();
  main.scrollTop = 0;
}

export function go(view) { state.backStack.push(snapshot()); state.view = view; state.detail = null; render(); }
export function openDetail(kind, id) { state.backStack.push(snapshot()); state.detail = { kind, id }; render(); }
export function goBack() { const s = state.backStack.pop(); if (s) { Object.assign(state, s); render(); } }
function snapshot() { return { view: state.view, detail: state.detail, playlistId: state.playlistId, libQuery: state.libQuery, searchQuery: state.searchQuery }; }

/* ================= 播放条 ================= */
export function renderPlaybar() {
  const cur = state.queue[state.queueIndex];
  const bar = $('.playbar');
  if (!cur) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  const pct = state.duration ? (state.position / state.duration * 100) : 0;
  bar.style.setProperty('--pb', pct + '%');

  $('.playbar__track').innerHTML = `
    <div class="playbar__cover" id="np-open" role="button" tabindex="0" aria-label="展开播放页">
      <img src="${coverArt(cur.title, 120)}" alt="">
      <span class="playbar__expand">${K.expand}</span>
    </div>
    <div class="playbar__meta">
      <div class="playbar__title ellip">${esc(cur.title)}</div>
      <div class="playbar__artist ellip">${esc(cur.artist)}</div>
    </div>
    <button class="icon-btn playbar__like ${cur.liked ? 'is-on' : ''}" data-like aria-label="星标">${cur.liked ? K.starFill : K.star}</button>`;

  $('.playbar__btns').innerHTML = `
    <button class="pbtn pbtn--mode ${state.mode !== 'order' ? 'is-on' : ''}" data-mode aria-label="播放模式：${{ order: '顺序', loop: '列表循环', one: '单曲循环', random: '随机' }[state.mode]}">${state.mode === 'random' ? K.shuffle : K.repeat}${state.mode === 'one' ? '<i class="mode-one">1</i>' : ''}</button>
    <button class="pbtn pbtn--prev" data-prev aria-label="上一首">${K.prev}</button>
    <button class="pbtn pbtn--play" data-toggle aria-label="${state.playing ? '暂停' : '播放'}">${state.playing ? K.pause : K.play}</button>
    <button class="pbtn" data-next aria-label="下一首">${K.next}</button>`;

  $('.playbar__seek').innerHTML = `
    <span class="playbar__time num">${fmt(state.position)}</span>
    <input type="range" class="slider" id="pb-seek" min="0" max="${state.duration || 100}" value="${state.position}" aria-label="播放进度">
    <span class="playbar__time num">${fmt(state.duration)}</span>`;

  $('.playbar__tools').innerHTML = `
    <button class="icon-btn" data-lyric-open aria-label="歌词">${K.lyric}</button>
    <button class="icon-btn" data-queue-open aria-label="播放队列">${K.queue}</button>
    <div class="playbar__vol">
      <button class="icon-btn" data-mute aria-label="音量">${state.volume === 0 ? K.volMute : K.vol}</button>
      <input type="range" class="slider" id="pb-vol" min="0" max="1" step=".01" value="${state.volume}" aria-label="音量">
    </div>`;

  syncSliderFill();
}

function syncSliderFill() {
  document.querySelectorAll('.slider').forEach(sl => {
    const pct = (sl.value - sl.min) / (sl.max - sl.min) * 100;
    sl.style.setProperty('--val', pct + '%');
  });
}

/* ================= 全屏播放页 ================= */
export function renderNowPlaying() {
  const np = $('.nowplaying');
  const cur = state.queue[state.queueIndex];
  np.classList.toggle('is-open', state.nowOpen);
  if (!cur) return;
  np.style.setProperty('--np-color', heroColor(cur.title));

  $('.np-left').innerHTML = `
    <div class="np-cover"><img src="${coverArt(cur.title, 600)}" alt=""></div>
    <div class="np-info">
      <div class="np-title ellip">${esc(cur.title)}</div>
      <div class="np-artist ellip">${esc(cur.artist)}</div>
    </div>
    <div class="np-seekrow">
      <span class="playbar__time num">${fmt(state.position)}</span>
      <input type="range" class="slider" id="np-seek" min="0" max="${state.duration || 100}" value="${state.position}" aria-label="播放进度">
      <span class="playbar__time num">${fmt(state.duration)}</span>
    </div>
    <div class="np-btns">
      <button class="pbtn pbtn--mode ${state.mode !== 'order' ? 'is-on' : ''}" data-mode>${state.mode === 'random' ? K.shuffle : K.repeat}${state.mode === 'one' ? '<i class="mode-one">1</i>' : ''}</button>
      <button class="pbtn" data-prev>${K.prev}</button>
      <button class="pbtn pbtn--play" data-toggle>${state.playing ? K.pause : K.play}</button>
      <button class="pbtn" data-next>${K.next}</button>
      <button class="pbtn pbtn--mode" data-queue-open aria-label="队列">${K.queue}</button>
    </div>`;

  const nowIdx = LYRICS.findIndex((l, i) => state.position < (LYRICS[i + 1]?.[0] ?? Infinity));
  $('.np-lyrics').innerHTML = LYRICS.map((l, i) => `
    <div class="lyric-line ${i === nowIdx ? 'is-now' : i < nowIdx ? 'is-past' : ''}" data-t="${l[0]}">${esc(l[1])}</div>`).join('');
  const now = $('.np-lyrics .is-now');
  if (now) now.scrollIntoView({ block: 'center', behavior: 'smooth' });
  syncSliderFill();
}

/* ================= 队列面板 ================= */
export function renderQueue() {
  const q = $('.queue-panel');
  q.classList.toggle('is-open', state.queueOpen);
  $('.queue-panel__list').innerHTML = state.queue.length ? state.queue.map((s, i) => `
    <div class="qitem ${i === state.queueIndex ? 'is-now' : ''}" data-qjump="${i}">
      <span class="qitem__cover"><img src="${coverArt(s.title, 96)}" alt=""></span>
      <span class="qitem__meta">
        <span class="qitem__title ellip">${esc(s.title)}</span>
        <span class="qitem__artist ellip">${esc(s.artist)}</span>
      </span>
      ${i === state.queueIndex ? `<span class="eq"><i></i><i></i><i></i></span>` : `<span class="qitem__src">${esc(s._src || '曲库')}</span>`}
      <button class="icon-btn qitem__x" data-qrm="${i}" aria-label="从队列移除">${K.close}</button>
    </div>`).join('') : `<div class="empty"><div class="empty__icon">${K.queue}</div><div class="empty__title">队列为空</div><div class="empty__desc">从曲库或推荐里点一首歌开始</div></div>`;
}

/* ================= 任务抽屉 ================= */
export function renderJobs() {
  const jp = $('.jobs-panel');
  jp.classList.toggle('hidden', !state.jobsOpen);
  $('.jobs-panel__list').innerHTML = DB.jobs.map(j => {
    const cls = j.status === 'failed' ? 'job--fail' : j.status === 'ready' ? 'job--done' : 'job--run';
    const icon = j.status === 'failed' ? K.alert : j.status === 'ready' ? K.check : `<span class="spin" style="display:inline-flex">${K.refresh}</span>`;
    return `
    <div class="job ${cls}">
      <span class="job__icon">${icon}</span>
      <span class="job__meta">
        <span class="job__title ellip">${esc(j.title)}</span>
        <span class="job__sub">${esc(j.sub)}</span>
        <span class="job__bar"><i style="width:${j.progress}%"></i></span>
      </span>
      ${j.status === 'failed' ? `<button class="btn btn--sm btn--ghost job__act">重试</button>` : ''}
    </div>`;
  }).join('');
}

/* ================= Toast / 弹窗 ================= */
export function toast(msg, type = 'ok') {
  const wrap = $('.toast-wrap');
  wrap.append(el(`<div class="toast toast--${type}">${type === 'ok' ? K.check : K.alert}<span>${esc(msg)}</span></div>`));
  setTimeout(() => wrap.lastElementChild?.remove(), 3200);
}

export function openModal(html) {
  closeModal();
  const mask = el(`<div class="modal-mask" role="dialog" aria-modal="true"><div class="modal">${html}</div></div>`);
  mask.addEventListener('click', e => { if (e.target === mask) closeModal(); });
  document.body.append(mask);
}
export function closeModal() { $('.modal-mask')?.remove(); }

export function openSheet(items, title) {
  closeSheet();
  const mask = el(`<div class="sheet-mask"></div>`);
  const sheet = el(`
  <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title || '操作')}">
    <div class="sheet__grab"></div>
    ${title ? `<div style="padding:0 var(--sp-3) var(--sp-3);font-weight:700">${esc(title)}</div>` : ''}
    ${items.map((it, i) => `<button class="menu__item ${it.danger ? 'menu__item--danger' : ''}" data-sheet-act="${i}">${K[it.icon]}<span>${esc(it.label)}</span></button>`).join('')}
  </div>`);
  mask.addEventListener('click', closeSheet);
  sheet.addEventListener('click', e => {
    const b = e.target.closest('[data-sheet-act]');
    if (b) { const i = +b.dataset.sheetAct; closeSheet(); items[i].onPick?.(); }
  });
  document.body.append(mask, sheet);
}
export function closeSheet() { $('.sheet-mask')?.remove(); $('.sheet')?.remove(); }

/* 登录弹窗（PRD §5.1） */
export function openLogin() {
  openModal(`
    <div class="modal__head"><span class="modal__title">扫码登录 B 站</span>
      <button class="icon-btn" onclick="this.closest('.modal-mask').remove()">${K.close}</button></div>
    <div class="modal__body login">
      <div class="login__qr" id="login-qr">
        <div style="width:100%;height:100%;display:grid;grid-template-columns:repeat(8,1fr);gap:2px;padding:8px">
          ${Array.from({ length: 64 }, (_, i) => `<span style="background:${(i * 7 + Math.floor(i / 8)) % 3 ? '#111' : '#fff'};border-radius:1px"></span>`).join('')}
        </div>
      </div>
      <div class="login__state"><span class="dot"></span>等待扫码</div>
      <div class="login__tip">打开 B 站 App → 我的 → 右上角扫一扫<br>二维码 2 分钟内有效，过期可点击刷新</div>
      <div class="login__alt">
        <button class="btn btn--ghost btn--sm">${K.phone} 存相册去 App 扫</button>
        <button class="btn btn--ghost btn--sm">${K.globe} 在浏览器完成登录</button>
      </div>
    </div>`);
}
