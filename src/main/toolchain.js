'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const TOOL_KINDS = new Set(['jdk', 'maven', 'tomcat']);
// These patterns intentionally match terminal control sequences emitted by Java tools.
// eslint-disable-next-line no-control-regex
const ANSI_CSI_PATTERN = new RegExp('\\u001B\\[[0-?]*[ -/]*[@-~]', 'g');
// eslint-disable-next-line no-control-regex
const ANSI_OSC_PATTERN = new RegExp('\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)', 'g');

async function discoverToolchains(extraTools = [], platform = process.platform, env = process.env) {
  const candidates = {
    jdk: new Set(),
    maven: new Set(),
    tomcat: new Set()
  };
  for (const tool of extraTools) {
    if (tool?.path && TOOL_KINDS.has(tool.kind)) {
      candidates[tool.kind].add(tool.path);
    }
  }
  addEnvironment(candidates.jdk, env.JAVA_HOME);
  addEnvironment(candidates.maven, env.MAVEN_HOME);
  addEnvironment(candidates.maven, env.M2_HOME);
  addEnvironment(candidates.tomcat, env.CATALINA_HOME);
  await addPathTool(candidates.maven, platform === 'win32' ? 'mvn.cmd' : 'mvn', env.PATH);

  const home = os.homedir();
  if (platform === 'darwin') {
    await addMacJdks(candidates.jdk);
    await addChildren(candidates.jdk, path.join(home, 'Library/Java/JavaVirtualMachines'),
      (child) => path.join(child, 'Contents/Home'));
    await addChildren(candidates.jdk, '/Library/Java/JavaVirtualMachines',
      (child) => path.join(child, 'Contents/Home'));
    for (const cellar of ['/opt/homebrew/Cellar', '/usr/local/Cellar']) {
      await addChildren(candidates.maven, path.join(cellar, 'maven'), (child) => path.join(child, 'libexec'));
      await addChildren(candidates.tomcat, path.join(cellar, 'tomcat'), (child) => path.join(child, 'libexec'));
    }
    addEnvironment(candidates.maven, '/opt/homebrew/opt/maven/libexec');
    addEnvironment(candidates.maven, '/usr/local/opt/maven/libexec');
    addEnvironment(candidates.tomcat, '/opt/homebrew/opt/tomcat/libexec');
    addEnvironment(candidates.tomcat, '/usr/local/opt/tomcat/libexec');
  } else if (platform === 'linux') {
    await addChildren(candidates.jdk, '/usr/lib/jvm', (child) => child);
    addEnvironment(candidates.maven, '/usr/share/maven');
    addEnvironment(candidates.tomcat, '/opt/tomcat');
  } else if (platform === 'win32') {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    await addChildren(candidates.jdk, path.join(programFiles, 'Java'), (child) => child);
    await addChildren(candidates.jdk, path.join(programFiles, 'Eclipse Adoptium'), (child) => child);
    await addChildren(candidates.maven, path.join(programFiles, 'Apache', 'maven'), (child) => child);
    await addChildren(candidates.tomcat, path.join(programFiles, 'Apache Software Foundation'), (child) => child);
  }

  await addChildren(candidates.jdk, path.join(home, '.sdkman/candidates/java'), (child) => child);
  await addChildren(candidates.maven, path.join(home, '.sdkman/candidates/maven'), (child) => child);
  await addChildren(candidates.tomcat, path.join(home, '.sdkman/candidates/tomcat'), (child) => child);
  await addNamedHomeChildren(candidates.maven, home, 'apache-maven-');
  await addNamedHomeChildren(candidates.tomcat, home, 'apache-tomcat-');

  const jdkForProbe = [...candidates.jdk].find((candidate) => isValidTool('jdk', candidate, platform)) ?? env.JAVA_HOME;
  const inspections = [];
  for (const [kind, homes] of Object.entries(candidates)) {
    for (const toolHome of homes) {
      if (isValidTool(kind, toolHome, platform)) {
        inspections.push(inspectTool(kind, toolHome, platform, jdkForProbe).catch(() => null));
      }
    }
  }
  const tools = (await Promise.all(inspections)).filter(Boolean);
  const unique = new Map(tools.map((tool) => [`${tool.kind}\0${tool.path}`, tool]));
  return [...unique.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || right.version.localeCompare(left.version) || left.path.localeCompare(right.path));
}

async function inspectTool(kind, toolHome, platform = process.platform, javaHome = process.env.JAVA_HOME) {
  if (!TOOL_KINDS.has(kind)) {
    throw new Error('不支持的工具类型');
  }
  const normalized = path.resolve(toolHome);
  if (!isValidTool(kind, normalized, platform)) {
    throw new Error(`${normalized} 不是有效的 ${displayKind(kind)} 目录`);
  }

  let command;
  let args;
  let cwd = normalized;
  const env = { ...process.env };
  if (kind === 'jdk') {
    command = executable(normalized, 'java', platform);
    args = ['-version'];
  } else if (kind === 'maven') {
    command = executable(normalized, 'mvn', platform);
    args = ['-version'];
  } else {
    command = executable(normalized, 'catalina', platform);
    args = ['version'];
    cwd = path.join(normalized, 'bin');
    if (javaHome) env.JAVA_HOME = javaHome;
    env.CATALINA_HOME = normalized;
  }
  const output = await runTool(command, args, { cwd, env, platform });
  return { kind, path: normalized, version: parseVersion(kind, output, normalized) };
}

function isValidTool(kind, toolHome, platform = process.platform) {
  if (!toolHome) return false;
  const normalized = path.resolve(toolHome);
  if (kind === 'jdk') {
    return isFile(executable(normalized, 'java', platform)) && isFile(executable(normalized, 'javac', platform));
  }
  if (kind === 'maven') {
    return isFile(executable(normalized, 'mvn', platform));
  }
  if (kind === 'tomcat') {
    return isFile(executable(normalized, 'catalina', platform)) && isFile(path.join(normalized, 'lib', 'catalina.jar'));
  }
  return false;
}

async function runTool(command, args, options) {
  let executableCommand = command;
  let executableArgs = args;
  if (options.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    executableCommand = 'cmd.exe';
    executableArgs = ['/d', '/c', command, ...args];
  }
  try {
    const { stdout, stderr } = await execFileAsync(executableCommand, executableArgs, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
      maxBuffer: 256 * 1024
    });
    return stripAnsi(`${stdout}\n${stderr}`).trim();
  } catch (error) {
    const output = stripAnsi(`${error.stdout ?? ''}\n${error.stderr ?? ''}`).trim();
    if (output) return output;
    throw error;
  }
}

function parseVersion(kind, output, toolHome) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (kind === 'jdk') {
    const versionLine = lines.find((line) => /(?:openjdk|java) version/i.test(line)) ?? lines[0];
    const version = versionLine?.match(/version\s+"([^"]+)"/i)?.[1] ?? path.basename(toolHome);
    return `JDK ${version}`;
  }
  if (kind === 'maven') {
    const line = lines.find((item) => /Apache Maven/i.test(item)) ?? lines[0];
    const version = line?.match(/Apache Maven\s+([^\s]+)/i)?.[1] ?? path.basename(toolHome);
    return `Maven ${version}`;
  }
  const line = lines.find((item) => /Server version:/i.test(item));
  return line?.replace(/^Server version:\s*/i, '') || `Tomcat · ${path.basename(toolHome)}`;
}

async function addMacJdks(target) {
  try {
    const { stdout, stderr } = await execFileAsync('/usr/libexec/java_home', ['-V'], {
      encoding: 'utf8', timeout: 4000, maxBuffer: 256 * 1024
    });
    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
      const match = line.trim().match(/(\/.+\/Contents\/Home)\s*$/);
      if (match) target.add(match[1]);
    }
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/(\/.+\/Contents\/Home)\s*$/);
      if (match) target.add(match[1]);
    }
  }
}

async function addPathTool(target, executableName, pathValue = '') {
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executableName);
    if (!isFile(candidate)) continue;
    try {
      const real = await fsp.realpath(candidate);
      target.add(path.dirname(path.dirname(real)));
    } catch {
      target.add(path.dirname(path.dirname(candidate)));
    }
  }
}

async function addChildren(target, parent, mapper) {
  try {
    const entries = await fsp.readdir(parent, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        target.add(mapper(path.join(parent, entry.name)));
      }
    }
  } catch {
    // Optional discovery roots are expected to be absent on many machines.
  }
}

async function addNamedHomeChildren(target, parent, prefix) {
  try {
    const entries = await fsp.readdir(parent, { withFileTypes: true });
    for (const entry of entries) {
      if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith(prefix)) {
        target.add(path.join(parent, entry.name));
      }
    }
  } catch {
    // The user's home is normally readable, but discovery must remain non-fatal.
  }
}

function addEnvironment(target, value) {
  if (value) target.add(path.resolve(value));
}

function executable(home, tool, platform) {
  const names = {
    java: platform === 'win32' ? 'java.exe' : 'java',
    javac: platform === 'win32' ? 'javac.exe' : 'javac',
    mvn: platform === 'win32' ? 'mvn.cmd' : 'mvn',
    catalina: platform === 'win32' ? 'catalina.bat' : 'catalina.sh'
  };
  return path.join(home, 'bin', names[tool]);
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function stripAnsi(value) {
  return String(value).replace(ANSI_OSC_PATTERN, '').replace(ANSI_CSI_PATTERN, '');
}

function displayKind(kind) {
  return { jdk: 'JDK', maven: 'Maven', tomcat: 'Tomcat' }[kind] ?? kind;
}

module.exports = {
  discoverToolchains,
  inspectTool,
  isValidTool,
  parseVersion,
  stripAnsi
};
