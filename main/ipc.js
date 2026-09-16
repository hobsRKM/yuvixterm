'use strict';
const { ipcMain, dialog, BrowserWindow, clipboard } = require('electron');
const os = require('node:os');
const path = require('node:path');

// Register the renderer<->main API (spec sec.8). All inputs are validated here.
function registerIpc({ store, connections, files }) {
  ipcMain.handle('sessions:list', () => store.list());
  ipcMain.handle('sessions:save', (_e, { session, secrets }) => store.save(session, secrets || {}));
  ipcMain.handle('sessions:delete', (_e, { id }) => { store.delete(id); return { ok: true }; });

  ipcMain.handle('conn:open', (_e, payload) => {
    const tabId = String(payload.tabId);
    let session, secrets;
    if (payload.sessionId) {
      session = store.get(payload.sessionId);
      if (!session) throw new Error('Unknown session: ' + payload.sessionId);
      secrets = store.getSecrets(payload.sessionId);
    } else if (payload.session) {
      session = payload.session;          // ephemeral quick-connect
      secrets = payload.secrets || {};
    } else {
      throw new Error('conn:open requires sessionId or session');
    }
    connections.open(tabId, session, secrets);
    return { ok: true };
  });

  ipcMain.handle('conn:write', (_e, { tabId, data }) => {
    connections.write(String(tabId), data);
  });
  ipcMain.handle('conn:resize', (_e, { tabId, cols, rows }) => {
    const c = Math.max(1, Math.min(500, cols | 0));
    const r = Math.max(1, Math.min(500, rows | 0));
    connections.resize(String(tabId), c, r);
  });
  ipcMain.handle('conn:close', (_e, { tabId }) => {
    files.closeTab(String(tabId));
    connections.close(String(tabId));
    return { ok: true };
  });
  ipcMain.handle('conn:answerPassword', (_e, { tabId, password }) => {
    connections.answerPassword(String(tabId), password);
  });
  ipcMain.handle('conn:answerHostKey', (_e, { tabId, accept }) => {
    connections.answerHostKey(String(tabId), !!accept);
  });

  // Clipboard for the terminal copy/paste menu (renderer is sandboxed).
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_e, { text }) => {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  });

  ipcMain.handle('dialog:pickKey', async (_e, { current } = {}) => {
    let defaultPath = os.homedir();
    if (current) {
      try { defaultPath = path.dirname(current.replace(/^~/, os.homedir())); } catch { /* */ }
    }
    const res = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
      title: 'Select SSH private key',
      defaultPath,
      properties: ['openFile', 'showHiddenFiles'],
      buttonLabel: 'Use key',
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  // ---- file browser ----
  ipcMain.handle('fm:home', async (_e, { tabId }) => {
    const local = files.localHome();
    let remote = null, remoteErr = null;
    try { remote = await files.remoteHome(String(tabId)); } catch (e) { remoteErr = (e && e.message) || 'Not connected'; }
    return { local, remote, remoteErr };
  });
  ipcMain.handle('fm:localList', (_e, { path: p }) => files.localList(p));
  ipcMain.handle('fm:localMkdir', (_e, { dir, name }) => files.localMkdir(dir, name));
  ipcMain.handle('fm:localRename', (_e, { from, to }) => { files.localRename(from, to); return { ok: true }; });
  ipcMain.handle('fm:localDelete', (_e, { path: p }) => { files.localDelete(p); return { ok: true }; });
  ipcMain.handle('fm:remoteList', (_e, { tabId, path: p }) => files.remoteList(String(tabId), p));
  ipcMain.handle('fm:remoteMkdir', (_e, { tabId, dir, name }) => files.remoteMkdir(String(tabId), dir, name));
  ipcMain.handle('fm:remoteRename', (_e, { tabId, from, to }) => files.remoteRename(String(tabId), from, to));
  ipcMain.handle('fm:remoteDelete', (_e, { tabId, path: p }) => files.remoteDelete(String(tabId), p));
  ipcMain.handle('fm:download', (_e, { tabId, remotePath, localPath }) => files.download(String(tabId), remotePath, localPath));
  ipcMain.handle('fm:upload', (_e, { tabId, localPath, remotePath }) => files.upload(String(tabId), localPath, remotePath));
}

module.exports = { registerIpc };
