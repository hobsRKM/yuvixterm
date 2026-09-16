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
  clipboard: {
    read: () => invoke('clipboard:read'),
    write: (text) => invoke('clipboard:write', { text }),
  },
  fm: {
    home: (tabId) => invoke('fm:home', { tabId }),
    localList: (p) => invoke('fm:localList', { path: p }),
    localMkdir: (dir, name) => invoke('fm:localMkdir', { dir, name }),
    localRename: (from, to) => invoke('fm:localRename', { from, to }),
    localDelete: (p) => invoke('fm:localDelete', { path: p }),
    remoteList: (tabId, p) => invoke('fm:remoteList', { tabId, path: p }),
    remoteMkdir: (tabId, dir, name) => invoke('fm:remoteMkdir', { tabId, dir, name }),
    remoteRename: (tabId, from, to) => invoke('fm:remoteRename', { tabId, from, to }),
    remoteDelete: (tabId, p) => invoke('fm:remoteDelete', { tabId, path: p }),
    download: (tabId, remotePath, localPath) => invoke('fm:download', { tabId, remotePath, localPath }),
    upload: (tabId, localPath, remotePath) => invoke('fm:upload', { tabId, localPath, remotePath }),
  },
  on: {
    termData: (cb) => sub('term:data', cb),
    status: (cb) => sub('conn:status', cb),
    needPassword: (cb) => sub('conn:needPassword', cb),
    hostkey: (cb) => sub('conn:hostkey', cb),
    stats: (cb) => sub('stats:update', cb),
    fmProgress: (cb) => sub('fm:progress', cb),
  },
});
