'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterLogLines } = require('../src/renderer/log-filter');

test('filters log lines by case-insensitive text by default', () => {
  const result = filterLogLines('INFO started\nERROR failed\ninfo stopped\n', 'info');

  assert.deepEqual(result, {
    text: 'INFO started\ninfo stopped\n', total: 3, matched: 2, error: null
  });
});

test('filters log lines using regular expressions', () => {
  const result = filterLogLines('HTTP 200\nHTTP 302\nHTTP 500\n', 'HTTP (302|500)', { regex: true });

  assert.deepEqual(result, {
    text: 'HTTP 302\nHTTP 500\n', total: 3, matched: 2, error: null
  });
});

test('keeps logs visible when a regular expression is invalid', () => {
  const result = filterLogLines('INFO started\n', '[', { regex: true });

  assert.equal(result.text, 'INFO started\n');
  assert.equal(result.total, 1);
  assert.equal(result.matched, 1);
  assert.match(result.error, /^正则表达式无效：/);
});
