'use strict';

/**
 * Parse the delimited /proc block emitted by the remote stats loop (spec sec.10)
 * and turn two consecutive samples into display metrics. Pure — no I/O.
 */

function between(raw, startMarker, endMarker) {
  const i = raw.indexOf(startMarker);
  if (i < 0) return null;
  const from = i + startMarker.length;
  const j = raw.indexOf(endMarker, from);
  if (j < 0) return null;
  return raw.slice(from, j);
}

function matchInt(s, re) {
  const m = s.match(re);
  return m ? parseInt(m[1], 10) : null;
}

/** @returns {{ok:true, cpu, memTotal, memAvail, netRx, netTx, uptime, load1, load5, load15, diskPct} | {ok:false}} */
function parseSample(raw) {
  if (typeof raw !== 'string' || raw.indexOf('<<<STATS') < 0 || raw.indexOf('STATS>>>') < 0) {
    return { ok: false };
  }
  const statSec = between(raw, '<<<STATS', '<<<MEM');
  const memSec = between(raw, '<<<MEM', '<<<NET');
  const netSec = between(raw, '<<<NET', '<<<UP');
  const upSec = between(raw, '<<<UP', '<<<LOAD');
  const loadSec = between(raw, '<<<LOAD', '<<<DISK');
  const diskSec = between(raw, '<<<DISK', 'STATS>>>');
  if ([statSec, memSec, netSec, upSec, loadSec, diskSec].some((s) => s == null)) {
    return { ok: false };
  }

  // CPU aggregate line: "cpu  user nice system idle iowait irq softirq ..."
  const cpuLine = statSec.split('\n').map((l) => l.trim()).find((l) => /^cpu\s/.test(l));
  if (!cpuLine) return { ok: false };
  const cpuNums = cpuLine.split(/\s+/).slice(1).map(Number);
  if (cpuNums.length < 5 || cpuNums.some((n) => Number.isNaN(n))) return { ok: false };
  const total = cpuNums.reduce((a, b) => a + b, 0);
  const idle = (cpuNums[3] || 0) + (cpuNums[4] || 0); // idle + iowait

  const memTotal = matchInt(memSec, /MemTotal:\s+(\d+)/);
  const memAvail = matchInt(memSec, /MemAvailable:\s+(\d+)/);
  if (memTotal == null) return { ok: false };

  // Network: rx=col0, tx=col8; sum non-loopback interfaces
  let netRx = 0, netTx = 0;
  for (const line of netSec.split('\n')) {
    const m = line.match(/^\s*([\w.-]+):\s*(.+)$/);
    if (!m || m[1] === 'lo') continue;
    const nums = m[2].trim().split(/\s+/).map(Number);
    if (nums.length >= 9 && !Number.isNaN(nums[0]) && !Number.isNaN(nums[8])) {
      netRx += nums[0]; netTx += nums[8];
    }
  }

  const uptime = parseFloat(upSec.trim().split(/\s+/)[0]);
  const loadParts = loadSec.trim().split(/\s+/).map(Number);
  const diskMatch = diskSec.match(/(\d+)%/);

  return {
    ok: true,
    cpu: { total, idle },
    memTotal,
    memAvail: memAvail == null ? memTotal : memAvail,
    netRx, netTx,
    uptime: Number.isNaN(uptime) ? 0 : uptime,
    load1: loadParts[0] ?? 0,
    load5: loadParts[1] ?? 0,
    load15: loadParts[2] ?? 0,
    diskPct: diskMatch ? parseInt(diskMatch[1], 10) : null,
  };
}

function rate(prev, cur, key, interval) {
  if (!prev || !prev.ok) return 0;
  const d = cur[key] - prev[key];
  return d > 0 ? Math.round(d / interval) : 0; // guard counter resets
}

/** Combine previous + current sample into display metrics. */
function computeMetrics(prev, cur, intervalSec) {
  const interval = intervalSec > 0 ? intervalSec : 1;
  if (!cur || !cur.ok) {
    return { cpuPct: 0, memUsed: null, memTotal: null, memAvail: null,
      diskPct: null, netRxRate: 0, netTxRate: 0, uptime: null, load: null };
  }
  let cpuPct = 0;
  if (prev && prev.ok) {
    const dTotal = cur.cpu.total - prev.cpu.total;
    const dIdle = cur.cpu.idle - prev.cpu.idle;
    if (dTotal > 0) {
      cpuPct = Math.max(0, Math.min(100, (100 * (dTotal - dIdle)) / dTotal));
      cpuPct = Math.round(cpuPct * 100) / 100;
    }
  }
  return {
    cpuPct,
    memUsed: cur.memTotal - cur.memAvail,
    memTotal: cur.memTotal,
    memAvail: cur.memAvail,
    diskPct: cur.diskPct,
    netRxRate: rate(prev, cur, 'netRx', interval),
    netTxRate: rate(prev, cur, 'netTx', interval),
    uptime: cur.uptime,
    load: { one: cur.load1, five: cur.load5, fifteen: cur.load15 },
  };
}

module.exports = { parseSample, computeMetrics };
