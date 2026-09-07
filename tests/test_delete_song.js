const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app/web/static/app.js', 'utf8');

for (const success of [true, false]) {
  test('delete removes row immediately and ' + (success ? 'keeps it removed on success' : 'restores it on failure'), async () => {
    let resolve;
    let handler;
    const row = { hidden: false };
    const button = { dataset: { del: '42' }, closest: () => row };
    const context = vm.createContext({
      document: { addEventListener: (_, fn) => { handler = fn; }, body: {} },
      window: { __toast() {} },
      fetch: () => new Promise(r => { resolve = r; }),
      refreshPlaylist() {},
    });
    const start = source.indexOf('  document.addEventListener("click"');
    const end = source.indexOf('\n  });', start) + 6;
    vm.runInContext(source.slice(start, end), context);
    handler({ target: { closest: selector => selector === '[data-del]' ? button : null } });
    assert.equal(row.hidden, true);
    resolve({ ok: success });
    await new Promise(r => setImmediate(r));
    assert.equal(row.hidden, success);
  });
}
