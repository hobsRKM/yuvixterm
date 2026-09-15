'use strict';

/**
 * Map a saved session (+ decrypted secrets) to an ssh2 ConnectConfig.
 * Pure function — no I/O. See spec sec.11.
 *
 * @param {object} session  {host, port?, username, authType, algorithms?, keepaliveInterval?}
 * @param {object} secrets  {password?, passphrase?, privateKey?}
 */
function buildConnectConfig(session, secrets = {}) {
  const cfg = {
    host: session.host,
    port: session.port || 22,
    username: session.username,
    readyTimeout: 20000,
    keepaliveInterval: session.keepaliveInterval ?? 15000,
    tryKeyboard: true,
    hostHash: 'sha256',
  };

  if (session.authType === 'key') {
    if (secrets.privateKey != null) cfg.privateKey = secrets.privateKey;
    if (secrets.passphrase != null) cfg.passphrase = secrets.passphrase;
  } else if (session.authType === 'agent') {
    cfg.agent = process.env.SSH_AUTH_SOCK;
  } else {
    // password (default)
    if (secrets.password != null) cfg.password = secrets.password;
  }

  if (session.algorithms) cfg.algorithms = session.algorithms;
  return cfg;
}

module.exports = { buildConnectConfig };
