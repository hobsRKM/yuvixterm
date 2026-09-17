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

// Pseudo/virtual filesystems we never want to show as "disks".
const PSEUDO_FS = new Set([
  'tmpfs', 'devtmpfs', 'devfs', 'udev', 'overlay', 'overlayfs', 'aufs', 'none',
  'ramfs', 'squashfs', 'mqueue', 'cgroup', 'cgroup2', 'sysfs', 'proc', 'procfs',
  'debugfs', 'tracefs', 'securityfs', 'pstore', 'efivarfs', 'configfs', 'bpf',
  'hugetlbfs', 'autofs', 'fusectl', 'nsfs', 'binfmt_misc', 'shm',
]);
const PSEUDO_MOUNT = /^\/(dev|sys|proc|run|snap|boot\/efi)(\/|$)/;

// Parse `df -P` output into one entry per real filesystem.
function parseDisks(diskSec) {
  const disks = [];
  for (const line of diskSec.split('\n')) {
    const t = line.trim();
    if (!t || /^Filesystem\b/i.test(t)) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 6) continue;
    const fs = parts[0];
    const mount = parts.slice(5).join(' ');
    if (PSEUDO_FS.has(fs) || /^\/dev\/loop\d/.test(fs) || PSEUDO_MOUNT.test(mount)) continue;
    const sizeKb = parseInt(parts[1], 10);
    const usedKb = parseInt(parts[2], 10);
    const availKb = parseInt(parts[3], 10);
    const pct = parseInt(parts[4], 10);
    if ([sizeKb, usedKb, availKb, pct].some((n) => Number.isNaN(n))) continue;
    if (sizeKb <= 0) continue;
    disks.push({ fs, mount, sizeKb, usedKb, availKb, pct });
  }
  // Root first, then largest filesystems first.
  disks.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : b.sizeKb - a.sizeKb));
  return disks;
}

/** @returns {{ok:true, cpu, cores, memTotal, memAvail, netRx, netTx, uptime, load1, load5, load15, diskPct} | {ok:false}} */
function parseSample(raw) {
  if (typeof raw !== 'string' || raw.indexOf('<<<STATS') < 0 || raw.indexOf('STATS>>>') < 0) {
    return { ok: false };
  }
  raw = raw.replace(/\r\n?/g, '\n'); // tolerate CRLF (odd remote shells, Windows checkouts of the fixtures)
  const statSec = between(raw, '<<<STATS', '<<<MEM');
  const memSec = between(raw, '<<<MEM', '<<<NET');
  const netSec = between(raw, '<<<NET', '<<<UP');
  const upSec = between(raw, '<<<UP', '<<<LOAD');
  const loadSec = between(raw, '<<<LOAD', '<<<DISK');
  const diskSec = between(raw, '<<<DISK', 'STATS>>>');
  if ([statSec, memSec, netSec, upSec, loadSec, diskSec].some((s) => s == null)) {
    return { ok: false };
  }

  // CPU: the aggregate "cpu  user nice system idle iowait irq softirq ..." line,
  // plus one "cpuN ..." line per core (same columns).
  const cpuCounters = (nums) => ({ total: nums.reduce((a, b) => a + b, 0), idle: (nums[3] || 0) + (nums[4] || 0) }); // idle + iowait
  const statLines = statSec.split('\n').map((l) => l.trim());
  const cpuLine = statLines.find((l) => /^cpu\s/.test(l));
  if (!cpuLine) return { ok: false };
  const cpuNums = cpuLine.split(/\s+/).slice(1).map(Number);
  if (cpuNums.length < 5 || cpuNums.some((n) => Number.isNaN(n))) return { ok: false };
  const { total, idle } = cpuCounters(cpuNums);
  const cores = [];
  for (const l of statLines) {
    const m = l.match(/^cpu(\d+)\s+(.*)$/);
    if (!m) continue;
    const nums = m[2].split(/\s+/).map(Number);
    if (nums.length >= 5 && !nums.some((n) => Number.isNaN(n))) cores[Number(m[1])] = cpuCounters(nums);
  }

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
  const disks = parseDisks(diskSec);
  const rootDisk = disks.find((d) => d.mount === '/') || disks[0] || null;

  return {
    ok: true,
    cpu: { total, idle },
    cores: cores.filter(Boolean),
    memTotal,
    memAvail: memAvail == null ? memTotal : memAvail,
    netRx, netTx,
    uptime: Number.isNaN(uptime) ? 0 : uptime,
    load1: loadParts[0] ?? 0,
    load5: loadParts[1] ?? 0,
    load15: loadParts[2] ?? 0,
    diskPct: rootDisk ? rootDisk.pct : null,
    disks,
  };
}

function rate(prev, cur, key, interval) {
  if (!prev || !prev.ok) return 0;
  const d = cur[key] - prev[key];
  return d > 0 ? Math.round(d / interval) : 0; // guard counter resets
}

// Busy % between two {total, idle} counter snapshots (0 until counters advance).
function busyPct(prev, cur) {
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0) return 0;
  const pct = Math.max(0, Math.min(100, (100 * (dTotal - dIdle)) / dTotal));
  return Math.round(pct * 100) / 100;
}

/** Combine previous + current sample into display metrics. */
function computeMetrics(prev, cur, intervalSec) {
  const interval = intervalSec > 0 ? intervalSec : 1;
  if (!cur || !cur.ok) {
    return { cpuPct: 0, corePct: [], memUsed: null, memTotal: null, memAvail: null,
      diskPct: null, disks: [], netRxRate: 0, netTxRate: 0, uptime: null, load: null };
  }
  let cpuPct = 0, corePct = [];
  if (prev && prev.ok) {
    cpuPct = busyPct(prev.cpu, cur.cpu);
    // Per-core needs the same core set in both samples (a hot-plugged CPU just skips one tick).
    const pc = prev.cores || [], cc = cur.cores || [];
    if (cc.length && cc.length === pc.length) corePct = cc.map((c, i) => busyPct(pc[i], c));
  }
  return {
    cpuPct,
    corePct,
    memUsed: cur.memTotal - cur.memAvail,
    memTotal: cur.memTotal,
    memAvail: cur.memAvail,
    diskPct: cur.diskPct,
    disks: cur.disks || [],
    netRxRate: rate(prev, cur, 'netRx', interval),
    netTxRate: rate(prev, cur, 'netTx', interval),
    uptime: cur.uptime,
    load: { one: cur.load1, five: cur.load5, fifteen: cur.load15 },
  };
}

module.exports = { parseSample, computeMetrics };
