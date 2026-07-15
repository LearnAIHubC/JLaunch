'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildLaunchSpec, parseArguments, parseEnvironmentVariables, readJavaMajor, validateProject } = require('../src/main/launch');
const { MODULE_WORKING_DIR_MACRO } = require('../src/main/working-directory');

function fixture(t, javaVersion = '21.0.7') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jdk = path.join(root, 'jdk');
  const maven = path.join(root, 'maven');
  const tomcat = path.join(root, 'tomcat');
  const project = path.join(root, 'project');
  const jar = path.join(project, 'app.jar');
  for (const directory of [path.join(jdk, 'bin'), path.join(maven, 'bin'), path.join(tomcat, 'bin'), path.join(tomcat, 'lib'), path.join(project, 'conf')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const file of [path.join(jdk, 'bin', 'java'), path.join(maven, 'bin', 'mvn'), path.join(tomcat, 'bin', 'catalina.sh')]) {
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, 0o755);
  }
  fs.writeFileSync(path.join(jdk, 'release'), `JAVA_VERSION="${javaVersion}"\n`);
  fs.writeFileSync(path.join(tomcat, 'lib', 'catalina.jar'), 'fixture');
  fs.writeFileSync(path.join(project, 'conf', 'server.xml'), '<Server />');
  fs.writeFileSync(path.join(project, 'pom.xml'), '<project />');
  fs.writeFileSync(jar, 'fixture');
  return { root, jdk, maven, tomcat, project, jar };
}

function baseProject(paths) {
  return {
    id: 'project-1',
    name: 'Orders',
    type: 'spring-boot-maven',
    projectPath: paths.project,
    workingDirectory: paths.project,
    moduleWorkingDirectory: paths.project,
    mainClass: 'dev.example.OrdersApplication',
    environmentVariables: 'SERVER_PORT=8081;FEATURE_FLAG=true',
    artifactPath: null,
    jdkHome: paths.jdk,
    mavenHome: paths.maven,
    tomcatHome: null,
    profiles: 'dev,local',
    arguments: '--server.port=8081',
    startupOrder: 10,
    enabled: true,
    debugEnabled: true,
    debugPort: 5005,
    runtimeClasspath: [path.join(paths.project, 'target', 'classes'), path.join(paths.root, 'repository', 'spring.jar')]
  };
}

test('parses quoted application arguments without invoking a shell', () => {
  assert.deepEqual(parseArguments('--port 8080 --name="local service" \'single value\' empty=""'), [
    '--port', '8080', '--name=local service', 'single value', 'empty='
  ]);
  assert.throws(() => parseArguments('--name="unfinished'), /未闭合/);
});

test('parses newline and semicolon separated environment variables', () => {
  assert.deepEqual({ ...parseEnvironmentVariables('SERVER_PORT=9380; FEATURE=true\nEMPTY=') }, {
    SERVER_PORT: '9380', FEATURE: 'true', EMPTY: ''
  });
  assert.throws(() => parseEnvironmentVariables('INVALID ENTRY'), /格式无效/);
  assert.throws(() => parseEnvironmentVariables('1INVALID=value'), /名称无效/);
});

test('builds IDEA-style direct Java command with JDK 8 compatible debug address', (t) => {
  const paths = fixture(t, '1.8.0_402');
  const project = { ...baseProject(paths), workingDirectory: MODULE_WORKING_DIR_MACRO };
  const spec = buildLaunchSpec(project, 'darwin', { PATH: '/usr/bin' });
  assert.equal(spec.command[0], path.join(paths.jdk, 'bin', 'java'));
  assert.ok(spec.command.includes('-XX:TieredStopAtLevel=1'));
  assert.ok(spec.command.includes('-Dspring.profiles.active=dev,local'));
  assert.ok(spec.command.includes('dev.example.OrdersApplication'));
  assert.equal(spec.command[spec.command.indexOf('-classpath') + 1], project.runtimeClasspath.join(path.delimiter));
  assert.equal(spec.command.includes('spring-boot:run'), false);
  assert.ok(spec.command.some((argument) => argument.includes('address=5005')));
  assert.equal(spec.cwd, paths.project);
  assert.equal(spec.env.JAVA_HOME, paths.jdk);
  assert.equal(spec.env.SERVER_PORT, '8081');
});

test('builds Spring Boot JAR command with modern JDWP and split arguments', (t) => {
  const paths = fixture(t);
  const project = {
    ...baseProject(paths),
    type: 'spring-boot-jar',
    artifactPath: paths.jar,
    mavenHome: null,
    arguments: '--server.port=8082 --title="Hello world"'
  };
  const spec = buildLaunchSpec(project, 'linux');
  assert.equal(spec.command[0], path.join(paths.jdk, 'bin', 'java'));
  assert.ok(spec.command.includes('-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005'));
  assert.deepEqual(spec.command.slice(-2), ['--server.port=8082', '--title=Hello world']);
});

test('builds managed Tomcat run command and environment', (t) => {
  const paths = fixture(t);
  const project = {
    ...baseProject(paths),
    type: 'tomcat',
    mavenHome: null,
    tomcatHome: paths.tomcat,
    profiles: '',
    arguments: '-Xms128m -Xmx512m'
  };
  const spec = buildLaunchSpec(project, 'darwin', { PATH: '/usr/bin', CATALINA_OPTS: '-Dfile.encoding=UTF-8' });
  assert.deepEqual(spec.command, [path.join(paths.tomcat, 'bin', 'catalina.sh'), 'jpda', 'run']);
  assert.equal(spec.env.CATALINA_BASE, paths.project);
  assert.equal(spec.env.JPDA_ADDRESS, '127.0.0.1:5005');
  assert.equal(spec.env.CATALINA_OPTS, '-Dfile.encoding=UTF-8 -Xms128m -Xmx512m');
});

test('validates required project artifacts', (t) => {
  const paths = fixture(t);
  const missing = path.join(paths.root, 'missing');
  const project = { ...baseProject(paths), projectPath: missing, workingDirectory: missing };
  const errors = validateProject(project, 'darwin');
  assert.ok(errors.some((error) => error.includes('项目目录不存在')));
  assert.ok(errors.some((error) => error.includes('pom.xml')));
  assert.equal(readJavaMajor(paths.jdk), 21);
});
