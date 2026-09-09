const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const src = fs.readFileSync("app/web/static/share.js", "utf8");

function load(opts) {
  opts = opts || {};
  const calls = { toast: [], native: [], modal: [], fetch: [] };
  const win = {
    __toast: (m) => calls.toast.push(m),
    __promptModal: (t, o) => calls.modal.push([t, o && o.value]),
  };
  if (opts.native) win.BiliMusicNative = { shareText: (...a) => calls.native.push(a) };
  if (opts.login) win.openLogin = () => calls.login = true;

  const nav = {};
  if (opts.share === "ok") nav.share = () => Promise.resolve();
  if (opts.share === "abort") nav.share = () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }));
  if (opts.share === "fail") nav.share = () => Promise.reject(new Error("boom"));
  if (opts.clipboard === "ok") nav.clipboard = { writeText: () => Promise.resolve() };
  if (opts.clipboard === "fail") nav.clipboard = { writeText: () => Promise.reject(new Error("nope")) };

  const doc = {
    body: { dataset: { auth: opts.loggedIn === false ? "0" : "1" }, appendChild() {}, removeChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, select() {} }),
    execCommand: () => opts.execOk !== false,
  };
  const response = opts.response || { ok: true, json: () => Promise.resolve({ mode: "single", importId: "abc" }) };
  const ctx = vm.createContext({
    window: win,
    navigator: nav,
    document: doc,
    fetch: (url, init) => {
      calls.fetch.push([url, JSON.parse(init.body)]);
      return Promise.resolve(response);
    },
    htmx: { trigger() {} },
  });
  vm.runInContext(src, ctx);
  return { win, calls };
}

test("原生桥优先：Android 走系统分享面板，不再触发 Web 方案", async () => {
  const { win, calls } = load({ native: true, share: "ok", clipboard: "ok" });
  assert.equal(await win.__share({ title: "歌名", text: "歌名 - UP", url: "https://www.bilibili.com/video/BV1" }),
    "native");
  assert.deepEqual(calls.native, [["歌名", "歌名 - UP", "https://www.bilibili.com/video/BV1"]]);
  assert.match(calls.toast[0], /系统分享/);
});

test("浏览器 HTTPS/localhost：走 navigator.share", async () => {
  const { win, calls } = load({ share: "ok" });
  assert.equal(await win.__share({ title: "歌单", url: "https://space.bilibili.com/1/favlist?fid=2" }), "share");
  assert.equal(calls.modal.length, 0);
});

test("用户自己取消分享：静默返回，不降级复制、不弹窗", async () => {
  const { win, calls } = load({ share: "abort", clipboard: "ok" });
  assert.equal(await win.__share({ title: "x", url: "https://b23.tv/abc" }), "abort");
  assert.deepEqual(calls.toast, []);
  assert.equal(calls.modal.length, 0);
});

test("系统分享失败：降级到剪贴板并提示已复制", async () => {
  const { win, calls } = load({ share: "fail", clipboard: "ok" });
  assert.equal(await win.__share({ title: "x", url: "https://b23.tv/abc" }), "copy");
  assert.match(calls.toast.join(" "), /已复制/);
});

test("局域网 http（无 navigator.share/clipboard）：execCommand 兜底", async () => {
  const { win, calls } = load({});
  assert.equal(await win.__share({ title: "x", text: "歌名", url: "https://b23.tv/abc" }), "copy");
  assert.match(calls.toast.join(" "), /已复制/);
  assert.equal(calls.modal.length, 0);
});

test("剪贴板被拒：再退一层 execCommand", async () => {
  const { win } = load({ clipboard: "fail", execOk: true });
  assert.equal(await win.__share({ title: "x", url: "https://b23.tv/abc" }), "copy");
});

test("复制全失败：弹窗把链接摆到用户面前，不静默", async () => {
  const { win, calls } = load({ clipboard: "fail", execOk: false });
  assert.equal(await win.__share({ title: "分享「x」", url: "https://b23.tv/abc" }), "show");
  assert.deepEqual(calls.modal, [["分享「x」", "https://b23.tv/abc"]]);
});

test("没有链接：明确提示，不发空分享", async () => {
  const { win, calls } = load({});
  assert.equal(await win.__share({ title: "x" }), "none");
  assert.match(calls.toast[0], /拿不到分享链接/);
});

test("反向分享：把文本交给 /api/imports/batch 并提示导入", async () => {
  const { win, calls } = load({ response: { ok: true, json: () => Promise.resolve({ mode: "batch", folderTitle: "我的收藏", total: 3 }) } });
  win.__receiveShare("【标题】 https://b23.tv/abc 分享自哔哩哔哩客户端");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.fetch, [["/api/imports/batch", { url: "【标题】 https://b23.tv/abc 分享自哔哩哔哩客户端", playlistId: 0 }]]);
  assert.match(calls.toast.join(" "), /我的收藏/);
});

test("反向分享：未登录先说清原因并弹登录，不静默失败", async () => {
  const { win, calls } = load({ loggedIn: false, login: true });
  win.__receiveShare("https://b23.tv/abc");
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.login, true);
  assert.match(calls.toast[0], /先登录/);
});

test("反向分享：后端 400 时把原因告诉用户", async () => {
  const { win, calls } = load({ response: { ok: false, json: () => Promise.resolve({ detail: "无法识别的分享内容" }) } });
  win.__receiveShare("https://b23.tv/abc");
  await new Promise((r) => setImmediate(r));
  assert.match(calls.toast.join(" "), /无法识别的分享内容/);
});

test("反向分享：没有 B 站链接的文本直接说清，不排一个注定失败的任务", async () => {
  const { win, calls } = load({});
  win.__receiveShare("今天天气不错，出去走走吧");
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.fetch.length, 0);
  assert.match(calls.toast[0], /没识别到 B 站链接/);
});

test("反向分享：纯 BV 号也算可识别", async () => {
  const { win, calls } = load({});
  win.__receiveShare("BV1xx411c7mD");
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.fetch.length, 1);
});
