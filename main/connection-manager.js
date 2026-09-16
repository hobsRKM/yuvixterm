'use strict';
const fs = require('node:fs');
const os = require('node:os');
const { Client } = require('ssh2');
const { buildConnectConfig } = require('./build-connect-config');
const { parseSample, computeMetrics } = require('./stats-collector');

const STATS_INTERVAL = 2;
// Long-lived remote loop emitting one delimited /proc block every 2s (spec sec.10).
const STATS_LOOP =
  "while true; do echo '<<<STATS'; cat /proc/stat 2>/dev/null; " +
  "echo '<<<MEM'; cat /proc/meminfo 2>/dev/null; " +
  "echo '<<<NET'; cat /proc/net/dev 2>/dev/null; " +
  "echo '<<<UP'; cat /proc/uptime 2>/dev/null; " +
  "echo '<<<LOAD'; cat /proc/loadavg 2>/dev/null; " +
  "echo '<<<DISK'; df -P / 2>/dev/null | tail -1; " +
  "echo 'STATS>>>'; sleep " + STATS_INTERVAL + "; done";

function friendlyError(err) {
  const m = (err && err.message) || String(err);
  if (/host ?key|verification failed|hostverifier/i.test(m)) {
    return 'Host key was rejected — connection aborted.';
  }
  if (/handshake|key exchange|kex|no matching/i.test(m)) {
    return `Handshake failed: ${m}. If this host needs a specific key-exchange order, set it under the session's Advanced -> KEX field.`;
  }
  if (/authentication/i.test(m)) {
    return `Authentication failed: check the username, password, or key for this host.`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timed out/i.test(m)) {
    return `Cannot reach host: ${m}.`;
  }
  return m;
}

/**
 * Owns one ssh2 Client per tab: an interactive shell channel plus a stats
 * exec loop. Emits term/status/stats/hostkey events to the renderer via emit().
 */
class ConnectionManager {
  constructor({ store, verifier, emit }) {
    this.store = store;
    this.verifier = verifier;
    this.emit = emit;
    this.conns = new Map();
  }

  open(tabId, session, secrets = {}) {
    this.close(tabId);
    const entry = {
      tabId, session, secrets: { ...secrets },
      client: null, shell: null, statsStream: null,
      statsBuf: '', prevSample: null, connected: false,
      pendingHostKey: null,
      cols: 80, rows: 24,
    };
    this.conns.set(tabId, entry);

    const authType = session.authType || 'password';
    if (authType === 'password' && entry.secrets.password == null) {
      this.emit('conn:status', { tabId, state: 'need-auth' });
      this.emit('conn:needPassword', { tabId, prompt: `Password for ${session.username}@${session.host}` });
      return;
    }
    this._connect(tabId);
  }

  answerPassword(tabId, password) {
    const entry = this.conns.get(tabId);
    if (!entry) return;
    entry.secrets.password = password;
    this._connect(tabId);
  }

  answerHostKey(tabId, accept) {
    const entry = this.conns.get(tabId);
    if (!entry || !entry.pendingHostKey) return;
    const p = entry.pendingHostKey;
    entry.pendingHostKey = null;
    if (!accept) {
      p.cb(false);
      this.emit('conn:status', { tabId, state: 'error', message: 'Host key rejected — connection aborted.' });
      return;
    }
    this.verifier.trust(p.hostPort, p.fingerprint);
    // If this session pinned a now-changed key, update the pin so it stops re-prompting.
    const sess = entry.session;
    if (sess && sess.id && sess.pinnedHostKey && sess.pinnedHostKey !== p.fingerprint) {
      try { this.store.save({ ...sess, pinnedHostKey: p.fingerprint }, {}); } catch { /* */ }
    }
    p.cb(true);
  }

  _connect(tabId) {
    const entry = this.conns.get(tabId);
    if (!entry) return;
    const { session } = entry;

    if (session.authType === 'key' && session.keyPath && entry.secrets.privateKey == null) {
      const keyPath = session.keyPath.startsWith('~')
        ? os.homedir() + session.keyPath.slice(1)
        : session.keyPath;
      try {
        const st = fs.statSync(keyPath);
        if (st.mode & 0o077) {
          this.emit('conn:status', { tabId, state: 'info',
            message: `Warning: key file ${keyPath} is group/other-readable; consider chmod 600.` });
        }
        entry.secrets.privateKey = fs.readFileSync(keyPath, 'utf8');
      } catch (e) {
        this.emit('conn:status', { tabId, state: 'error', message: `Cannot read key file: ${e.message}` });
        return;
      }
    }

    const cfg = buildConnectConfig(session, entry.secrets);
    cfg.hostVerifier = (hashHex, cb) => {
      const fp = 'SHA256:' + Buffer.from(String(hashHex), 'hex').toString('base64').replace(/=+$/, '');
      const hostPort = `${session.host}:${session.port || 22}`;
      const res = this.verifier.check(hostPort, fp, session.pinnedHostKey);
      if (res === 'ok') return cb(true);
      // 'unknown' (first time) or 'changed' -> ask the user; hold cb until they answer
      entry.pendingHostKey = { cb, hostPort, fingerprint: fp };
      this.emit('conn:hostkey', { tabId, status: res, fingerprint: fp, hostPort });
    };

    const client = new Client();
    entry.client = client;
    this.emit('conn:status', { tabId, state: 'connecting' });

    client.on('ready', () => {
      entry.connected = true;
      this.emit('conn:status', { tabId, state: 'connected' });
      client.shell({ term: 'xterm-256color', cols: entry.cols, rows: entry.rows }, (err, stream) => {
        if (err) { this.emit('conn:status', { tabId, state: 'error', message: err.message }); return; }
        entry.shell = stream;
        stream.on('data', (d) => this.emit('term:data', { tabId, chunk: d.toString('utf8') }));
        stream.stderr.on('data', (d) => this.emit('term:data', { tabId, chunk: d.toString('utf8') }));
        stream.on('close', () => this.emit('conn:status', { tabId, state: 'closed' }));
      });
      client.exec(STATS_LOOP, { pty: false }, (err, stream) => {
        if (err) return; // monitor is best-effort
        entry.statsStream = stream;
        stream.on('data', (d) => {
          entry.statsBuf += d.toString('utf8');
          if (entry.statsBuf.length > 65536) entry.statsBuf = entry.statsBuf.slice(-65536);
          this._drainStats(entry);
        });
      });
    });

    client.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
      finish(prompts.map(() => entry.secrets.password || ''));
    });
    client.on('error', (err) => {
      this.emit('conn:status', { tabId, state: 'error', message: friendlyError(err) });
    });
    client.on('close', () => {
      if (entry.connected) this.emit('conn:status', { tabId, state: 'closed' });
    });

    try { client.connect(cfg); }
    catch (e) { this.emit('conn:status', { tabId, state: 'error', message: friendlyError(e) }); }
  }

  _drainStats(entry) {
    let buf = entry.statsBuf;
    let end;
    while ((end = buf.indexOf('STATS>>>')) >= 0) {
      const start = buf.lastIndexOf('<<<STATS', end);
      const rest = end + 'STATS>>>'.length;
      if (start >= 0) {
        const sample = parseSample(buf.slice(start, rest));
        if (sample.ok) {
          const metrics = computeMetrics(entry.prevSample, sample, STATS_INTERVAL);
          entry.prevSample = sample;
          this.emit('stats:update', { tabId: entry.tabId, metrics });
        }
      }
      buf = buf.slice(rest);
    }
    entry.statsBuf = buf;
  }

  write(tabId, data) {
    const entry = this.conns.get(tabId);
    if (process.env.MSSH_DEBUG) console.log('[write ' + tabId + '] codes=' + JSON.stringify(Array.from(String(data)).map((c) => c.charCodeAt(0))) + ' shell=' + !!(entry && entry.shell));
    if (entry && entry.shell) entry.shell.write(data);
  }

  resize(tabId, cols, rows) {
    const entry = this.conns.get(tabId);
    if (!entry) return;
    entry.cols = cols; entry.rows = rows;
    if (entry.shell && entry.shell.setWindow) entry.shell.setWindow(rows, cols, 0, 0);
  }

  close(tabId) {
    const entry = this.conns.get(tabId);
    if (!entry) return;
    if (entry.pendingHostKey) { try { entry.pendingHostKey.cb(false); } catch { /* */ } entry.pendingHostKey = null; }
    try { entry.statsStream && entry.statsStream.close && entry.statsStream.close(); } catch { /* */ }
    try { entry.shell && entry.shell.end(); } catch { /* */ }
    try { entry.client && entry.client.end(); } catch { /* */ }
    this.conns.delete(tabId);
  }

  // The live ssh2 client for a tab, only once it's connected (for SFTP).
  getClient(tabId) {
    const entry = this.conns.get(tabId);
    return entry && entry.connected ? entry.client : null;
  }

  closeAll() { for (const id of [...this.conns.keys()]) this.close(id); }
}

module.exports = { ConnectionManager, STATS_LOOP };
