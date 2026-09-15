'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileManager } = require('../main/file-manager');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fm-'));
const fm = new FileManager({ getClient: () => null });

test('localList returns entries with dirs first and file sizes', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'b.txt'), 'hi');
  fs.mkdirSync(path.join(d, 'adir'));
  fs.writeFileSync(path.join(d, 'A.txt'), 'x');
  const list = fm.localList(d);
  assert.deepEqual(list.map((e) => e.name), ['adir', 'A.txt', 'b.txt']);
  assert.equal(list.find((e) => e.name === 'adir').isDir, true);
  const f = list.find((e) => e.name === 'b.txt');
  assert.equal(f.isDir, false);
  assert.equal(f.size, 2);
});

test('localMkdir / localRename / localDelete (recursive)', () => {
  const d = tmp();
  const made = fm.localMkdir(d, 'sub');
  assert.ok(fs.existsSync(made));
  fm.localRename(made, path.join(d, 'renamed'));
  assert.ok(fs.existsSync(path.join(d, 'renamed')) && !fs.existsSync(made));
  fs.writeFileSync(path.join(d, 'renamed', 'inner.txt'), 'x');
  fm.localDelete(path.join(d, 'renamed'));
  assert.ok(!fs.existsSync(path.join(d, 'renamed')));
});

test('remote ops reject cleanly when the tab is not connected', async () => {
  await assert.rejects(() => fm.remoteList('t1', '/'), /Not connected/);
  await assert.rejects(() => fm.remoteHome('t1'), /Not connected/);
});
