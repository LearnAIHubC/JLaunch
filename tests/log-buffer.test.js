'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { appendBoundedLog } = require('../src/renderer/log-buffer');

test('keeps only the configured number of newest log lines', () => {
  let log = appendBoundedLog('', 'one\ntwo\nthree\n', 3, '[trimmed]');
  assert.equal(log, 'one\ntwo\nthree\n');

  log = appendBoundedLog(log, 'four\n', 3, '[trimmed]');
  assert.equal(log, '[trimmed]\nthree\nfour\n');

  log = appendBoundedLog(log, 'five\nsix', 3, '[trimmed]');
  assert.equal(log, '[trimmed]\nfive\nsix');
});
