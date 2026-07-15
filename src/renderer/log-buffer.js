'use strict';

(function exposeLogBuffer() {
  function appendBoundedLog(current, addition, maxLines, notice) {
    const combined = `${current ?? ''}${addition ?? ''}`;
    const trailingNewline = combined.endsWith('\n');
    const lines = combined.split('\n');
    if (trailingNewline) lines.pop();
    if (lines.length <= maxLines) return combined;

    const keepCount = Math.max(0, maxLines - 1);
    const kept = keepCount > 0 ? lines.slice(-keepCount) : [];
    const trimmed = [notice, ...kept].join('\n');
    return trailingNewline ? `${trimmed}\n` : trimmed;
  }

  const api = { appendBoundedLog };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.javaRunsLogBuffer = api;
}());
