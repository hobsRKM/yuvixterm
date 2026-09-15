'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, payload) => ipcRenderer.invoke(ch, payload);
function sub(ch, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, listener);
  return () => ipcRenderer.removeListener(ch, listener);
}

// The only surface the renderer sees. No raw ipcRenderer / Node leaks.
contextBridge.exposeInMainWorld('api', {
  sessions: {
    list: () => invoke('sessions:list'),
    save: (session, secrets) => invoke('sessions:save', { session, secrets }),
    delete: (id) => invoke('sessions:delete', { id }),
  },
  conn: {
    // opts: { sessionId } for a saved host, or { session, secrets } ephemeral
    open: (tabId, opts) => invoke('conn:open', { tabId, ...opts }),
    write: (tabId, data) => invoke('conn:write', { tabId, data }),
    resize: (tabId, cols, rows) => invoke('conn:resize', { tabId, cols, rows }),
    close: (tabId) => invoke('conn:close', { tabId }),
    answerPassword: (tabId, password) => invoke('conn:answerPassword', { tabId, password }),
    answerHostKey: (tabId, accept) => invoke('conn:answerHostKey', { tabId, accept }),
  },
  dialog: {
    pickKey: (current) => invoke('dialog:pickKey', { current }),
  },
  on: {
    termData: (cb) => sub('term:data', cb),
    status: (cb) => sub('conn:status', cb),
    needPassword: (cb) => sub('conn:needPassword', cb),
    hostkey: (cb) => sub('conn:hostkey', cb),
    stats: (cb) => sub('stats:update', cb),
  },
});
