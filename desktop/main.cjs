const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createWriteStream, mkdirSync } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
let backend, win, quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.restore(); win.focus(); } });
  app.whenReady().then(launch).catch(fail);
}

function fail(error) {
  if (quitting) return;
  dialog.showErrorBox('BiliMusic', 'Unable to start the local player.\n' + error.message);
  app.quit();
}

async function launch() {
  win = new BrowserWindow({ width: 1280, height: 850, minWidth: 800, minHeight: 600,
    backgroundColor: '#f3f3f7', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(path.join(__dirname, 'loading.html'));
  const data = app.getPath('userData');
  mkdirSync(data, { recursive: true });
  const log = createWriteStream(path.join(data, 'backend.log'), { flags: 'a' });
  const executable = path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, 'backend', 'bilimusic-backend'),
    app.isPackaged ? 'backend' : '', process.platform === 'win32' ? 'bilimusic-backend.exe' : 'bilimusic-backend');
  backend = spawn(executable, ['--data-dir', path.join(data, 'data')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stderr.pipe(log);
  backend.on('error', fail);
  backend.on('exit', code => { if (!quitting) fail(new Error('Backend exited (' + code + '). See ' + path.join(data, 'backend.log'))); });
  const origin = await new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: backend.stdout });
    const timer = setTimeout(() => reject(new Error('Backend startup timed out')), 120000);
    lines.on('line', line => {
      log.write(line + '\n');
      if (/^BILIMUSIC_URL=http:\/\/127\.0\.0\.1:\d+$/.test(line)) { clearTimeout(timer); resolve(line.slice(14)); }
    });
  });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(origin + '/openapi.json', { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  if (!ready) throw new Error('Backend did not become ready');
  function external(url) { if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) { event.preventDefault(); external(url); } });
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  await win.loadURL(origin);
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; if (backend) backend.kill(); });
