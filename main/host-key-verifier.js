'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Trust-on-first-use host-key store with optional per-session pinning.
 * fingerprint strings look like "SHA256:...". See spec sec.11.
 */
class HostKeyVerifier {
  constructor({ dir }) {
    this.file = path.join(dir, 'knownhosts.json');
    this._map = this._read();
  }

  _read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { return {}; }
  }

  _write() {
    fs.writeFileSync(this.file, JSON.stringify(this._map, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  /** @returns {'ok'|'unknown'|'changed'} */
  check(hostPort, fingerprint, pinned) {
    if (pinned) return pinned === fingerprint ? 'ok' : 'changed';
    const known = this._map[hostPort];
    if (!known) return 'unknown';
    return known === fingerprint ? 'ok' : 'changed';
  }

  trust(hostPort, fingerprint) {
    this._map[hostPort] = fingerprint;
    this._write();
  }
}

module.exports = { HostKeyVerifier };
