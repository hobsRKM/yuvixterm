'use strict';
const { app, BrowserWindow, safeStorage } = require('electron');
const path = require('node:path');
const { SessionStore } = require('./session-store');
const { HostKeyVerifier } = require('./host-key-verifier');
const { ConnectionManager } = require('./connection-manager');
const { FileManager } = require('./file-manager');
const { registerIpc } = require('./ipc');

// Keep the app data directory + Keychain safeStorage key stable
// ("mac-ssh-client") regardless of the bundle's productName ("YuviXterm"), so
// saved sessions and their encrypted secrets survive the rebrand.
app.setName('mac-ssh-client');
// ...but present the real brand everywhere the user actually sees a name:
// the macOS "About" panel (and the app/Dock name) show "YuviXterm", not the
// internal storage id. This does not move the data directory.
app.setAboutPanelOptions({
  applicationName: 'YuviXterm',
  applicationVersion: require('../package.json').version,
  version: '',
  copyright: '© 2026 Yuvaraj Mudaliar · A cross-platform SSH client with a live server monitor',
});
// On Windows, use the same AppUserModelId that electron-builder stamps on the
// installer's Start Menu / desktop shortcuts, so the taskbar groups the running
// window with them and "Pin to taskbar" doesn't produce a duplicate icon.
// Must match "build.appId" in package.json (a literal: electron-builder strips
// the "build" section from the packaged package.json).
if (process.platform === 'win32') app.setAppUserModelId('com.yuvim.macssh');

let mainWindow = null;
let connections = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#0d1117',
    title: 'YuviXterm',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.MSSH_SMOKE) attachSmoke(mainWindow);
  const indexPath = path.join(__dirname, '..', 'renderer', 'index.html');
  if (process.env.MSSH_SHOT) {
    attachShot(mainWindow);
    mainWindow.loadFile(indexPath, process.env.MSSH_SHOT_DEMO ? { search: 'demo=1' } : {});
    return mainWindow;
  }
  mainWindow.loadFile(indexPath);
  return mainWindow;
}

// Env-guarded screenshot: renders the preview (?demo=1) and writes a PNG to
// $MSSH_SHOT, then quits. Only runs when MSSH_SHOT is set.
function attachShot(win) {
  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        if (process.env.MSSH_SHOT_JS) {
          await win.webContents.executeJavaScript(process.env.MSSH_SHOT_JS);
          await new Promise((r) => setTimeout(r, 250));
        }
        const img = await win.webContents.capturePage();
        require('node:fs').writeFileSync(process.env.MSSH_SHOT, img.toPNG());
        console.log('SHOT_SAVED ' + process.env.MSSH_SHOT);
      } catch (e) {
        console.log('SHOT_ERR ' + (e && e.message));
      }
      setTimeout(() => app.quit(), 100);
    }, 800);
  });
}

// Env-guarded self-check: verifies the renderer + preload + xterm load and
// that window.api round-trips, then quits. Only runs when MSSH_SMOKE is set.
function attachSmoke(win) {
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('RENDERER_CONSOLE[' + level + '] ' + message);
  });
  win.webContents.on('preload-error', (_e, p, err) => console.log('PRELOAD_ERR ' + err.message));
  win.webContents.on('did-finish-load', async () => {
    try {
      const diag = await win.webContents.executeJavaScript(`(async () => {
        const out = {
          hasApi: !!(window.api && window.api.sessions && window.api.conn && window.api.on),
          Terminal: typeof window.Terminal,
          FitAddon: !!(window.FitAddon && window.FitAddon.FitAddon),
        };
        try { out.sessions = await window.api.sessions.list(); } catch (e) { out.listErr = String(e); }
        return out;
      })()`);
      console.log('SMOKE_RESULT ' + JSON.stringify(diag));
    } catch (e) {
      console.log('SMOKE_ERROR ' + (e && e.message));
    }
    setTimeout(() => app.quit(), 200);
  });
}

app.whenReady().then(() => {
  const dir = app.getPath('userData');
  const store = new SessionStore({ dir, safeStorage });
  const verifier = new HostKeyVerifier({ dir });
  connections = new ConnectionManager({
    store, verifier,
    emit: (ch, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload);
    },
  });
  const files = new FileManager({
    getClient: (tabId) => connections.getClient(tabId),
    emit: (ch, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload);
    },
  });
  registerIpc({ store, connections, files });

  // One-shot bulk import: MSSH_SEED=<file.json> electron .  (array of {session, secrets})
  // Encrypts secrets via the same safeStorage the app uses, then quits. No window.
  if (process.env.MSSH_SEED) {
    try {
      const seed = JSON.parse(require('node:fs').readFileSync(process.env.MSSH_SEED, 'utf8'));
      const saved = seed.map((e) => store.save(e.session, e.secrets || {}));
      console.log('SEED_OK ' + JSON.stringify(saved.map((r) => ({ name: r.name, host: r.host }))));
    } catch (e) {
      console.log('SEED_ERR ' + (e && e.message));
    }
    app.quit();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (connections) connections.closeAll();
  if (process.platform !== 'darwin') app.quit();
});
