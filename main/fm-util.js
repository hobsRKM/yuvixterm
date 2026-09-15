'use strict';

// POSIX (remote) path helpers + entry sorting/formatting. Pure — no I/O.

function posixJoin(base, name) {
  if (name === '..') return posixUp(base);
  if (name === '.' || name === '') return base || '/';
  const b = (base || '/').replace(/\/+$/, '');
  return (b === '/' ? '' : b) + '/' + name.replace(/^\/+/, '');
}

function posixUp(p) {
  if (!p || p === '/') return '/';
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

// Directories first, then case-insensitive name. Returns a new array.
function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

function humanSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}

module.exports = { posixJoin, posixUp, sortEntries, humanSize };
