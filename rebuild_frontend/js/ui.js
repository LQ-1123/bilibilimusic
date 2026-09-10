/* ---------- 图标定义（currentColor，参考 SF Symbols / Lucide 风格） ---------- */
const I = (paths, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const IF = (paths, vb = '0 0 24 24') => `<svg viewBox="${vb}" fill="currentColor" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  home: I('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/>'),
  library: I('<path d="M4 4v16"/><path d="M9 4v16"/><path d="M13 5.5 19 4l3 15-6 1.5z" transform="translate(-1 0) scale(.92)"/>'),
  search: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  account: I('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"/>'),
  back: I('<path d="m14 6-6 6 6 6"/>'),
  forward: I('<path d="m10 6 6 6-6 6"/>'),
  close: I('<path d="M6 6l12 12M18 6 6 18"/>'),
  more: IF('<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>'),
  play: IF('<path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5z"/>'),
  pause: IF('<rect x="6.5" y="5" width="4" height="14" rx="1.4"/><rect x="13.5" y="5" width="4" height="14" rx="1.4"/>'),
  prev: IF('<path d="M6 5.5v13a1 1 0 0 0 2 0v-13a1 1 0 0 0-2 0z"/><path d="M20 5.5v13a1 1 0 0 1-1.6.8L9 12.8a1 1 0 0 1 0-1.6l9.4-6.5a1 1 0 0 1 1.6.8z"/>'),
  next: IF('<path d="M16 5.5v13a1 1 0 0 0 2 0v-13a1 1 0 0 0-2 0z"/><path d="M4 5.5v13a1 1 0 0 0 1.6.8L15 12.8a1 1 0 0 0 0-1.6L5.6 4.7a1 1 0 0 0-1.6.8z"/>'),
  shuffle: I('<path d="M3 6h4l10 12h4m0 0-2.5-2.5M21 18l-2.5 2.5"/><path d="M3 18h4l2.7-3.2M13.4 9.6 17 6h4m0 0-2.5-2.5M21 6l-2.5 2.5"/>'),
  repeat: I('<path d="M17 2.5 20.5 6 17 9.5"/><path d="M4 11V9a3 3 0 0 1 3-3h13.5"/><path d="m7 21.5-3.5-3.5L7 14.5"/><path d="M20 13v2a3 3 0 0 1-3 3H3.5"/>'),
  vol: I('<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/>'),
  volMute: I('<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="m16 9.5 5 5m0-5-5 5"/>'),
  queue: I('<path d="M4 6h16M4 11h16M4 16h7"/><path d="m16 16 4 2.5-4 2.5z" fill="currentColor" stroke="none"/>'),
  lyric: I('<path d="M4 5h16M4 10h10M4 15h16M4 20h7"/>'),
  expand: I('<path d="M12 5v14m0-14 4 4m-4-4L8 9" transform="rotate(45 12 12)"/>'),
  collapse: I('<path d="m6 9 6 6 6-6"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  star: I('<path d="m12 3.5 2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8L3.5 9.7l5.9-.9z"/>'),
  starFill: IF('<path d="m12 3.5 2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8L3.5 9.7l5.9-.9z"/>'),
  trash: I('<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/>'),
  edit: I('<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m13.5 6.5 3 3"/>'),
  share: I('<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.3m-7.6 7 7.6 4.3"/>'),
  download: I('<path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M4 19h16"/>'),
  refresh: I('<path d="M20 11A8 8 0 1 0 18.9 15"/><path d="M20 5v6h-6"/>'),
  import: I('<path d="M12 3v10m0 0 4-4m-4 4-4-4"/><path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3"/>'),
  check: I('<path d="m5 12.5 5 5 9-11"/>'),
  alert: I('<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.2" r=".4" fill="currentColor"/>'),
  info: I('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".4" fill="currentColor"/>'),
  external: I('<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V7.5A1.5 1.5 0 0 1 5.5 6H11"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  music: I('<circle cx="7" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><path d="M10 18V6l11-2v12"/>'),
  list: I('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>'),
  album: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>'),
  spark: I('<path d="M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2m0-12-2 2M8 16l-2 2"/><circle cx="12" cy="12" r="3.2"/>'),
  radio: I('<circle cx="12" cy="12" r="2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4m8.4 0a6 6 0 0 1 0 8.4M5 19a10 10 0 0 1 0-14m14 0a10 10 0 0 1 0 14"/>'),
  folder: I('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  logout: I('<path d="M14 4h-8a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h8"/><path d="m17 8 4 4-4 4M9 12h12"/>'),
  moon: I('<path d="M20 13.5A8.5 8.5 0 0 1 10.5 4 8.5 8.5 0 1 0 20 13.5z"/>'),
  sun: I('<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5V5m0 14v2.5M2.5 12H5m14 0h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M12 2.8 13.5 5h2.6l1 2.4 2.5.8.6 2.6-1.2 2.2 1.2 2.2-.6 2.6-2.5.8-1 2.4h-2.6L12 21.2 10.5 19H7.9l-1-2.4-2.5-.8-.6-2.6L5 11 3.8 8.8l.6-2.6 2.5-.8 1-2.4h2.6z" transform="scale(.92) translate(1 1)"/>'),
  phone: I('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
  globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z"/>'),
  eye: I('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
};

/* ---------- 工具 ---------- */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmt(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/* 封面：用渐变色块 + 首字符做占位（demo 用；真实场景用 coverUrl） */
const HUES = [345, 200, 262, 160, 30, 190, 288, 96, 12, 224];
export function coverArt(seed, size = 300) {
  let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = HUES[h % HUES.length], hue2 = (hue + 40) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},52%,34%)"/><stop offset="1" stop-color="hsl(${hue2},46%,22%)"/></linearGradient></defs><rect width="${size}" height="${size}" fill="url(#g)"/><circle cx="${size * .72}" cy="${size * .28}" r="${size * .34}" fill="hsla(${hue2},60%,60%,.18)"/><circle cx="${size * .25}" cy="${size * .8}" r="${size * .28}" fill="hsla(${hue},60%,70%,.12)"/><text x="50%" y="54%" font-size="${size * .34}" fill="hsla(${hue},70%,85%,.85)" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system,PingFang SC" font-weight="700">${esc(String(seed).slice(0, 1))}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/* 主色（供详情页/播放页氛围背景） */
export function heroColor(seed) {
  let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${HUES[h % HUES.length]}, 42%, 26%)`;
}

export const $ = s => document.querySelector(s);
export const el = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
