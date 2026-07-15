'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const ATTACH_TIMEOUT_MS = 15_000;
const ATTACH_RETRY_MS = 350;
const CLASS_NAME = /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*$/;

class DebugManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? Date.now;
    this.attachTimeoutMs = options.attachTimeoutMs ?? ATTACH_TIMEOUT_MS;
    this.retryMs = options.retryMs ?? ATTACH_RETRY_MS;
    this.sessions = new Map();
    this.breakpoints = new Map();
  }

  getState(projectId) {
    const session = this.sessions.get(projectId);
    return session ? {
      projectId,
      status: session.status,
      message: session.message,
      paused: session.paused
    } : { projectId, status: 'disconnected', message: '', paused: null };
  }

  listStates() {
    return [...this.sessions.keys()].map((projectId) => this.getState(projectId));
  }

  listBreakpoints(projectId) {
    return [...(this.breakpoints.get(projectId)?.values() ?? [])];
  }

  async start(project) {
    await this.stop(project.id);
    const jdb = path.join(project.jdkHome, 'bin', this.platform === 'win32' ? 'jdb.exe' : 'jdb');
    if (!isFile(jdb)) throw new Error('所选 JDK 不包含 jdb，无法启动断点调试');
    const session = {
      projectId: project.id,
      projectName: project.name,
      jdb,
      debugPort: project.debugPort,
      status: 'connecting',
      message: `正在连接 localhost:${project.debugPort}`,
      paused: null,
      child: null,
      retryTimer: null,
      stopPromise: null,
      stopRequested: false,
      deadline: this.now() + this.attachTimeoutMs,
      lineBuffer: '',
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      settled: false,
      resolve: null,
      reject: null
    };
    this.sessions.set(project.id, session);
    this.emitState(project.id);
    const connected = new Promise((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
    });
    this.launch(session);
    return connected;
  }

  launch(session) {
    if (session.stopRequested || this.sessions.get(session.projectId) !== session) return;
    session.lineBuffer = '';
    session.stdoutDecoder = new StringDecoder('utf8');
    session.stderrDecoder = new StringDecoder('utf8');
    let child;
    try {
      child = this.spawnProcess(session.jdb, ['-attach', `127.0.0.1:${session.debugPort}`], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      this.retryOrFail(session, error.message);
      return;
    }
    session.child = child;
    child.stdout?.on('data', (chunk) => this.consume(session, session.stdoutDecoder.write(chunk)));
    child.stderr?.on('data', (chunk) => this.consume(session, session.stderrDecoder.write(chunk)));
    child.stdout?.once('end', () => this.consume(session, session.stdoutDecoder.end()));
    child.stderr?.once('end', () => this.consume(session, session.stderrDecoder.end()));
    child.once('error', (error) => {
      if (session.child === child && session.status === 'connecting') session.message = error.message;
    });
    child.once('close', () => {
      if (session.child !== child) return;
      session.child = null;
      if (session.stopRequested) return;
      if (session.status === 'connecting') {
        this.retryOrFail(session, session.message || 'JDB 无法连接目标 JVM');
      } else {
        session.status = 'disconnected';
        session.message = 'Debug 会话已结束';
        session.paused = null;
        this.emitState(session.projectId);
      }
    });
  }

  retryOrFail(session, message) {
    if (session.stopRequested || this.sessions.get(session.projectId) !== session) return;
    if (this.now() < session.deadline) {
      session.retryTimer = setTimeout(() => this.launch(session), this.retryMs);
      return;
    }
    session.status = 'error';
    session.message = `连接 Debug 端口失败：${message}`;
    this.emitState(session.projectId);
    this.rejectConnection(session, new Error(session.message));
  }

  consume(session, text) {
    if (!text || this.sessions.get(session.projectId) !== session) return;
    session.lineBuffer += String(text).replace(/\r/g, '');
    const lines = session.lineBuffer.split('\n');
    session.lineBuffer = lines.pop();
    for (const line of lines) this.handleLine(session, line.trim());
  }

  handleLine(session, line) {
    if (!line) return;
    if (line.includes('Initializing jdb')) {
      session.status = 'attached';
      session.message = `已连接 localhost:${session.debugPort}`;
      this.emitState(session.projectId);
      this.resolveConnection(session);
      this.reapplyBreakpoints(session);
      return;
    }

    const confirmed = line.match(/(?:Deferring breakpoint|Set (?:deferred )?breakpoint) ([\w.$]+):(\d+)/);
    if (confirmed) {
      this.markBreakpoint(session.projectId, confirmed[1], Number(confirmed[2]), 'verified');
      return;
    }
    const rejected = line.match(/(?:Unable to set|No code at line|Invalid line number).*?([\w.$]+):(\d+)/i);
    if (rejected) {
      this.markBreakpoint(session.projectId, rejected[1], Number(rejected[2]), 'error', line);
      return;
    }

    const hit = line.match(/Breakpoint hit: "thread=([^"]+)", ([\w.$]+)\.[^(]*\([^)]*\), line=(\d+)/);
    if (!hit) return;
    const className = hit[2];
    const lineNumber = Number(hit[3]);
    const breakpoint = this.findBreakpoint(session.projectId, className, lineNumber);
    session.status = 'paused';
    session.message = `断点命中 · ${className}:${lineNumber}`;
    session.paused = {
      threadName: hit[1],
      className,
      line: lineNumber,
      relativePath: breakpoint?.relativePath ?? null
    };
    this.emitState(session.projectId);
  }

  setBreakpoint(projectId, input) {
    const breakpoint = normalizeBreakpoint(input);
    const map = this.breakpointMap(projectId);
    map.set(breakpointKey(breakpoint.className, breakpoint.line), breakpoint);
    const session = this.sessions.get(projectId);
    if (session && ['attached', 'paused'].includes(session.status)) {
      this.write(session, `stop at ${breakpoint.className}:${breakpoint.line}`);
    }
    this.emitBreakpoints(projectId);
    return breakpoint;
  }

  clearBreakpoint(projectId, className, line) {
    if (!CLASS_NAME.test(className) || !validLine(line)) throw new Error('断点位置无效');
    const map = this.breakpointMap(projectId);
    const removed = map.get(breakpointKey(className, line));
    if (!removed) return false;
    map.delete(breakpointKey(className, line));
    const session = this.sessions.get(projectId);
    if (session && ['attached', 'paused'].includes(session.status)) {
      this.write(session, `clear ${className}:${line}`);
    }
    this.emitBreakpoints(projectId);
    return true;
  }

  resume(projectId) {
    const session = this.requireAttached(projectId);
    if (session.status !== 'paused') return this.getState(projectId);
    this.write(session, 'cont');
    session.status = 'attached';
    session.message = `已连接 localhost:${session.debugPort}`;
    session.paused = null;
    this.emitState(projectId);
    return this.getState(projectId);
  }

  stop(projectId) {
    const session = this.sessions.get(projectId);
    if (!session) return Promise.resolve();
    if (!session.stopPromise) session.stopPromise = this.finishStop(session);
    return session.stopPromise;
  }

  async finishStop(session) {
    const projectId = session.projectId;
    session.stopRequested = true;
    if (session.retryTimer) clearTimeout(session.retryTimer);
    this.rejectConnection(session, new Error('Debug 会话已取消'));
    const child = session.child;
    if (child) {
      const input = child.stdin;
      if (input && !input.destroyed && !input.writableEnded) {
        input.once('error', () => {});
        try { input.end('exit\n'); } catch { /* already closed */ }
      }
      const closed = await waitForClose(child, 800);
      if (!closed) {
        try { child.kill('SIGKILL'); } catch { /* already closed */ }
      }
    }
    if (this.sessions.get(projectId) === session) this.sessions.delete(projectId);
    this.emit('state', { projectId, status: 'disconnected', message: '', paused: null });
  }

  async stopAll() {
    await Promise.allSettled([...this.sessions.keys()].map((projectId) => this.stop(projectId)));
  }

  killImmediately() {
    for (const session of this.sessions.values()) {
      session.stopRequested = true;
      if (session.retryTimer) clearTimeout(session.retryTimer);
      try { session.child?.kill('SIGKILL'); } catch { /* already closed */ }
    }
    this.sessions.clear();
  }

  reapplyBreakpoints(session) {
    for (const breakpoint of this.listBreakpoints(session.projectId)) {
      breakpoint.status = 'pending';
      breakpoint.message = '';
      this.write(session, `stop at ${breakpoint.className}:${breakpoint.line}`);
    }
    this.emitBreakpoints(session.projectId);
  }

  markBreakpoint(projectId, className, line, status, message = '') {
    const breakpoint = this.breakpoints.get(projectId)?.get(breakpointKey(className, line));
    if (!breakpoint) return;
    breakpoint.status = status;
    breakpoint.message = message;
    this.emitBreakpoints(projectId);
  }

  findBreakpoint(projectId, className, line) {
    return this.breakpoints.get(projectId)?.get(breakpointKey(className, line)) ?? null;
  }

  breakpointMap(projectId) {
    if (!this.breakpoints.has(projectId)) this.breakpoints.set(projectId, new Map());
    return this.breakpoints.get(projectId);
  }

  requireAttached(projectId) {
    const session = this.sessions.get(projectId);
    if (!session || !['attached', 'paused'].includes(session.status) || !session.child) {
      throw new Error('Debug 调试器尚未连接');
    }
    return session;
  }

  write(session, command) {
    if (!session.child?.stdin?.writable) throw new Error('Debug 调试器连接已断开');
    session.child.stdin.write(`${command}\n`);
  }

  resolveConnection(session) {
    if (session.settled) return;
    session.settled = true;
    session.resolve(this.getState(session.projectId));
  }

  rejectConnection(session, error) {
    if (session.settled) return;
    session.settled = true;
    session.reject(error);
  }

  emitState(projectId) {
    this.emit('state', this.getState(projectId));
  }

  emitBreakpoints(projectId) {
    this.emit('breakpoints', { projectId, breakpoints: this.listBreakpoints(projectId) });
  }
}

function normalizeBreakpoint(input) {
  if (!input || !CLASS_NAME.test(input.className) || !validLine(input.line)) {
    throw new Error('断点位置无效');
  }
  const relativePath = String(input.relativePath ?? '');
  if (!relativePath || relativePath.length > 4096) throw new Error('断点源码路径无效');
  return {
    relativePath,
    className: input.className,
    line: Number(input.line),
    status: 'pending',
    message: ''
  };
}

function breakpointKey(className, line) {
  return `${className}:${line}`;
}

function validLine(value) {
  const line = Number(value);
  return Number.isInteger(line) && line >= 1 && line <= 1_000_000;
}

function isFile(value) {
  try { return fs.statSync(value).isFile(); } catch { return false; }
}

function waitForClose(child, milliseconds) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once('close', () => finish(true));
  });
}

module.exports = { DebugManager, normalizeBreakpoint };
