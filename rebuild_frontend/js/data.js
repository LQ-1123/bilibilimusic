/* ---------- Demo 数据（形状对齐 PRD §4.13 数据字典） ---------- */
import { coverArt } from './ui.js';

let _id = 0;
const S = (title, artist, dur, extra = {}) => ({
  id: ++_id, bvid: 'BV1xx' + (_id + 100), title, artist,
  duration: dur, qualityLabel: '192K', collected: true, albumId: 0, playlistId: 0,
  createdAt: new Date(Date.UTC(2026, 8, 1) - _id * 86400000).toISOString(),
  ...extra,
});

export const DB = {
  account: { loggedIn: true, username: '夜半歌单', maxQuality: '192K', mid: 349327 },

  playlists: [
    { id: 0, name: '我的曲库', folderIds: [101], deletable: false },
    { id: 1, name: '跑步电音', folderIds: [102], deletable: true },
    { id: 2, name: '深夜自习', folderIds: [103], deletable: true },
    { id: 3, name: '古风入坑', folderIds: [104], deletable: true },
    { id: 4, name: 'Live 现场', folderIds: [105], deletable: true },
  ],

  songs: [
    S('时光机', '周杰伦', 293, { playlistId: 0 }),
    S('夜的第七章', '周杰伦', 268, { playlistId: 0 }),
    S('红莲华', 'LiSA', 249, { playlistId: 1 }),
    S('偶像', 'YOASOBI', 213, { playlistId: 1 }),
    S('夜航星', '不才', 302, { playlistId: 2 }),
    S('普通朋友', '陶喆', 315, { playlistId: 0 }),
    S('Fiction', 'Ado', 197, { playlistId: 1 }),
    S('杀死那个石家庄人', '万能青年旅店', 421, { playlistId: 0 }),
    S('东风破', '周杰伦', 309, { playlistId: 3 }),
    S('青花瓷', '周杰伦', 287, { playlistId: 3 }),
    S('Lemon', '米津玄师', 257, { playlistId: 2 }),
    S('孤勇者', '陈奕迅', 286, { playlistId: 4 }),
    S('起风了', '买辣椒也用券', 305, { playlistId: 0 }),
    S('群青', 'YOASOBI', 251, { playlistId: 1 }),
    S('大鱼', '周深', 296, { playlistId: 3 }),
    S('晴天', '周杰伦', 277, { playlistId: 0 }),
  ],

  albums: [
    { id: 11, kind: 'paged', sourceBvid: 'BV1gT4y1a7kM', title: 'Live 2025 全场', artist: '陈楚生', totalPages: 24, materializedPages: 24 },
    { id: 12, kind: 'series', sourceBvid: 'sid:880', title: '周杰伦无损全集', artist: '音乐台', totalPages: 12, materializedPages: 12 },
    { id: 13, kind: 'paged', sourceBvid: 'BV1uF411K7pz', title: '古典钢琴精选 100', artist: 'piano_room', totalPages: 100, materializedPages: 20 },
  ],

  // 专辑曲目（albumId 关联）
  albumTracks: {},

  ups: [
    { mid: 777, name: '音乐台', hue: 200, videos: 342, desc: '专注无损搬运 · 周更' },
    { mid: 778, name: 'piano_room', hue: 262, videos: 156, desc: '古典钢琴 / 考级曲目' },
    { mid: 779, name: 'Live现场控', hue: 12, videos: 98, desc: '全网演唱会收录' },
  ],

  recs: [
    { bvid: 'BVr1', title: '樱花樱花想见你', artist: 'RSP', duration: 289, genre: '华语流行', seedBvid: 'BV1xx100' },
    { bvid: 'BVr2', title: '月光奏鸣曲 第一乐章', artist: 'piano_room', duration: 356, genre: '古典', seedBvid: 'BV1xx105' },
    { bvid: 'BVr3', title: 'Yellow', artist: 'Coldplay 现场', duration: 268, genre: '摇滚金属', seedBvid: 'BV1xx108' },
    { bvid: 'BVr4', title: '兰亭序', artist: '周杰伦', duration: 301, genre: '古风', seedBvid: 'BV1xx109' },
    { bvid: 'BVr5', title: '夜曲', artist: '周杰伦', duration: 227, genre: '华语流行', seedBvid: 'BV1xx101' },
    { bvid: 'BVr6', title: 'One Last Kiss', artist: '宇多田光', duration: 251, genre: '网络音乐', seedBvid: 'BV1xx104' },
    { bvid: 'BVr7', title: '东风破（钢琴版）', artist: 'piano_room', duration: 312, genre: '静心', seedBvid: 'BV1xx109' },
    { bvid: 'BVr8', title: '河', artist: '蛙池', duration: 245, genre: '摇滚金属', seedBvid: 'BV1xx108' },
  ],

  radios: [
    { key: 'rank', name: '热歌榜', desc: 'B 站音乐区实时最热' },
    { key: 'new', name: '新上架', desc: '音乐区本周新作' },
    { key: 'piano', name: '钢琴', desc: '古典与现代钢琴' },
    { key: 'guitar', name: '吉他', desc: '指弹与弹唱' },
    { key: 'cover', name: '翻唱', desc: '神仙翻唱现场' },
    { key: 'gufeng', name: '古风', desc: '国风古韵' },
    { key: 'jazz', name: '爵士', desc: '慵懒与即兴' },
    { key: 'edm', name: '电子', desc: '电音与合成器' },
  ],

  genres: ['华语流行', '古典', '摇滚金属', '古风', 'R&B', 'hiphop', '静心', '网络音乐', '蓝调', '力量'],

  searchHits: [
    { bvid: 'BVs1', title: '周杰伦《晴天》4K 修复版', artist: '音乐台', durationText: '4:37', play: '128.4万', duration: 277 },
    { bvid: 'BVs2', title: '晴天 - 吉他弹唱教学', artist: '吉他社', durationText: '6:12', play: '45.2万', duration: 372 },
    { bvid: 'BVs3', title: '晴天（钢琴独奏）', artist: 'piano_room', durationText: '4:52', play: '12.8万', duration: 292 },
    { bvid: 'BVs4', title: '【合集】周杰伦钢琴曲 20 首', artist: 'piano_room', durationText: '合集 · 20P', play: '88.1万', duration: 0, isCollection: true },
  ],

  jobs: [
    { id: 't1', title: '收藏夹「跑步电音」', sub: '批量导入 · 30 条', status: 'downloading', progress: 64 },
    { id: 't2', title: '夜航星 - 不才', sub: '解析中', status: 'pending', progress: 10 },
    { id: 't3', title: '大鱼 - 周深', sub: '已完成', status: 'ready', progress: 100 },
    { id: 't4', title: '系列「古典钢琴精选」', sub: '失败：收藏夹未公开', status: 'failed', progress: 100 },
  ],

  sync: { folders: 5, adopted: 3, pulled: 12, pushed: 2, removed: 1, dropped: 0, backfilled: 4 },
};

/* 生成专辑曲目 */
DB.albumTracks[11] = Array.from({ length: 24 }, (_, i) => S(`Live 2025 · 第 ${i + 1} 首`, '陈楚生', 180 + (i * 37) % 160, { albumId: 11, collected: i < 24 }));
DB.albumTracks[12] = Array.from({ length: 12 }, (_, i) => S(`周杰伦无损 · ${['晴天', '夜曲', '青花瓷', '东风破', '发如雪', '稻香', '七里香', '搁浅', '轨迹', '借口', '退后', '彩虹'][i]}`, '音乐台', 220 + (i * 41) % 140, { albumId: 12, collected: i % 3 !== 0 }));
DB.albumTracks[13] = Array.from({ length: 20 }, (_, i) => S(`古典钢琴精选 No.${i + 1}`, 'piano_room', 240 + (i * 29) % 200, { albumId: 13, collected: i % 2 === 0 }));

/* 歌词 demo */
export const LYRICS = [
  [0, '作词：方文山'], [4, '作曲：周杰伦'], [12, '故事的小黄花 从出生那年就飘着'],
  [19, '童年的荡秋千 随记忆一直晃到现在'], [27, 'Re So So Si Do Si La'],
  [32, 'So La Si Si Si Si La Si La So'], [40, '吹着前奏 望着天空'],
  [46, '我想起花瓣 试着掉落'], [54, '为你翘课的那一天 花落的那一天'],
  [62, '教室的那一间 我怎么看不见'], [70, '消失的下雨天 我好想再淋一遍'],
  [79, '没想到 失去的勇气我还留着'], [87, '好想再问一遍 你会等待还是离开'],
  [96, '刮风这天 我试过握着你手'], [104, '但偏偏 雨渐渐 大到我看你不见'],
  [113, '还要多久 我才能在你身边'], [121, '等到放晴的那天 也许我会比较好一点'],
];
