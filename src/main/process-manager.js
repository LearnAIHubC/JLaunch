'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { buildLaunchSpec } = require('./launch');
const { stripAnsi } = require('./toolchain');

const ACTIVE_STATES = new Set(['starting', 'running', 'stopping']);

class ProcessManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.prepareProject = options.prepareProject ?? (async (project) => project);
    this.processes = new Map();
    this.sequenceGeneration = 0;
  }

  listStates() {
    return [...this.processes.entries()].map(([projectId, managed]) => ({
      projectId,
      status: managed.status,
      pid: ACTIVE_STATES.has(managed.status) ? managed.child?.pid ?? null : null,
      startedAt: managed.startedAt ?? null,
      exitCode: managed.exitCode ?? null,
      runMode: managed.project.debugEnabled ? 'debug' : 'run'
    }));
  }

  getState(projectId) {
    const managed = this.processes.get(projectId);
    return managed ? {
      projectId,
      status: managed.status,
      pid: ACTIVE_STATES.has(managed.status) ? managed.child?.pid ?? null : null,
      startedAt: managed.startedAt ?? null,
      exitCode: managed.exitCode ?? null,
      runMode: managed.project.debugEnabled ? 'debug' : 'run'
    } : { projectId, status: 'stopped', pid: null, startedAt: null, exitCode: null, runMode: null };
  }

  async start(project) {
    const current = this.processes.get(project.id);
    if (current && ACTIVE_STATES.has(current.status)) {
      throw new Error(`${project.name} 已在运行`);
    }
    if (project.debugEnabled) {
      const conflict = [...this.processes.values()].find((managed) =>
        ACTIVE_STATES.has(managed.status) && managed.project.debugEnabled
        && managed.project.debugPort === project.debugPort);
      if (conflict) {
        throw new Error(`Debug 端口 ${project.debugPort} 已被 ${conflict.project.name} 使用`);
      }
    }

    const managed = {
      project,
      child: null,
      status: 'starting',
      startedAt: new Date().toISOString(),
      exitCode: null,
      stopRequested: false,
      closed: null,
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8')
    };
    this.processes.set(project.id, managed);
    this.emitState(project.id);
    this.emitLog(project.id, 'system', project.type === 'spring-boot-maven'
      ? `正在解析 classpath 并准备直接启动 ${project.name}…`
      : `正在启动 ${project.name}…`);
    if (project.debugEnabled) {
      this.emitLog(project.id, 'system', `JDWP 已启用，调试端口 ${project.debugPort}`);
    }

    let spec;
    try {
      const prepared = await this.prepareProject(project);
      if (managed.stopRequested) throw new Error(`${project.name} 启动已取消`);
      managed.project = prepared;
      spec = buildLaunchSpec(prepared, this.platform);
      if (prepared.type === 'spring-boot-maven') {
        this.emitLog(project.id, 'system', `直接 Java 启动 · ${prepared.mainClass} · classpath ${prepared.runtimeClasspath.length} 项`);
      }
    } catch (error) {
      managed.status = managed.stopRequested ? 'stopped' : 'failed';
      this.emitLog(project.id, managed.stopRequested ? 'system' : 'stderr', `启动准备失败：${error.message}`);
      this.emitState(project.id);
      throw error;
    }

    let child;
    try {
      child = this.spawnProcess(spec.command[0], spec.command.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: this.platform !== 'win32'
      });
    } catch (error) {
      managed.status = 'failed';
      this.emitLog(project.id, 'stderr', `启动失败：${error.message}`);
      this.emitState(project.id);
      throw error;
    }

    managed.child = child;
    managed.closed = new Promise((resolve) => child.once('close', resolve));
    child.stdout?.on('data', (chunk) => this.emitChunk(project.id, 'stdout', managed.stdoutDecoder.write(chunk)));
    child.stderr?.on('data', (chunk) => this.emitChunk(project.id, 'stderr', managed.stderrDecoder.write(chunk)));
    child.stdout?.once('end', () => this.emitChunk(project.id, 'stdout', managed.stdoutDecoder.end()));
    child.stderr?.once('end', () => this.emitChunk(project.id, 'stderr', managed.stderrDecoder.end()));
    child.once('spawn', () => {
      if (managed.status === 'starting') {
        managed.status = 'running';
        this.emitLog(project.id, 'system', `进程已启动 · PID ${child.pid}`);
        this.emitState(project.id);
      }
    });
    child.once('error', (error) => {
      if (!managed.stopRequested) {
        managed.status = 'failed';
        this.emitLog(project.id, 'stderr', `进程错误：${error.message}`);
        this.emitState(project.id);
      }
    });
    child.once('close', (code, signal) => {
      managed.exitCode = Number.isInteger(code) ? code : null;
      if (managed.stopRequested || code === 0) {
        managed.status = 'stopped';
      } else {
        managed.status = 'failed';
      }
      const detail = code === null ? `信号 ${signal ?? 'unknown'}` : `退出码 ${code}`;
      this.emitLog(project.id, managed.status === 'failed' ? 'stderr' : 'system', `进程已结束 · ${detail}`);
      this.emitState(project.id);
    });

    await waitFor(() => managed.status !== 'starting', 5000);
    if (managed.status !== 'running') {
      throw new Error(`${project.name} 未能启动，请查看控制台日志`);
    }
    return this.getState(project.id);
  }

  async stop(projectId) {
    const managed = this.processes.get(projectId);
    if (managed?.status === 'stopping') {
      return this.getState(projectId);
    }
    if (!managed || !ACTIVE_STATES.has(managed.status)) {
      return this.getState(projectId);
    }
    if (!managed.child) {
      managed.stopRequested = true;
      managed.status = 'stopped';
      this.emitLog(projectId, 'system', '启动已取消');
      this.emitState(projectId);
      return this.getState(projectId);
    }
    managed.stopRequested = true;
    managed.status = 'stopping';
    this.emitState(projectId);
    this.emitLog(projectId, 'system', '正在停止进程…');
    await terminateTree(managed.child, this.platform, this.spawnProcess, managed.closed);
    return this.getState(projectId);
  }

  async restart(project) {
    await this.stop(project.id);
    return this.start(project);
  }

  async startAll(projects) {
    return this.startQueue(projects.filter((project) => project.enabled));
  }

  async startGroup(projects) {
    return this.startQueue(projects);
  }

  async startQueue(projects) {
    const generation = ++this.sequenceGeneration;
    const queue = [...projects]
      .sort((left, right) => left.startupOrder - right.startupOrder || left.name.localeCompare(right.name));
    this.emit('sequence', { status: 'starting', total: queue.length });
    const started = [];
    try {
      for (const project of queue) {
        if (generation !== this.sequenceGeneration) break;
        if (ACTIVE_STATES.has(this.processes.get(project.id)?.status)) continue;
        await this.start(project);
        await delay(800);
        if (this.processes.get(project.id)?.status !== 'running') {
          throw new Error(`${project.name} 启动后立即退出，已停止后续启动`);
        }
        started.push(project.id);
      }
      this.emit('sequence', { status: 'complete', total: queue.length, started });
      return started;
    } catch (error) {
      this.emit('sequence', { status: 'failed', message: error.message, started });
      throw error;
    }
  }

  async stopAll() {
    this.sequenceGeneration += 1;
    const activeIds = [...this.processes.entries()]
      .filter(([, managed]) => ACTIVE_STATES.has(managed.status))
      .map(([projectId]) => projectId);
    await Promise.allSettled(activeIds.map((projectId) => this.stop(projectId)));
  }

  killAllImmediately() {
    this.sequenceGeneration += 1;
    for (const managed of this.processes.values()) {
      if (!managed.child || !ACTIVE_STATES.has(managed.status)) continue;
      managed.stopRequested = true;
      try {
        if (this.platform !== 'win32' && managed.child.pid) {
          process.kill(-managed.child.pid, 'SIGKILL');
        } else {
          managed.child.kill('SIGKILL');
        }
      } catch {
        // The process may already have exited during application shutdown.
      }
    }
  }

  emitChunk(projectId, stream, chunk) {
    const text = stripAnsi(String(chunk)).replace(/\r\n/g, '\n');
    if (text) this.emitLog(projectId, stream, text);
  }

  emitLog(projectId, stream, text) {
    this.emit('log', { projectId, stream, text, timestamp: new Date().toISOString() });
  }

  emitState(projectId) {
    this.emit('state', this.getState(projectId));
  }
}

async function terminateTree(child, platform, spawnProcess, closedPromise) {
  if (!child.pid || child.exitCode !== null) return;
  if (platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/t'], {
        windowsHide: true, stdio: 'ignore', shell: false
      });
      killer.once('close', resolve);
      killer.once('error', resolve);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch { return; }
    }
  }
  const closed = await resolvesWithin(closedPromise, 4000);
  if (closed) return;
  if (platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true, stdio: 'ignore', shell: false
      });
      killer.once('close', resolve);
      killer.once('error', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await delay(25);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function resolvesWithin(promise, milliseconds) {
  if (!promise) return true;
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  ProcessManager,
  terminateTree,
  ACTIVE_STATES
};
