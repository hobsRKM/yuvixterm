'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionStore } = require('../main/session-store');

const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
};
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ss-')); }

test('save encrypts password, list strips secrets, getSecrets decrypts', () => {
  const s = new SessionStore({ dir: tmp(), safeStorage: fakeSafe });
  const saved = s.save({ name: 'de01', host: 'h', username: 'root', authType: 'password' }, { password: 'pw' });
  assert.ok(saved.id);
  const listed = s.list()[0];
  assert.equal(listed.passwordEnc, undefined);
  assert.equal(listed.password, undefined);
  assert.equal(listed.name, 'de01');
  assert.deepEqual(s.getSecrets(saved.id), { password: 'pw' });
});

test('persists across instances and delete removes', () => {
  const dir = tmp();
  const a = new SessionStore({ dir, safeStorage: fakeSafe });
  const saved = a.save({ name: 'x', host: 'h', username: 'u', authType: 'password' }, {});
  const b = new SessionStore({ dir, safeStorage: fakeSafe });
  assert.equal(b.list().length, 1);
  b.delete(saved.id);
  assert.equal(b.list().length, 0);
});

test('editing a session without new password preserves the stored one', () => {
  const s = new SessionStore({ dir: tmp(), safeStorage: fakeSafe });
  const saved = s.save({ name: 'x', host: 'h', username: 'u', authType: 'password' }, { password: 'secret' });
  s.save({ ...saved, name: 'renamed' }, {}); // no password in secrets
  assert.equal(s.list()[0].name, 'renamed');
  assert.deepEqual(s.getSecrets(saved.id), { password: 'secret' });
});

test('refuses to persist password when encryption unavailable', () => {
  const s = new SessionStore({ dir: tmp(), safeStorage: { isEncryptionAvailable: () => false } });
  assert.throws(() => s.save({ name: 'x', host: 'h', username: 'u', authType: 'password' }, { password: 'pw' }));
});

test('sessions.json written with mode 0600', () => {
  const dir = tmp();
  const s = new SessionStore({ dir, safeStorage: fakeSafe });
  s.save({ name: 'x', host: 'h', username: 'u', authType: 'password' }, {});
  const mode = fs.statSync(path.join(dir, 'sessions.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});
