'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { terminateTree } = require('./process-manager');
const { stripAnsi } = require('./toolchain');

const MAVEN_GOALS = new Set([
  'clean', 'validate', 'compile', 'test', 'package', 'verify', 'install', 'site', 'deploy',
  'dependency:tree', 'help:effective-pom'
]);

class MavenTaskManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.current = null;
  }

  getState() {
    if (!this.current) return { status: 'idle', pid: null, moduleName: null, goal: null, startedAt: null };
    return {
      status: this.current.status,
      pid: this.current.status === 'running' || this.current.status === 'stopping' ? this.current.child?.pid ?? null : null,
      moduleName: this.current.moduleName,
      goal: this.current.goal,
      startedAt: this.current.startedAt
    };
  }

  async run({ moduleName, workingDirectory, goal, profiles }, project) {
    if (this.current && ['starting', 'running', 'stopping'].includes(this.current.status)) {
      throw new Error(`Maven 任务 ${this.current.moduleName}:${this.current.goal} 正在运行`);
    }
    const spec = buildMavenLaunch({ workingDirectory, goal, profiles }, project, this.platform);
    const task = {
      moduleName,
      goal,
      status: 'starting',
      child: null,
      startedAt: new Date().toISOString(),
      stopRequested: false,
      closed: null,
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8')
    };
    this.current = task;
    this.emitState();
    this.emitLog('system', `执行 Maven · ${moduleName} › ${goal}`);

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
      task.status = 'failed';
      this.emitLog('stderr', `Maven 启动失败：${error.message}`);
      this.emitState();
      throw error;
    }
    task.child = child;
    task.closed = new Promise((resolve) => child.once('close', resolve));
    child.stdout?.on('data', (chunk) => this.emitDecoded('stdout', task.stdoutDecoder.write(chunk)));
    child.stderr?.on('data', (chunk) => this.emitDecoded('stderr', task.stderrDecoder.write(chunk)));
    child.stdout?.once('end', () => this.emitDecoded('stdout', task.stdoutDecoder.end()));
    child.stderr?.once('end', () => this.emitDecoded('stderr', task.stderrDecoder.end()));
    child.once('spawn', () => {
      task.status = 'running';
      this.emitLog('system', `Maven 进程已启动 · PID ${child.pid}`);
      this.emitState();
    });
    child.once('error', (error) => {
      if (!task.stopRequested) {
        task.status = 'failed';
        this.emitLog('stderr', `Maven 启动失败：${error.message}`);
        this.emitState();
      }
    });
    child.once('close', (code, signal) => {
      task.status = task.stopRequested ? 'stopped' : code === 0 ? 'complete' : 'failed';
      const detail = code === null ? `信号 ${signal ?? 'unknown'}` : `退出码 ${code}`;
      this.emitLog(task.status === 'failed' ? 'stderr' : 'system', `Maven 任务结束 · ${detail}`);
      this.emitState();
    });
    return this.getState();
  }

  async stop() {
    const task = this.current;
    if (!task?.child || !['starting', 'running'].includes(task.status)) return this.getState();
    task.stopRequested = true;
    task.status = 'stopping';
    this.emitState();
    this.emitLog('system', '正在停止 Maven 任务…');
    await terminateTree(task.child, this.platform, this.spawnProcess, task.closed);
    return this.getState();
  }

  killImmediately() {
    const task = this.current;
    if (!task?.child || !['starting', 'running', 'stopping'].includes(task.status)) return;
    try {
      if (this.platform !== 'win32' && task.child.pid) process.kill(-task.child.pid, 'SIGKILL');
      else task.child.kill('SIGKILL');
    } catch {
      // The task may already have exited during shutdown.
    }
  }

  emitDecoded(stream, value) {
    const text = stripAnsi(String(value)).replace(/\r\n/g, '\n');
    if (text) this.emitLog(stream, text);
  }

  emitLog(stream, text) {
    this.emit('log', { stream, text, timestamp: new Date().toISOString() });
  }

  emitState() {
    this.emit('state', this.getState());
  }
}

function buildMavenLaunch(task, project, platform = process.platform, environment = process.env) {
  if (!MAVEN_GOALS.has(task.goal)) throw new Error('不支持的 Maven 目标');
  if (!isDirectory(task.workingDirectory) || !isFile(path.join(task.workingDirectory, 'pom.xml'))) {
    throw new Error('Maven 工程目录无效或缺少 pom.xml');
  }
  const maven = project.mavenHome && path.join(project.mavenHome, 'bin', platform === 'win32' ? 'mvn.cmd' : 'mvn');
  const java = project.jdkHome && path.join(project.jdkHome, 'bin', platform === 'win32' ? 'java.exe' : 'java');
  if (!isFile(maven)) throw new Error('项目没有配置有效的 Maven');
  if (!isFile(java)) throw new Error('项目没有配置有效的 JDK');
  const command = platform === 'win32' ? ['cmd.exe', '/d', '/c', maven] : [maven];
  command.push('-Dstyle.color=never');
  if (task.profiles?.trim()) command.push(`-P${task.profiles.trim()}`);
  command.push(task.goal);
  return {
    command,
    cwd: task.workingDirectory,
    env: {
      JAVA_HOME: project.jdkHome,
      PATH: `${path.join(project.jdkHome, 'bin')}${path.delimiter}${environment.PATH ?? ''}`
    }
  };
}

function isFile(value) {
  try { return fs.statSync(value).isFile(); } catch { return false; }
}

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

module.exports = {
  MavenTaskManager,
  MAVEN_GOALS,
  buildMavenLaunch
};
