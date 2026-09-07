const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const ui = fs.readFileSync("app/web/static/v3.js", "utf8");
const player = fs.readFileSync("app/web/static/app.js", "utf8");

function setup(search) {
  const rows = ["BV1", "BV2", "BV3"].map((bvid, i) => ({
    dataset: { bvid, artist: "Artist " + i },
    querySelector(selector) {
      if (selector === "img") return { src: "cover" + i };
      return selector.split(",").some(s => s.trim() === (search ? ".sd-t" : ".t1"))
        ? { textContent: "Song " + i } : null;
    },
    closest() { return scope; },
  }));
  const scope = { querySelectorAll: () => rows };
  const context = vm.createContext({
    window: {}, recActive: true, recAudio: {},
    stopTrial() { throw new Error("Unexpected switch to library"); },
  });
  context.window.playStream = (bvid, meta) => { context.playing = { bvid, ...meta }; };
  context.playStream = context.window.playStream;
  vm.runInContext(ui.slice(ui.indexOf("  window.__trialQueue = null;"), ui.indexOf("  // 歌单增删改后")), context);
  vm.runInContext(player.slice(player.indexOf("  function skip(delta)"), player.indexOf('  document.addEventListener("click"', player.indexOf("  function skip(delta)"))), context);
  return { context, rows };
}

for (const search of [false, true]) {
  test((search ? "search" : "recommendation") + " queue supports next, previous and wraparound", () => {
    const { context, rows } = setup(search);
    context.window.playRecRow(rows[0]);
    context.skip(1);
    assert.equal(context.playing.bvid, "BV2");
    assert.equal(context.playing.title, "Song 1");
    assert.equal(context.playing.artist, "Artist 1");
    context.skip(-1);
    assert.equal(context.playing.bvid, "BV1");
    context.skip(-1);
    assert.equal(context.playing.bvid, "BV3");
  });
}

test("search dropdown clicks establish their own queue", () => {
  const { context, rows } = setup(true);
  context.window.playRecRow(rows[2]);
  context.playRecRow = context.window.playRecRow;
  context.close = () => {};
  context.web = { addEventListener: (_, fn) => { context.click = fn; } };
  const start = ui.indexOf('    web.addEventListener("click"');
  vm.runInContext(ui.slice(start, ui.indexOf('    document.addEventListener("click"', start)), context);
  context.click({ target: { closest: selector => selector === ".sd-row" ? rows[0] : null } });
  context.skip(1);
  assert.equal(context.playing.bvid, "BV2");
});

test("online track ending advances the active queue", () => {
  const { context, rows } = setup(false);
  context.window.playRecRow(rows[0]);
  context.recAudio.dataset = { bvid: "BV1" };
  context.bvid = "BV1";
  context.resetRecButtons = () => {};
  context.setPlayerToggle = () => {};
  context.audioA = context.audioB = { paused: true };
  context.document = { body: { classList: { remove() {} } } };
  context.recAudio.addEventListener = (_, fn) => { context.ended = fn; };
  const start = player.indexOf('    recAudio.addEventListener("ended"');
  vm.runInContext(player.slice(start, player.indexOf('    recAudio.addEventListener("error"', start)), context);
  context.ended();
  assert.equal(context.playing.bvid, "BV2");
});
