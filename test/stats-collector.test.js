'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseSample, computeMetrics } = require('../main/stats-collector');
const read = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('parseSample extracts fields from a well-formed block', () => {
  const s = parseSample(read('proc-a.txt'));
  assert.equal(s.ok, true);
  assert.equal(s.memTotal, 8171400);
  assert.equal(s.memAvail, 5000000);
  assert.equal(s.cpu.total, 9750);   // 1000+0+500+8000+200+0+50
  assert.equal(s.cpu.idle, 8200);    // idle 8000 + iowait 200
  assert.equal(s.netRx, 1000000);    // eth0 only (lo excluded)
  assert.equal(s.netTx, 200000);
  assert.equal(s.uptime, 123456.78);
  assert.equal(s.load1, 0.15);
  assert.equal(s.diskPct, 44);
});

test('computeMetrics derives cpu% and net rate from two samples', () => {
  const a = parseSample(read('proc-a.txt'));
  const b = parseSample(read('proc-b.txt'));
  const m = computeMetrics(a, b, 2);
  // dTotal=880, dIdle=720 -> 100*(880-720)/880 = 18.18%
  assert.ok(Math.abs(m.cpuPct - 18.18) < 0.1, `cpuPct=${m.cpuPct}`);
  assert.equal(m.netRxRate, 100000); // (1200000-1000000)/2
  assert.equal(m.netTxRate, 30000);  // (260000-200000)/2
  assert.equal(m.diskPct, 44);
  assert.equal(m.memTotal, 8171400);
  assert.equal(m.memUsed, 8171400 - 4900000);
  assert.ok(m.memUsed <= m.memTotal);
  assert.deepEqual(m.load, { one: 0.20, five: 0.12, fifteen: 0.06 });
});

test('computeMetrics guards non-positive cpu delta and counter resets', () => {
  const a = parseSample(read('proc-b.txt'));
  const b = parseSample(read('proc-a.txt')); // counters went "backwards"
  const m = computeMetrics(a, b, 2);
  assert.equal(m.cpuPct, 0);
  assert.equal(m.netRxRate, 0);
});

test('malformed block -> ok:false, no throw', () => {
  assert.equal(parseSample('garbage').ok, false);
  assert.equal(parseSample('<<<STATS\ncpu 1 2 3\n').ok, false); // no closing marker
});
