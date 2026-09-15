'use strict';
const { ipcMain, dialog, BrowserWindow } = require('electron');
const os = require('node:os');
const path = require('node:path');

// Register the renderer<->main API (spec sec.8). All inputs are validated here.
function registerIpc({ store, connections }) {
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
    connections.close(String(tabId));
    return { ok: true };
  });
  ipcMain.handle('conn:answerPassword', (_e, { tabId, password }) => {
    connections.answerPassword(String(tabId), password);
  });
  ipcMain.handle('conn:answerHostKey', (_e, { tabId, accept }) => {
    connections.answerHostKey(String(tabId), !!accept);
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
}

module.exports = { registerIpc };
