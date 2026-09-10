// #27 跨端串流端到端：两个真实页面（A 播放端 / B 新设备）+ 真实曲库歌，跑完 26 项断言
// 起服务见 scripts/e2e-streaming.sh；断言口径详见 docs/issue-ledger.md §7.4
const BASE = 'http://127.0.0.1:8123', CDP = 'http://127.0.0.1:9333';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class Cdp {
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.events=[];
    ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);
      if(m.id&&this.pending.has(m.id)){const{res,rej}=this.pending.get(m.id);this.pending.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);return;}
      if(m.method) this.events.push(m);});}
  send(method,params={},sessionId){const id=++this.id;const p={id,method,params};if(sessionId)p.sessionId=sessionId;
    this.ws.send(JSON.stringify(p));return new Promise((res,rej)=>this.pending.set(id,{res,rej}));}
}
async function connect(){const v=await (await fetch(CDP+'/json/version')).json();
  const ws=new WebSocket(v.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j);}); return new Cdp(ws);}
async function newPage(cdp,view){const {browserContextId}=await cdp.send('Target.createBrowserContext');
  const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank',browserContextId});
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
  await cdp.send('Runtime.enable',{},sessionId); await cdp.send('Network.enable',{},sessionId);
  if(view){   // 手机视口 + 触摸：手势只在 <=900px 的移动布局上启用（与 CSS 断点同口径）
    await cdp.send('Emulation.setDeviceMetricsOverride',Object.assign({deviceScaleFactor:2,mobile:true},view),sessionId);
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},sessionId);
  }
  await cdp.send('Page.navigate',{url:BASE+'/'},sessionId); return sessionId;}
async function ev(cdp,s,expr,awaitPromise=false,gesture=false){
  const r=await cdp.send('Runtime.evaluate',{expression:expr,awaitPromise,returnByValue:true,userGesture:gesture},s);
  if(r.exceptionDetails) throw new Error('page error: '+JSON.stringify(r.exceptionDetails.exception?.description||r.exceptionDetails));
  return r.result.value;}
const tap=(cdp,s,sel)=>ev(cdp,s,`(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true; })()`,false,true);
const results=[];
function check(n,ok,extra=''){results.push({name:n,ok});console.log((ok?'PASS ':'FAIL ')+n+(extra?' | '+extra:''));}
async function state(){const s=await (await fetch(BASE+'/api/session')).json();return {active:s.session&&s.session.activeDeviceId,session:s.session,devices:s.devices||[]};}
async function poll(fn,ms,step=500){let el=0;while(el<ms){const v=await fn();if(v)return{ok:true,el,v};await sleep(step);el+=step;}return{ok:false,el};}
const bar=(cdp,s)=>ev(cdp,s,`(() => { const bar=document.getElementById('player-bar'),b=document.getElementById('btn-toggle'),a=document.getElementById('audio');
  return {mirror:/(^|\\s)mirror(\\s|$)/.test(bar.className),title:document.getElementById('player-title').textContent,
    artist:document.getElementById('player-artist').textContent,icon:b.querySelector('use').getAttribute('href'),btnTitle:b.title,
    src:(a.src||'').replace(location.origin,''),paused:a.paused,ready:a.readyState,cur:document.getElementById('t-cur').textContent,
    pos:Math.round(a.currentTime*10)/10,playing:!!(window.BiliPlayer&&BiliPlayer.isPlaying&&BiliPlayer.isPlaying()),
    bvid:(window.BiliPlayer&&BiliPlayer.currentSong&&BiliPlayer.currentSong()||{}).bvid||'',
    vol:Math.round(a.volume*100)/100,puck:bar.classList.contains('dragging')}; })()`);

// #29 长按手势：真实指针事件（pointerdown → 等过长按阈值 → pointermove 跟手 → pointerup 松手）
const rect=(cdp,s,sel)=>ev(cdp,s,`(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,hid:e.hidden}; })()`);
const mouse=(cdp,s,type,pt,extra={})=>cdp.send('Input.dispatchMouseEvent',Object.assign({type,x:Math.round(pt.x),y:Math.round(pt.y),button:'left',clickCount:1},extra),s);
const tp=(x,y)=>[{x:Math.round(x),y:Math.round(y),radiusX:9,radiusY:9,force:1,id:1}];
const touch=(cdp,s,type,pt)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:tp(pt.x,pt.y)},s);
const pickOpen=(cdp,s)=>ev(cdp,s,`(() => { const p=document.getElementById('dev-pick'); return !!p && !p.hidden; })()`);

const cdp = await connect();
const A = await newPage(cdp);   // 手机/播放端
await sleep(2000);
const aId = await ev(cdp, A, `window.__sessionSync && window.__sessionSync.deviceId`);
const aName = await ev(cdp, A, `window.__sessionSync && window.__sessionSync.name`);

// 等曲库渲染出真实歌曲，点播第一首
const got = await poll(() => ev(cdp, A, `document.querySelectorAll('#view-library [data-play], .rec-card[data-play], [data-play]').length`), 20000);
check('曲库加载出可播歌曲', got.ok && got.v > 0, 'cards=' + got.v);
const songInfo = await ev(cdp, A, `(() => { const e=document.querySelector('[data-play]'); return {id:e.dataset.play, title:(e.getAttribute('title')||e.innerText||'').trim().slice(0,40)}; })()`);
await tap(cdp, A, '[data-play]');
const playing = await poll(async () => { const s = await state(); return s.active === aId && s.session && s.session.song && s.session.song.bvid ? s : null; }, 25000);
const song = playing.ok ? playing.v.session.song : null;
check('① 播放端开始播放并上报会话', playing.ok, song ? song.title + ' | ' + song.bvid + ' | ' + song.duration + 's' : 'timeout ' + JSON.stringify(songInfo));
const aBar = await bar(cdp, A);
check('① 播放端本机播放条正常（非镜像）', aBar.mirror === false && aBar.playing === true, aBar.title + ' | ' + aBar.src);

// ---- 新设备打开 → 播放条同步（#29：B 用手机视口 + 触摸，手势只在移动布局启用） ----
const B = await newPage(cdp, {width:390,height:844});
await sleep(3000);
const bId = await ev(cdp, B, `window.__sessionSync && window.__sessionSync.deviceId`);
// 提示胶囊 spy：#29 第三轮口径「串流的时候不要提示」——记录每次 __toast 的文案，供 ⑥ 查重
await ev(cdp, B, `(() => { window.__toastLog=[]; const o=window.__toast;
  if(o) window.__toast=function(m){ window.__toastLog.push(String(m)); return o.apply(this,arguments); }; return true; })()`);
let st = await bar(cdp, B);
check('② 新设备播放条同步到手机在放的歌', st.mirror === true && st.title === song.title, st.title + ' | ' + st.artist);
check('② 中键＝遥控对面播放/暂停', st.icon === '#a-pause' && st.btnTitle.indexOf('暂停') === 0, st.icon + ' ' + st.btnTitle);
// #29 第二轮：up 主位回归歌曲作者（不再被「在 X 上播放」顶掉），串流标识改走播放条粉色光晕
const rim = await ev(cdp, B, `(() => { const b=document.getElementById('player-bar'); const cs=getComputedStyle(b,'::before');
  return {artist:document.getElementById('player-artist').textContent, title:(document.getElementById('player-artist').title||''),
    cls:/(^|\\s)mirror(\\s|$)/.test(b.className), anim:cs.animationName, bg:cs.backgroundImage.slice(0,60)}; })()`);
check('② up 主位显示歌曲作者（不被设备名顶掉）', rim.artist.length > 0 && rim.artist.indexOf('上播放') < 0, rim.artist + ' | hover=' + rim.title);
check('② 串流中播放条走粉色光晕溜边', rim.cls === true && rim.anim === 'bmRimRun' && rim.bg.indexOf('conic') >= 0, rim.anim + ' | ' + rim.bg);
check('② 新设备没有偷跑播放', st.playing === false && !st.src, 'playing=' + st.playing + ' src=' + st.src);
const c1 = st.cur; await sleep(3500); st = await bar(cdp, B);
check('② 镜像进度跟着手机走', st.cur !== c1 && st.mirror, c1 + ' → ' + st.cur);

// ---- 新设备遥控手机 ----
await ev(cdp, B, `window.__cmds=[]; (() => { const raw=window.fetch; window.fetch=function(u,i){ try{ if(String(u).indexOf('/api/session/command')>=0) window.__cmds.push(JSON.parse(i.body)); }catch(e){} return raw(u,i); }; })();`);
const aBefore = await bar(cdp, A);
await tap(cdp, B, '#btn-next');
let aAfterNext = await bar(cdp, A);
for (let i = 0; i < 15 && aAfterNext.bvid === aBefore.bvid; i++) { await sleep(600); aAfterNext = await bar(cdp, A); }
await tap(cdp, B, '#btn-prev');
let aAfterPrev = await bar(cdp, A);
for (let i = 0; i < 15 && aAfterPrev.bvid === aAfterNext.bvid; i++) { await sleep(600); aAfterPrev = await bar(cdp, A); }
await ev(cdp, B, `(() => { window.__sessionSync.openPick(); return true; })()`); await sleep(700);
const sheet = await ev(cdp, B, `(() => { const s=document.getElementById('dev-pick'),b=document.getElementById('dev-body'),v=document.getElementById('dp-vol');
  return {open:!!s&&!s.hidden, rows:b.querySelectorAll('[data-dev]').length, vol:v?v.value:null,
    sorted:(b.querySelector('[data-dev]')||{}).dataset ? b.querySelector('[data-dev]').dataset.dev : null}; })()`);
// 中键短按＝遥控对面播放/暂停（#29 后不再有抽屉里的 toggle 按钮）
await tap(cdp, B, '#btn-toggle'); await sleep(500);
const aPaused = await bar(cdp, A);
await ev(cdp, B, `(() => { const v=document.getElementById('dp-vol'); v.value=22; v.dispatchEvent(new Event('input')); })()`); await sleep(900);
const aVol = await bar(cdp, A);
await tap(cdp, B, '#btn-toggle'); await sleep(500);
const cmds = await ev(cdp, B, `window.__cmds`); const kinds = cmds.map(c=>c&&c.type);
check('③ 遥控下一曲真的换了歌', aAfterNext.bvid !== aBefore.bvid, aBefore.title.slice(0,16) + ' → ' + aAfterNext.title.slice(0,16));
check('③ 遥控上一曲真的切回去', aAfterPrev.bvid === aBefore.bvid, aAfterNext.title.slice(0,16) + ' → ' + aAfterPrev.title.slice(0,16));
check('③ 手机端球阵可打开、有设备球、带远端音量', sheet.open && sheet.rows >= 1 && sheet.vol !== null, JSON.stringify(sheet));
// #29 追加口径：手机端没有设备图标（手势入口）；球阵在页面中央、不用列表
const geo = await ev(cdp, B, `(() => { const p=document.querySelector('.dp-panel').getBoundingClientRect();
  const balls=[...document.querySelectorAll('.dp-ball')], cxs=balls.map(b=>{const q=b.getBoundingClientRect(); return q.left+q.width/2;});
  return {panelFull:p.left<=1 && p.right>=window.innerWidth-1, balls:balls.length, rows:document.querySelectorAll('.dp-row').length,
    ballMidX:balls.length? +((Math.min(...cxs)+Math.max(...cxs))/2).toFixed(1):0, vw:window.innerWidth,
    devBtnShown:!!(document.getElementById('btn-device')||{}).offsetParent}; })()`);
check('③ 手机端没有设备图标（手势入口）', geo.devBtnShown === false, 'visible=' + geo.devBtnShown);
check('③ 球阵铺满屏、球在页面中央（不是列表）', geo.panelFull && geo.balls >= 1 && geo.rows === 0 && Math.abs(geo.ballMidX - geo.vw / 2) < 6, JSON.stringify(geo));
check('③ 中键短按＝遥控对面暂停', aPaused.paused === true, 'paused=' + aPaused.paused);
check('③ 浮层音量条真的改了对面音量', Math.abs(aVol.vol - 0.22) < 0.01, 'A vol=' + aVol.vol);
check('③ 命令都发到位', kinds.includes('prev') && kinds.includes('next') && kinds.includes('toggle') && kinds.includes('volume'), JSON.stringify(kinds));

// ---- #29 桌面入口：点播放条上的设备图标 → 同一份设备列表（桌面不绑长按） ----
await tap(cdp, B, '.dp-scrim'); await sleep(300);   // 收掉 ③ 留下的浮层
const dgeo = await ev(cdp, A, `(() => { const b=document.getElementById('btn-device'); if(!b) return {none:true};
  const r=b.getBoundingClientRect(), tb=document.getElementById('btn-toggle').getBoundingClientRect();
  b.click(); return {shown:!!b.offsetParent, icon:b.querySelector('use').getAttribute('href'), w:Math.round(r.width),
    btnCx:+(tb.left+tb.width/2).toFixed(0)}; })()`);
await sleep(600);
const dlist = await ev(cdp, A, `(() => { const p=document.querySelector('.dp-panel'); if(!p) return {open:false};
  const r=p.getBoundingClientRect(), b=document.getElementById('btn-device').getBoundingClientRect();
  return {open:!document.getElementById('dev-pick').hidden, rows:document.querySelectorAll('#dev-body [data-dev]').length,
    panelCx:+(r.left+r.width/2).toFixed(0), iconCx:+(b.left+b.width/2).toFixed(0),
    title:document.getElementById('dp-title').textContent}; })()`);
check('④ 桌面＝播放条设备图标 + 设备列表', dgeo.shown === true && dgeo.icon === '#i-devices' && dlist.open && dlist.rows >= 2, JSON.stringify(dgeo) + ' ' + JSON.stringify(dlist));
check('④ 桌面设备列表锚在设备图标上', Math.abs(dlist.panelCx - dlist.iconCx) < 2, 'panelCx=' + dlist.panelCx + ' iconCx=' + dlist.iconCx);
await tap(cdp, A, '.dp-scrim'); await sleep(300);

// ---- #29 手机核心交互之一：把播放条往上拖 → 条子缩成小球（正好落在手指处）+ 背景糊掉 + 球阵居中 ----
const beforePull = (await state()).session.song;   // 此刻手机真正在放的那首
const barPt = await ev(cdp, B, `(() => { const r=document.getElementById('player-title').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
const t0 = Date.now();
const dragPt = {x: barPt.x, y: barPt.y - 34};
await touch(cdp, B, 'touchStart', barPt);
await sleep(60);
await touch(cdp, B, 'touchMove', dragPt);       // 往上拖过阈值 → 进入拖动态
await sleep(320);
const dragged = await ev(cdp, B, `(() => { const bar=document.getElementById('player-bar'), p=document.getElementById('dev-pick');
  const r=bar.getBoundingClientRect(), balls=[...document.querySelectorAll('.dp-ball')];
  const cxs=balls.map(b=>{const q=b.getBoundingClientRect(); return q.left+q.width/2;});
  const mid=cxs.length? (Math.min(...cxs)+Math.max(...cxs))/2 : 0;
  return {puck:bar.classList.contains('dragging'), blur:p.classList.contains('blur'), open:!p.hidden,
    w:Math.round(r.width), cx:+(r.left+r.width/2).toFixed(1), cy:+(r.top+r.height/2).toFixed(1),
    fingerX:${Math.round(dragPt.x)}, fingerY:${Math.round(dragPt.y)},
    balls:balls.length, ballMidX:+mid.toFixed(1), vw:window.innerWidth,
    puckTitle:(document.getElementById('puck-title')||{}).textContent||'',
    curBall:!!document.querySelector('.dp-ball.cur'), vol:!!document.getElementById('dp-vol'),
    rows:document.querySelectorAll('.dp-row').length}; })()`);
check('④ 上拖 → 条子缩成小球，且正好落在手指处', dragged.puck === true && dragged.w <= 70 &&
  Math.abs(dragged.cx - dragged.fingerX) < 2 && Math.abs(dragged.cy - dragged.fingerY) < 2,
  '球心=(' + dragged.cx + ',' + dragged.cy + ') 手指=(' + dragged.fingerX + ',' + dragged.fingerY + ') w=' + dragged.w);
check('④ 背景糊掉 + 小球下方挂着歌名', dragged.blur === true && dragged.puckTitle.indexOf(beforePull.title.slice(0, 6)) >= 0, 'title=' + dragged.puckTitle);
check('④ 设备＝页面中央的圆球（不是列表）', dragged.balls >= 1 && dragged.rows === 0 && Math.abs(dragged.ballMidX - dragged.vw / 2) < 6,
  'balls=' + dragged.balls + ' rows=' + dragged.rows + ' 球阵中心=' + dragged.ballMidX + ' 视口中心=' + dragged.vw / 2);
check('④ 在放的那台是粉圈球 + 带远端音量', dragged.curBall === true && dragged.vol === true, JSON.stringify({ cur: dragged.curBall, vol: dragged.vol }));
// ④b 丢回「正在播放」那颗球＝静默收起（用户口径：串流的时候不要弹提示，如「已经在这台设备上播放」）
const curPt = await ev(cdp, B, `(() => { const b=document.querySelector('.dp-ball.cur'); if(!b) return null; const r=b.getBoundingClientRect();
  return {x:r.left+r.width/2, y:r.top+r.height/2}; })()`);
await touch(cdp, B, 'touchMove', curPt); await sleep(200);
await touch(cdp, B, 'touchEnd', curPt);
await sleep(500);
const curDrop = await ev(cdp, B, `(() => { const t=document.getElementById('toast'); const tx=(document.getElementById('toast-txt')||{}).textContent||'';
  return {open:!document.getElementById('dev-pick').hidden, puck:document.getElementById('player-bar').classList.contains('dragging'),
    toastShown:!!t && t.classList.contains('show'), toast:tx}; })()`);
check('④b 丢回正在播放的那台＝静默收起、零提示', curDrop.open === false && curDrop.puck === false && curDrop.toastShown === false,
  JSON.stringify(curDrop));

// 回到拖动态，继续验证「没落在任何球上＝取消」
await touch(cdp, B, 'touchStart', barPt);
await sleep(60);
await touch(cdp, B, 'touchMove', dragPt);
await sleep(320);
await touch(cdp, B, 'touchEnd', dragPt);        // 没落在任何球上
await sleep(400);
const cancelled = await ev(cdp, B, `(() => ({puck:document.getElementById('player-bar').classList.contains('dragging'), open:!document.getElementById('dev-pick').hidden}))()`);
check('④ 没落在球上＝取消（浮层收起、条子归位）', cancelled.puck === false && cancelled.open === false, JSON.stringify(cancelled));

// ---- #29 手机核心交互之二：把播放条往下拉＝回到本机播放 ----
await ev(cdp, B, `window.__toastLog.length=0`);   // 拉回本机这一手势也不该产生任何提示
await touch(cdp, B, 'touchStart', barPt);
await sleep(60);
await touch(cdp, B, 'touchMove', {x:barPt.x, y:barPt.y+40});
await sleep(240);
const downHint = await ev(cdp, B, `(() => { const bar=document.getElementById('player-bar'); return {local:bar.classList.contains('want-local'),
  hint:(getComputedStyle(bar,'::after').content||'').replace(/"/g,''), open:!document.getElementById('dev-pick').hidden}; })()`);
await touch(cdp, B, 'touchEnd', {x:barPt.x, y:barPt.y+40});
check('⑤ 下拖 → 条子被拉下来 + 提示「回到本机播放」（不出球阵）',
  downHint.local === true && downHint.hint.indexOf('回到本机') >= 0 && downHint.open === false, JSON.stringify(downHint));
const pulled = await poll(async () => (await state()).active === bId, 25000);
check('⑤ 松手后播放真的搬到本机（' + (Date.now()-t0) + 'ms）', pulled.ok);
await sleep(600);
let st2 = await bar(cdp, B);
for (let i = 0; i < 60 && !(st2.mirror === false && st2.playing && !st2.paused); i++) { await sleep(500); st2 = await bar(cdp, B); }
const aSt2 = await bar(cdp, A);
check('⑤ 本机播放条退出镜像、开始播放', st2.mirror === false && st2.playing === true && !st2.paused, JSON.stringify(st2).slice(0,150));

// ---- ⑤b 回归探针：在途的过期快照不能把刚接管的设备打回暂停 ----
// 现象：拉流后「本机没声音」偶发（SSE 与 report 响应两条通道，会送来接管之前生成的旧快照，
// active 仍指着上一台设备 → 刚出声的设备误判「我被抢走了」→ 淡出暂停）。
const probeAt = Date.now() - t0;
await ev(cdp, B, `(() => { document.dispatchEvent(new CustomEvent('bm:sessionChanged', { detail: { session: {
  activeDeviceId: 'stale-snapshot-probe', activeDeviceName: '旧快照', revision: 1,
  song: { bvid: 'BVstale', title: 'stale', artist: '', duration: 200 }, playing: true, position: 3, queueSize: 3 }, devices: [] } })); return true; })()`);
await sleep(1500);
const probed = await bar(cdp, B);
check('⑤b 在途过期快照不会让刚接管的设备自己暂停', probed.playing === true && !probed.paused && probed.mirror === false,
  '注入于接管后 ' + probeAt + 'ms：playing=' + probed.playing + ' paused=' + probed.paused + ' mirror=' + probed.mirror + ' artist=' + probed.artist);
let st3 = st2, walked = false;
for (let i = 0; i < 30 && !walked; i++) { await sleep(1000); st3 = await bar(cdp, B); walked = st3.pos > st2.pos + 1.5; }
let aStop = aSt2;
for (let i = 0; i < 12 && aStop.playing; i++) { await sleep(600); aStop = await bar(cdp, A); }
check('⑤ 本机音频真的在走', walked, st2.pos + 's → ' + st3.pos + 's (ready=' + st3.ready + ', paused=' + st3.paused + ')');
check('⑤ 原播放端已停止出声', aStop.playing === false, 'playing=' + aStop.playing + ' paused=' + aStop.paused);
check('⑤ 两边放的是同一首', st3.bvid === beforePull.bvid, st3.bvid + ' vs ' + beforePull.bvid + ' (' + beforePull.title.slice(0,16) + ')');
const pullToasts = await ev(cdp, B, `window.__toastLog.slice()`);
check('⑤ 拉回本机全程零提示', pullToasts.length === 0, JSON.stringify(pullToasts));

// ---- #29 手机核心交互之三：上拖把播放条扔到「另一台设备」的球上＝推回去 ----
const beforePush = (await state()).session.song;
await ev(cdp, B, `window.__toastLog.length=0`);   // 只统计「推出这台」这一手势产生的提示
const pushFrom = await ev(cdp, B, `(() => { const r=document.getElementById('player-title').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
await touch(cdp, B, 'touchStart', pushFrom);
await sleep(60);
await touch(cdp, B, 'touchMove', {x:pushFrom.x, y:pushFrom.y-40});
await sleep(320);
const rowPts = await ev(cdp, B, `(() => { const o={}; document.querySelectorAll('.dp-ball[data-dev]').forEach(r=>{ const b=r.getBoundingClientRect(); o[r.dataset.dev]={x:b.left+b.width/2,y:b.top+b.height/2}; }); return o; })()`);
check('⑥ 球阵里能找到另一台设备（本机不在球里）', !!rowPts[aId], 'balls=' + JSON.stringify(Object.keys(rowPts)));
await touch(cdp, B, 'touchMove', rowPts[aId]);
await sleep(180);
const ballHi = await ev(cdp, B, `(() => { const h=document.querySelector('.dp-ball.hi'); return h?h.dataset.dev:''; })()`);
check('⑥ 跟手高亮落在目标球上', ballHi === aId, 'hi=' + ballHi + ' 目标=' + aId);
await touch(cdp, B, 'touchEnd', rowPts[aId]);
await sleep(300);
const afterDrop = await ev(cdp, B, `(() => ({puck:document.getElementById('player-bar').classList.contains('dragging'), open:!document.getElementById('dev-pick').hidden}))()`);
check('⑥ 松手后小球归位、球阵收起', afterDrop.puck === false && afterDrop.open === false, JSON.stringify(afterDrop));
const pushed = await poll(async () => (await state()).active === aId, 25000);
check('⑥ 对端真的接过播放（' + pushed.el + 'ms）', pushed.ok);
st = await bar(cdp, B);
check('⑥ 本机回到镜像态', st.mirror === true, st.artist);
const stopped = await poll(async () => (await bar(cdp, B)).playing === false, 6000);
check('⑥ 推流后本机停止出声', stopped.ok);
const toastLog = await ev(cdp, B, `window.__toastLog.slice()`);
check('⑥ 推流这一个手势零提示（串流不要任何提示）',
  toastLog.length === 0, JSON.stringify(toastLog));
let aBack = await bar(cdp, A);
for (let i = 0; i < 30 && !(aBack.playing && aBack.bvid === beforePush.bvid); i++) { await sleep(1000); aBack = await bar(cdp, A); }
if (!aBack.playing) {
  const aDeep = await ev(cdp, A, `(() => { const a=document.getElementById('audio');
    return {paused:a.paused, ready:a.readyState, net:a.networkState, err:a.error?a.error.code:null, src:(a.src||'').split('/').pop().slice(0,30),
      cur:Math.round(a.currentTime*10)/10, needGesture: !!(window.__sessionSync.needGesture&&window.__sessionSync.needGesture()),
      pending: !!(window.__sessionSync.pending&&window.__sessionSync.pending()), btn:document.getElementById('btn-toggle').title,
      mirror: /(^|\\s)mirror(\\s|$)/.test(document.getElementById('player-bar').className),
      toast:(document.querySelector('.toast, #toast')||{}).textContent||''}; })()`);
  console.log('  A 端诊断:', JSON.stringify(aDeep));
  await tap(cdp, A, '#btn-toggle');
  for (let i = 0; i < 20 && !aBack.playing; i++) { await sleep(1000); aBack = await bar(cdp, A); }
}
check('⑥ 对端继续在放同一首', aBack.playing === true && aBack.bvid === beforePush.bvid, aBack.title.slice(0,20) + ' | ' + aBack.bvid + ' vs ' + beforePush.bvid);

// ---- ⑦ 串流态点歌（#29 第二轮）：控制器上点一首歌 → 在放的那台换歌，控制器不出声、继续镜像 ----
await ev(cdp, B, `window.__cmds=[]; (() => { const raw=window.fetch; window.fetch=function(u,i){ try{ if(String(u).indexOf('/api/session/command')>=0) window.__cmds.push(JSON.parse(i.body)); }catch(e){} return raw(u,i); }; })();`);
const bPick = await ev(cdp, B, `(() => { const cards=[...document.querySelectorAll('#view-library [data-play], .rec-card[data-play], [data-play]')];
  const c=cards[1]||cards[0]; if(!c) return null;
  const q=window.BiliPlayer.queue(); const it=q.filter(x=>String(x.songId)===String(c.dataset.play))[0]||null;
  return {id:c.dataset.play, bvid:it?it.bvid:null, title:it?it.title:''}; })()`);
const aBeforePick = await bar(cdp, A);
const picked = await ev(cdp, B, `(() => { const cards=[...document.querySelectorAll('#view-library [data-play], .rec-card[data-play], [data-play]')];
  const c=cards[1]||cards[0]; if(!c) return {clicked:false, cards:0}; c.click(); return {clicked:true, cards:cards.length}; })()`, false, true);
const adopted = await poll(async () => { const x = await bar(cdp, A); return x.bvid === bPick.bvid && x.playing; }, 15000);
const aPicked = await bar(cdp, A);
const bAfterPick = await bar(cdp, B);
const pickCmds = (await ev(cdp, B, `window.__cmds`)).map(c => c && c.type);
check('⑦ 串流态点歌＝在放的那台换歌播', picked.clicked && adopted.ok && aPicked.bvid === bPick.bvid,
  'cards=' + picked.cards + ' | ' + aBeforePick.title.slice(0,16) + ' → ' + aPicked.title.slice(0,16) + ' (' + bPick.bvid + ')');
check('⑦ 发出的是带队列的 play 命令', pickCmds.includes('play'), JSON.stringify(pickCmds.slice(-3)));
check('⑦ 控制器本机没偷跑、还在镜像态', bAfterPick.mirror === true && bAfterPick.playing === false, 'mirror=' + bAfterPick.mirror + ' playing=' + bAfterPick.playing);

// ---- ⑧ 串流态进歌曲详情页（歌词页）：标题＝远端那首，控制条遥控对面 ----
await tap(cdp, B, '#player-cover'); await sleep(1600);
const lyr = await ev(cdp, B, `(() => { const p=document.getElementById('lyrics-panel');
  return {open:!p.classList.contains('hidden'), title:document.getElementById('ly-title-big').textContent,
    artist:document.getElementById('ly-artist-big').textContent, cur:document.getElementById('ly-cur').textContent}; })()`);
check('⑧ 串流态详情页显示远端那首', lyr.open && lyr.title === aPicked.title, lyr.title + ' | ' + lyr.artist + ' | ' + lyr.cur);
const aPlayBefore = await bar(cdp, A);
await tap(cdp, B, '#ly-toggle'); await sleep(1000);
const aLyPaused = await bar(cdp, A);
check('⑧ 详情页播放键遥控对面暂停', aPlayBefore.playing === true && aLyPaused.paused === true && aLyPaused.playing === false,
  'A: playing ' + aPlayBefore.playing + ' → ' + aLyPaused.playing);
await tap(cdp, B, '#ly-toggle'); await sleep(1000);
const aLyPlayed = await bar(cdp, A);
check('⑧ 详情页再点一下对面继续播', aLyPlayed.playing === true, 'A playing=' + aLyPlayed.playing);
await tap(cdp, B, '#ly-next'); await sleep(1800);
const aLyNext = await bar(cdp, A);
check('⑧ 详情页下一曲作用在对面', aLyNext.bvid !== aLyPaused.bvid, aLyPaused.title.slice(0,14) + ' → ' + aLyNext.title.slice(0,14));

// ---- ⑨ 串流态点「未收藏」的推荐/最近播放：也要推给在放的那台，控制器不许自己响 ----
// 用户实测：串流态点推荐卡（未收藏 → 走试听流）本机自己出声、对面毫无反应。
const PROBE = `(() => { if (window.__pp) return true; window.__pp=new Set();
  const p=HTMLMediaElement.prototype.play, z=HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.play=function(){ try{ window.__pp.add(this); }catch(e){} return p.apply(this,arguments); };
  HTMLMediaElement.prototype.pause=function(){ try{ window.__pp.delete(this); }catch(e){} return z.apply(this,arguments); };
  window.__liveCount=()=>{ const all=[...new Set([...document.querySelectorAll('audio'),...(window.__pp||[])])];
    return all.filter(el=>!el.paused&&!el.ended).length; };
  return true; })()`;
await ev(cdp, A, PROBE); await ev(cdp, B, PROBE);
await tap(cdp, B, '#btn-lyrics-close'); await sleep(600);          // 关掉详情页，回到播放条
const recInfo = await ev(cdp, B, `(() => { const c=document.querySelector('.rec-card[data-bvid], .trk-rec[data-bvid]');
  return c ? { bvid: c.dataset.bvid, title: (c.getAttribute('title')||'').slice(0,24) } : null; })()`);
const beforeRec = (await state()).session.song;
await ev(cdp, B, `(() => { const c=document.querySelector('.rec-card[data-bvid], .trk-rec[data-bvid]'); c.click(); return true; })()`, false, true);
const recAdopted = await poll(async () => { const s = await state(); return s.session && s.session.song && s.session.song.bvid === recInfo.bvid ? s : null; }, 15000);
const bLive = await ev(cdp, B, `window.__liveCount()`);
const aLive = await ev(cdp, A, `window.__liveCount()`);
check('⑨ 串流态点未收藏的推荐＝推给在放的那台', recAdopted.ok && recAdopted.v.active === aId,
  (beforeRec.title||'').slice(0,16) + ' → ' + (recInfo.title||'') + ' | active=' + (recAdopted.v && recAdopted.v.active) +
  ' A=' + aId + ' B=' + bId);
check('⑨ 控制器本机不出声（不再两处同时响）', bLive === 0, 'B 在响的媒体数=' + bLive + ' A=' + aLive);

// ---- ⑩ 回归：同一条试听再点一次 = 接着听，不能「主音轨那首 + 试听」两首一起放 ----
// 用户实测：手机放完一首 →（串流往返）→ 再点歌，两首一起响。根因在试听「同一条再点」的早退分支没让主音轨停。
const recClick = `(() => { const c=document.querySelector('.rec-card[data-bvid], .trk-rec[data-bvid]'); c.click(); return true; })()`;
const libClick = `(() => { const c=[...document.querySelectorAll('#view-library [data-play], [data-play]')][0]; c.click(); return true; })()`;
const live = () => ev(cdp, A, `window.__liveCount()`);
await ev(cdp, A, libClick, false, true); await sleep(1800);
const liveLib = await live();                       // 主音轨在放
await ev(cdp, A, recClick, false, true); await sleep(1800);
const liveTrial = await live();                     // 试听接管，主音轨让位
await ev(cdp, A, libClick, false, true); await sleep(1800);
const liveBack = await live();                      // 回主音轨（试听暂停）
await ev(cdp, A, recClick, false, true); await sleep(1800);
const dupLive = await live();                       // 关键：再点同一条试听 = 只应有一个在响
check('⑩ 同一条试听再点＝单曲播放（不再两首叠放）', dupLive === 1 && liveLib === 1 && liveTrial === 1 && liveBack === 1,
  '库内=' + liveLib + ' 试听=' + liveTrial + ' 回库内=' + liveBack + ' 再点同一条试听=' + dupLive);

const errs = cdp.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>(e.params.exceptionDetails.exception||{}).description||e.params.exceptionDetails.text);
check('无页面异常', errs.length === 0, errs.slice(0,2).join(' || ').slice(0,200));
console.log('\n' + (results.every(r=>r.ok)?'ALL PASS':'SOME FAILED') + ' — ' + results.filter(r=>r.ok).length + '/' + results.length);
process.exit(results.every(r=>r.ok)?0:1);
