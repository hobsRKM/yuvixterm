'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// secret field -> its encrypted counterpart on the stored record
const SECRET_FIELDS = ['password', 'passphrase'];

/**
 * CRUD over sessions.json. Passwords/passphrases are encrypted via the
 * injected safeStorage (macOS Keychain in production, a fake in tests) and
 * stored as base64 blobs; plaintext never touches disk. See spec sec.9.
 */
class SessionStore {
  constructor({ dir, safeStorage }) {
    this.file = path.join(dir, 'sessions.json');
    this.safe = safeStorage;
    this._sessions = this._read();
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
  }

  _write() {
    fs.writeFileSync(this.file, JSON.stringify(this._sessions, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  _encrypt(plain) {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error('Credential encryption unavailable on this system; refusing to store a secret in plaintext.');
    }
    return this.safe.encryptString(plain).toString('base64');
  }

  _strip(s) {
    const clone = { ...s };
    delete clone.password; delete clone.passphrase;
    delete clone.passwordEnc; delete clone.passphraseEnc;
    return clone;
  }

  list() { return this._sessions.map((s) => this._strip(s)); }

  get(id) {
    const s = this._sessions.find((x) => x.id === id);
    return s ? this._strip(s) : undefined;
  }

  save(session, secrets = {}) {
    const id = session.id || crypto.randomUUID();
    const existing = this._sessions.find((s) => s.id === id);
    const record = { ...(existing || {}), ...session, id };
    delete record.password; delete record.passphrase; // never keep plaintext

    for (const field of SECRET_FIELDS) {
      const encKey = field + 'Enc';
      if (secrets[field] != null) {
        record[encKey] = this._encrypt(secrets[field]);
      } else if (existing && existing[encKey] != null) {
        record[encKey] = existing[encKey]; // preserve on edit
      } else {
        delete record[encKey];
      }
    }

    this._sessions = existing
      ? this._sessions.map((s) => (s.id === id ? record : s))
      : [...this._sessions, record];
    this._write();
    return this._strip(record);
  }

  getSecrets(id) {
    const s = this._sessions.find((x) => x.id === id);
    const out = {};
    if (!s) return out;
    for (const field of SECRET_FIELDS) {
      const enc = s[field + 'Enc'];
      if (enc != null) out[field] = this.safe.decryptString(Buffer.from(enc, 'base64'));
    }
    return out;
  }

  delete(id) {
    this._sessions = this._sessions.filter((s) => s.id !== id);
    this._write();
  }
}

module.exports = { SessionStore };
