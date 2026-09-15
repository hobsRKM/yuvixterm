'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HostKeyVerifier } = require('../main/host-key-verifier');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hk-')); }

test('unknown -> trust -> ok; mismatch -> changed; pinned enforced', () => {
  const v = new HostKeyVerifier({ dir: tmp() });
  assert.equal(v.check('h:22', 'SHA256:AAA'), 'unknown');
  v.trust('h:22', 'SHA256:AAA');
  assert.equal(v.check('h:22', 'SHA256:AAA'), 'ok');
  assert.equal(v.check('h:22', 'SHA256:BBB'), 'changed');
  assert.equal(v.check('h:22', 'SHA256:CCC', 'SHA256:AAA'), 'changed'); // pinned overrides store
  assert.equal(v.check('h:22', 'SHA256:AAA', 'SHA256:AAA'), 'ok');
});

test('persists trust across instances, 0600', () => {
  const dir = tmp();
  new HostKeyVerifier({ dir }).trust('x:2222', 'SHA256:ZZZ');
  const v2 = new HostKeyVerifier({ dir });
  assert.equal(v2.check('x:2222', 'SHA256:ZZZ'), 'ok');
  const mode = fs.statSync(path.join(dir, 'knownhosts.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});
