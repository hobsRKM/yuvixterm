'use strict';
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { posixJoin, sortEntries } = require('./fm-util');

// Local filesystem + per-tab SFTP file operations for the file browser.
// SFTP rides the tab's existing ssh2 client (getClient(tabId)).
class FileManager {
  constructor({ getClient, emit }) {
    this.getClient = getClient;   // (tabId) => ssh2 Client | null
    this.emit = emit || (() => {}); // (channel, payload)
    this._sftp = new Map();       // tabId -> sftp channel
    this._xferId = 0;
  }

  // ---------------- local ----------------
  localHome() { return os.homedir(); }

  localList(dir) {
    const out = [];
    for (const de of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, de.name);
      let isDir = de.isDirectory(), size = 0, mtime = 0;
      try {
        const st = fs.statSync(full);       // follow symlinks
        isDir = st.isDirectory(); size = st.size; mtime = st.mtimeMs;
      } catch { /* broken symlink / no perms: keep dirent info */ }
      out.push({ name: de.name, path: full, isDir, size, mtime });
    }
    return sortEntries(out);
  }
  localMkdir(dir, name) { fs.mkdirSync(nodePath.join(dir, name)); return nodePath.join(dir, name); }
  localRename(from, to) { fs.renameSync(from, to); }
  localDelete(p) { fs.rmSync(p, { recursive: true, force: false }); }

  // ---------------- remote (sftp) ----------------
  _sftpFor(tabId) {
    return new Promise((resolve, reject) => {
      const existing = this._sftp.get(tabId);
      if (existing) return resolve(existing);
      const client = this.getClient(tabId);
      if (!client) return reject(new Error('Not connected to this host.'));
      client.sftp((err, sftp) => {
        if (err) return reject(new Error('SFTP unavailable: ' + err.message));
        this._sftp.set(tabId, sftp);
        sftp.on('close', () => this._sftp.delete(tabId));
        resolve(sftp);
      });
    });
  }

  async remoteHome(tabId) {
    const sftp = await this._sftpFor(tabId);
    return new Promise((res, rej) => sftp.realpath('.', (e, p) => (e ? rej(e) : res(p || '/'))));
  }

  async remoteList(tabId, dir) {
    const sftp = await this._sftpFor(tabId);
    const list = await new Promise((res, rej) => sftp.readdir(dir, (e, l) => (e ? rej(e) : res(l))));
    const out = list
      .filter((it) => it.filename !== '.' && it.filename !== '..')
      .map((it) => ({
        name: it.filename,
        path: posixJoin(dir, it.filename),
        isDir: it.attrs.isDirectory(),
        size: it.attrs.size,
        mtime: (it.attrs.mtime || 0) * 1000,
      }));
    return sortEntries(out);
  }

  async remoteMkdir(tabId, dir, name) {
    const sftp = await this._sftpFor(tabId);
    const p = posixJoin(dir, name);
    await new Promise((res, rej) => sftp.mkdir(p, (e) => (e ? rej(e) : res())));
    return p;
  }

  async remoteRename(tabId, from, to) {
    const sftp = await this._sftpFor(tabId);
    await new Promise((res, rej) => sftp.rename(from, to, (e) => (e ? rej(e) : res())));
  }

  async remoteDelete(tabId, p) {
    const sftp = await this._sftpFor(tabId);
    await this._rmR(sftp, p);
  }
  async _rmR(sftp, p) {
    const st = await new Promise((res, rej) => sftp.lstat(p, (e, s) => (e ? rej(e) : res(s))));
    if (st.isDirectory()) {
      const items = await new Promise((res, rej) => sftp.readdir(p, (e, l) => (e ? rej(e) : res(l))));
      for (const it of items) {
        if (it.filename === '.' || it.filename === '..') continue;
        await this._rmR(sftp, posixJoin(p, it.filename));
      }
      await new Promise((res, rej) => sftp.rmdir(p, (e) => (e ? rej(e) : res())));
    } else {
      await new Promise((res, rej) => sftp.unlink(p, (e) => (e ? rej(e) : res())));
    }
  }

  // ---------------- transfers ----------------
  async download(tabId, remotePath, localPath) {
    const sftp = await this._sftpFor(tabId);
    const id = ++this._xferId;
    const name = nodePath.posix.basename(remotePath);
    const total = await new Promise((res) => sftp.stat(remotePath, (e, s) => res(e ? 0 : s.size)));
    this.emit('fm:progress', { tabId, id, name, dir: 'down', transferred: 0, total });
    await new Promise((res, rej) => sftp.fastGet(remotePath, localPath, {
      step: (t, _c, tot) => this.emit('fm:progress', { tabId, id, name, dir: 'down', transferred: t, total: tot || total }),
    }, (e) => (e ? rej(e) : res())));
    this.emit('fm:progress', { tabId, id, name, dir: 'down', transferred: total, total, done: true });
  }

  async upload(tabId, localPath, remotePath) {
    const sftp = await this._sftpFor(tabId);
    const id = ++this._xferId;
    const name = nodePath.basename(localPath);
    let total = 0;
    try { total = fs.statSync(localPath).size; } catch { /* */ }
    this.emit('fm:progress', { tabId, id, name, dir: 'up', transferred: 0, total });
    await new Promise((res, rej) => sftp.fastPut(localPath, remotePath, {
      step: (t, _c, tot) => this.emit('fm:progress', { tabId, id, name, dir: 'up', transferred: t, total: tot || total }),
    }, (e) => (e ? rej(e) : res())));
    this.emit('fm:progress', { tabId, id, name, dir: 'up', transferred: total, total, done: true });
  }

  closeTab(tabId) {
    const sftp = this._sftp.get(tabId);
    if (sftp) { try { sftp.end(); } catch { /* */ } this._sftp.delete(tabId); }
  }
}

module.exports = { FileManager };
