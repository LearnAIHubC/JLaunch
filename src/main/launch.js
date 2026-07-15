'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveWorkingDirectory } = require('./working-directory');

function buildLaunchSpec(project, platform = process.platform, environment = process.env) {
  const errors = validateProject(project, platform);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  const javaHome = project.jdkHome;
  const customEnvironment = parseEnvironmentVariables(project.environmentVariables);
  const env = {
    ...customEnvironment,
    JAVA_HOME: javaHome,
    PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${customEnvironment.PATH ?? environment.PATH ?? ''}`
  };
  const workingDirectory = resolveWorkingDirectory(project);

  if (project.type === 'spring-boot-maven') {
    if (!Array.isArray(project.runtimeClasspath) || project.runtimeClasspath.length === 0) {
      throw new Error('尚未解析 Spring Boot 运行 classpath');
    }
    const java = path.join(javaHome, 'bin', platform === 'win32' ? 'java.exe' : 'java');
    const command = [
      java,
      '-XX:TieredStopAtLevel=1',
      '-Dspring.output.ansi.enabled=always',
      '-Dcom.sun.management.jmxremote',
      '-Dspring.jmx.enabled=true',
      '-Dspring.liveBeansView.mbeanDomain',
      '-Dspring.application.admin.enabled=true',
      '-Dmanagement.endpoints.jmx.exposure.include=*',
      '-Dfile.encoding=UTF-8',
      '-Dsun.stdout.encoding=UTF-8',
      '-Dsun.stderr.encoding=UTF-8'
    ];
    if (project.debugEnabled) {
      command.push(debugAgent(project.jdkHome, project.debugPort));
    }
    if (project.profiles) command.push(`-Dspring.profiles.active=${project.profiles}`);
    command.push('-classpath', project.runtimeClasspath.join(path.delimiter), project.mainClass);
    command.push(...parseArguments(project.arguments));
    return { command, cwd: workingDirectory, env };
  }

  if (project.type === 'spring-boot-jar') {
    const java = path.join(javaHome, 'bin', platform === 'win32' ? 'java.exe' : 'java');
    const command = [java];
    if (project.debugEnabled) {
      command.push(debugAgent(project.jdkHome, project.debugPort));
    }
    command.push('-jar', project.artifactPath);
    if (project.profiles) {
      command.push(`--spring.profiles.active=${project.profiles}`);
    }
    command.push(...parseArguments(project.arguments));
    return { command, cwd: workingDirectory, env };
  }

  const catalina = path.join(project.tomcatHome, 'bin', platform === 'win32' ? 'catalina.bat' : 'catalina.sh');
  const command = windowsScript(platform, catalina);
  if (project.debugEnabled) {
    command.push('jpda');
  }
  command.push('run');
  env.CATALINA_HOME = project.tomcatHome;
  env.CATALINA_BASE = project.projectPath;
  if (project.arguments) {
    env.CATALINA_OPTS = [customEnvironment.CATALINA_OPTS ?? environment.CATALINA_OPTS, project.arguments].filter(Boolean).join(' ');
  }
  if (project.debugEnabled) {
    env.JPDA_ADDRESS = debugAddress(project.jdkHome, project.debugPort);
    env.JPDA_TRANSPORT = 'dt_socket';
    env.JPDA_SUSPEND = 'n';
  }
  return { command, cwd: workingDirectory, env };
}

function validateProject(project, platform = process.platform) {
  const errors = [];
  if (!project || typeof project !== 'object') {
    return ['项目配置不存在'];
  }
  if (!isDirectory(project.projectPath)) {
    errors.push(`项目目录不存在：${project.projectPath ?? ''}`);
  }
  const workingDirectory = resolveWorkingDirectory(project);
  if (!isDirectory(workingDirectory)) {
    errors.push(`工作目录不存在：${workingDirectory ?? ''}`);
  }
  const java = project.jdkHome && path.join(project.jdkHome, 'bin', platform === 'win32' ? 'java.exe' : 'java');
  if (!isFile(java)) {
    errors.push('请选择有效的 JDK');
  }
  if (!Number.isInteger(project.debugPort) || project.debugPort < 1 || project.debugPort > 65535) {
    errors.push('Debug 端口必须在 1 到 65535 之间');
  }

  if (project.type === 'spring-boot-maven') {
    if (!isFile(path.join(workingDirectory ?? '', 'pom.xml'))) {
      errors.push('工作目录中没有 pom.xml');
    }
    if (!project.mainClass) {
      errors.push('直接运行需要配置 Spring Boot 主类');
    } else if (!/^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*$/.test(project.mainClass)) {
      errors.push('Spring Boot 主类格式无效');
    }
    const maven = project.mavenHome && path.join(project.mavenHome, 'bin', platform === 'win32' ? 'mvn.cmd' : 'mvn');
    if (!isFile(maven)) {
      errors.push('请选择有效的 Maven');
    }
  } else if (project.type === 'spring-boot-jar') {
    if (!isFile(project.artifactPath)) {
      errors.push('请选择有效的可执行 JAR');
    }
  } else if (project.type === 'tomcat') {
    const catalina = project.tomcatHome && path.join(project.tomcatHome, 'bin', platform === 'win32' ? 'catalina.bat' : 'catalina.sh');
    if (!isFile(catalina)) {
      errors.push('请选择有效的 Tomcat');
    }
    if (!isFile(path.join(project.projectPath ?? '', 'conf', 'server.xml'))) {
      errors.push('CATALINA_BASE 中没有 conf/server.xml');
    }
  } else {
    errors.push('项目类型无效');
  }
  try {
    parseEnvironmentVariables(project.environmentVariables);
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

function parseEnvironmentVariables(value) {
  const variables = Object.create(null);
  if (!value || !value.trim()) return variables;
  const entries = value.split(/\r?\n|;/).map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error(`环境变量格式无效：${entry}`);
    }
    const name = entry.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`环境变量名称无效：${name}`);
    }
    variables[name] = entry.slice(separator + 1).trim();
  }
  return variables;
}

function parseArguments(value) {
  if (!value || !value.trim()) {
    return [];
  }
  const result = [];
  let current = '';
  let quote = null;
  let escaping = false;
  let started = false;

  for (const character of value) {
    if (escaping) {
      current += character;
      escaping = false;
      started = true;
    } else if (character === '\\' && quote !== "'") {
      escaping = true;
      started = true;
    } else if (quote && character === quote) {
      quote = null;
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character;
      started = true;
    } else if (!quote && /\s/.test(character)) {
      if (started) {
        result.push(current);
        current = '';
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (quote) {
    throw new Error('启动参数中有未闭合的引号');
  }
  if (escaping) {
    current += '\\';
  }
  if (started) {
    result.push(current);
  }
  return result;
}

function readJavaMajor(jdkHome) {
  try {
    const release = fs.readFileSync(path.join(jdkHome, 'release'), 'utf8');
    const match = release.match(/^JAVA_VERSION="([^"]+)"/m);
    if (!match) return 9;
    const raw = match[1];
    return raw.startsWith('1.') ? Number(raw.split('.')[1]) : Number(raw.split(/[.+-]/)[0]);
  } catch {
    return 9;
  }
}

function debugAddress(jdkHome, port) {
  return readJavaMajor(jdkHome) <= 8 ? String(port) : `127.0.0.1:${port}`;
}

function debugAgent(jdkHome, port) {
  return `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=${debugAddress(jdkHome, port)}`;
}

function windowsScript(platform, script) {
  return platform === 'win32' ? ['cmd.exe', '/d', '/c', script] : [script];
}

function isFile(value) {
  if (!value) return false;
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

function isDirectory(value) {
  if (!value) return false;
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

module.exports = {
  buildLaunchSpec,
  validateProject,
  parseArguments,
  parseEnvironmentVariables,
  readJavaMajor,
  debugAddress
};
