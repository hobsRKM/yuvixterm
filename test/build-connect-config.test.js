'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildConnectConfig } = require('../main/build-connect-config');

test('password auth maps to ssh2 config', () => {
  const c = buildConnectConfig(
    { host: '1.2.3.4', username: 'root', authType: 'password' },
    { password: 'pw' });
  assert.equal(c.host, '1.2.3.4');
  assert.equal(c.port, 22);
  assert.equal(c.username, 'root');
  assert.equal(c.password, 'pw');
  assert.equal(c.tryKeyboard, true);
  assert.equal(c.hostHash, 'sha256');
});

test('key auth passes privateKey + passphrase, no password', () => {
  const c = buildConnectConfig(
    { host: 'h', username: 'u', authType: 'key' },
    { privateKey: 'KEYDATA', passphrase: 'pp' });
  assert.equal(c.privateKey, 'KEYDATA');
  assert.equal(c.passphrase, 'pp');
  assert.equal(c.password, undefined);
});

test('agent auth uses SSH_AUTH_SOCK, no password/key', () => {
  process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
  const c = buildConnectConfig({ host: 'h', username: 'u', authType: 'agent' }, {});
  assert.equal(c.agent, '/tmp/agent.sock');
  assert.equal(c.password, undefined);
  assert.equal(c.privateKey, undefined);
});

test('custom KEX ordering passes through', () => {
  const kex = ['ecdh-sha2-nistp256', 'curve25519-sha256',
    'ntru-curve25519', 'mlkem-curve25519', 'mlkem-nist'];
  const c = buildConnectConfig(
    { host: '203.0.113.29', username: 'root', authType: 'password',
      algorithms: { kex } }, { password: 'x' });
  assert.deepEqual(c.algorithms.kex, kex);
});

test('custom port + keepalive respected', () => {
  const c = buildConnectConfig(
    { host: 'h', port: 2222, username: 'u', authType: 'password',
      keepaliveInterval: 15000 }, { password: 'x' });
  assert.equal(c.port, 2222);
  assert.equal(c.keepaliveInterval, 15000);
});

test('keepalive defaults to 15000 when unset', () => {
  const c = buildConnectConfig({ host: 'h', username: 'u', authType: 'password' }, {});
  assert.equal(c.keepaliveInterval, 15000);
});
