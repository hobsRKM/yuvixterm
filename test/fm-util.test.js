'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { posixJoin, posixUp, sortEntries, humanSize } = require('../main/fm-util');

test('posixJoin builds child paths', () => {
  assert.equal(posixJoin('/home/user', 'file'), '/home/user/file');
  assert.equal(posixJoin('/home/user/', 'file'), '/home/user/file');
  assert.equal(posixJoin('/', 'x'), '/x');
  assert.equal(posixJoin('/a', '.'), '/a');
  assert.equal(posixJoin('/a/b', '..'), '/a');
});

test('posixUp returns the parent directory', () => {
  assert.equal(posixUp('/a/b/c'), '/a/b');
  assert.equal(posixUp('/a/b/c/'), '/a/b');
  assert.equal(posixUp('/a'), '/');
  assert.equal(posixUp('/'), '/');
  assert.equal(posixUp(''), '/');
});

test('sortEntries puts directories first, then case-insensitive name', () => {
  const input = [
    { name: 'Zebra.txt', isDir: false },
    { name: 'apple', isDir: true },
    { name: 'beta.md', isDir: false },
    { name: 'Alpha', isDir: true },
  ];
  const names = sortEntries(input).map((e) => e.name);
  assert.deepEqual(names, ['Alpha', 'apple', 'beta.md', 'Zebra.txt']);
});

test('humanSize formats bytes', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(1536), '1.5 KB');
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(humanSize(null), '');
});
