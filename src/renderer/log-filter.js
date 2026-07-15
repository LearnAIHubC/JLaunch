'use strict';

(function exposeLogFilter() {
  function splitLogLines(log) {
    const text = String(log ?? '');
    if (!text) return { lines: [], trailingNewline: false };

    const trailingNewline = text.endsWith('\n');
    const lines = text.split('\n');
    if (trailingNewline) lines.pop();
    return { lines, trailingNewline };
  }

  function createResult(lines, matchedLines, trailingNewline, error = null) {
    const text = matchedLines.length
      ? `${matchedLines.join('\n')}${trailingNewline ? '\n' : ''}`
      : '';
    return { text, total: lines.length, matched: matchedLines.length, error };
  }

  function filterLogLines(log, query, options = {}) {
    const { regex = false, caseSensitive = false } = options;
    const { lines, trailingNewline } = splitLogLines(log);
    const value = String(query ?? '').trim();
    if (!value) return createResult(lines, lines, trailingNewline);

    if (regex) {
      try {
        const pattern = new RegExp(value, caseSensitive ? '' : 'i');
        return createResult(lines, lines.filter((line) => pattern.test(line)), trailingNewline);
      } catch (error) {
        return createResult(lines, lines, trailingNewline, `正则表达式无效：${error.message}`);
      }
    }

    const needle = caseSensitive ? value : value.toLocaleLowerCase();
    const matchedLines = lines.filter((line) => {
      const candidate = caseSensitive ? line : line.toLocaleLowerCase();
      return candidate.includes(needle);
    });
    return createResult(lines, matchedLines, trailingNewline);
  }

  const api = { filterLogLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.javaRunsLogFilter = api;
}());
