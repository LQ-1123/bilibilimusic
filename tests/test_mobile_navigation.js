const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const elements = {};
  for (const id of ['app', 'login-modal', 'mini-modal', 'search-drop', 'lyrics-panel', 'queue-panel', 'up-panel']) {
    elements[id] = { dataset: { view: 'home' }, hidden: true, classList: { contains: () => true } };
  }
  const observers = [], events = {}, entries = [null];
  const history = {
    state: null,
    pushState(s) { entries.push(s); this.state = s; },
    replaceState(s) { entries[entries.length - 1] = s; this.state = s; },
    back() { entries.pop(); this.state = entries.at(-1); events.popstate({ state: this.state }); },
  };
  const context = { history, document: { readyState: 'complete', getElementById: id => elements[id] },
    MutationObserver: class { constructor(cb) { observers.push(cb); } observe() {} },
    addEventListener: (name, fn) => { events[name] = fn; },
    goHome() { elements.app.dataset.view = 'home'; },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('app/web/static/back-stack.js', 'utf8'), context);
  return { elements, context, history, entries, sync: () => observers[0]() };
}

test('search results replace the dropdown and system back returns home', () => {
  const s = setup();
  s.elements['search-drop'].hidden = false;
  s.sync();
  s.elements['search-drop'].hidden = true;
  s.elements.app.dataset.view = 'search';
  s.sync();
  assert.equal(s.context.__backStackDepth(), 1);
  assert.equal(s.elements.app.dataset.view, 'search');
  s.history.back();
  s.sync();
  assert.equal(s.elements.app.dataset.view, 'home');
  assert.equal(s.context.__backStackDepth(), 0);
});

test('#34 detail layer close prefers closeDetailTo (returns to the origin view)', () => {
  const s = setup();
  let toCalled = 0, homeCalled = 0;
  s.context.goHome = () => { homeCalled++; s.elements.app.dataset.view = 'home'; };
  s.context.closeDetailTo = () => { toCalled++; s.elements.app.dataset.view = 'library'; };
  s.elements.app.dataset.view = 'detail';
  s.sync();
  assert.equal(s.context.__backStackDepth(), 1);
  s.history.back();
  s.sync();
  assert.equal(toCalled, 1);
  assert.equal(homeCalled, 0);
  assert.equal(s.elements.app.dataset.view, 'library');
});

test('#34 the library tab view is not a back-stack layer', () => {
  const s = setup();
  s.elements.app.dataset.view = 'library';
  s.sync();
  assert.equal(s.context.__backStackDepth(), 0);
});
