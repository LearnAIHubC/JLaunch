'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { collectMavenModules } = require('./project-inspector');
const { stripAnsi } = require('./toolchain');
const { resolveWorkingDirectory } = require('./working-directory');

class MavenClasspathResolver {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.cache = new Map();
  }

  async prepare(project) {
    if (project.type !== 'spring-boot-maven') return project;
    if (!project.mainClass) throw new Error('直接运行需要配置 Spring Boot 主类');
    const workingDirectory = resolveWorkingDirectory(project);
    const cacheKey = [
      workingDirectory, project.mavenHome, project.jdkHome, project.profiles,
      modifiedTime(path.join(project.projectPath, 'pom.xml')),
      modifiedTime(path.join(workingDirectory, 'pom.xml'))
    ].join('\0');
    let runtimeClasspath = this.cache.get(cacheKey);
    if (!runtimeClasspath) {
      runtimeClasspath = await this.resolve(project);
      this.cache.set(cacheKey, runtimeClasspath);
    }
    return { ...project, runtimeClasspath };
  }

  async resolve(project) {
    const workingDirectory = resolveWorkingDirectory(project);
    const classes = path.join(workingDirectory, 'target', 'classes');
    if (!isDirectory(classes)) {
      throw new Error('没有找到 target/classes，请先在 Maven 工具窗执行 compile');
    }
    const reactorClasses = await collectReactorClasses(project.projectPath, workingDirectory);
    const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'java-runs-classpath-'));
    const runtimeOutput = path.join(temporaryDirectory, 'runtime-classpath.txt');
    const compileOutput = path.join(temporaryDirectory, 'compile-classpath.txt');
    try {
      await this.runMaven(project, workingDirectory, runtimeOutput, 'runtime');
      await this.runMaven(project, workingDirectory, compileOutput, 'compile');
      const contents = await Promise.all([
        fsp.readFile(runtimeOutput, 'utf8'),
        fsp.readFile(compileOutput, 'utf8')
      ]);
      const dependencies = contents.flatMap((content) =>
        content.trim() ? content.trim().split(path.delimiter).filter(Boolean) : []);
      return [...new Set([...reactorClasses, ...dependencies])];
    } finally {
      await fsp.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  runMaven(project, workingDirectory, outputFile, scope) {
    const executable = path.join(project.mavenHome, 'bin', this.platform === 'win32' ? 'mvn.cmd' : 'mvn');
    if (!isFile(executable)) throw new Error('项目没有配置有效的 Maven');
    const command = this.platform === 'win32' ? 'cmd.exe' : executable;
    const args = this.platform === 'win32' ? ['/d', '/c', executable] : [];
    args.push('-q', '-Dstyle.color=never');
    if (project.profiles?.trim()) args.push(`-P${project.profiles.trim()}`);
    args.push(
      'dependency:build-classpath',
      `-DincludeScope=${scope}`,
      `-Dmdep.outputFile=${outputFile}`,
      `-Dmdep.pathSeparator=${path.delimiter}`,
      '-Dmdep.regenerateFile=true'
    );
    return runProcess(this.spawnProcess, command, args, {
      cwd: workingDirectory,
      env: {
        ...process.env,
        JAVA_HOME: project.jdkHome,
        PATH: `${path.join(project.jdkHome, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
  }
}

async function collectReactorClasses(projectPath, workingDirectory) {
  const modules = await collectMavenModules(projectPath);
  const realWorkingDirectory = await fsp.realpath(workingDirectory);
  const byArtifactId = new Map(modules.map((module) => [module.artifactId, module]));
  const current = modules.find((module) => module.path === realWorkingDirectory);
  const result = [];
  const visited = new Set();
  const visit = (module) => {
    if (!module || visited.has(module.path)) return;
    visited.add(module.path);
    const classes = path.join(module.path, 'target', 'classes');
    if (isDirectory(classes)) result.push(classes);
    for (const artifactId of module.dependencyArtifactIds) visit(byArtifactId.get(artifactId));
  };
  visit(current ?? { path: realWorkingDirectory, dependencyArtifactIds: [] });
  return result;
}

function runProcess(spawnProcess, command, args, options) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, options);
    } catch (error) {
      reject(error);
      return;
    }
    let output = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stdout?.on('data', (chunk) => { output = appendOutput(output, chunk); });
    child.stderr?.on('data', (chunk) => { output = appendOutput(output, chunk); });
    child.once('error', finish);
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`Maven 解析运行 classpath 失败（退出码 ${code}）\n${output.trim()}`));
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already closed */ }
      finish(new Error('Maven 解析运行 classpath 超时'));
    }, 60_000);
  });
}

function appendOutput(current, chunk) {
  const next = current + stripAnsi(String(chunk));
  return next.length > 20_000 ? next.slice(-20_000) : next;
}

function isFile(value) {
  try { return fs.statSync(value).isFile(); } catch { return false; }
}

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

function modifiedTime(value) {
  try { return fs.statSync(value).mtimeMs; } catch { return 0; }
}

module.exports = { MavenClasspathResolver, collectReactorClasses, runProcess };
