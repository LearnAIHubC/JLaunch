'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { MavenTaskManager, buildMavenLaunch } = require('../src/main/maven-task-manager');

test('builds a Maven lifecycle command for a selected module', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-maven-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'orders-service');
  const jdk = path.join(root, 'jdk');
  const maven = path.join(root, 'maven');
  fs.mkdirSync(modulePath);
  fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(maven, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(modulePath, 'pom.xml'), '<project />');
  fs.writeFileSync(path.join(jdk, 'bin', 'java'), 'fixture');
  fs.writeFileSync(path.join(maven, 'bin', 'mvn'), 'fixture');
  const spec = buildMavenLaunch(
    { workingDirectory: modulePath, goal: 'package', profiles: 'local' },
    { jdkHome: jdk, mavenHome: maven },
    'darwin',
    { PATH: '/usr/bin' }
  );
  assert.deepEqual(spec.command, [path.join(maven, 'bin', 'mvn'), '-Dstyle.color=never', '-Plocal', 'package']);
  assert.equal(spec.cwd, modulePath);
  assert.equal(spec.env.JAVA_HOME, jdk);
  assert.throws(() => buildMavenLaunch(
    { workingDirectory: modulePath, goal: 'arbitrary:goal' },
    { jdkHome: jdk, mavenHome: maven },
    'darwin'
  ), /不支持/);
});

test('reports a synchronous Maven spawn failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-maven-spawn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jdk = path.join(root, 'jdk');
  const maven = path.join(root, 'maven');
  fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(maven, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pom.xml'), '<project />');
  fs.writeFileSync(path.join(jdk, 'bin', 'java'), 'fixture');
  fs.writeFileSync(path.join(maven, 'bin', 'mvn'), 'fixture');
  const manager = new MavenTaskManager({
    platform: 'darwin',
    spawnProcess: () => { throw new Error('spawn unavailable'); }
  });
  const logs = [];
  manager.on('log', (entry) => logs.push(entry.text));

  await assert.rejects(
    manager.run({ moduleName: 'demo', workingDirectory: root, goal: 'validate', profiles: '' }, {
      jdkHome: jdk,
      mavenHome: maven
    }),
    /spawn unavailable/
  );
  assert.equal(manager.getState().status, 'failed');
  assert.ok(logs.some((entry) => entry.includes('Maven 启动失败')));
});

test('stops a running Maven task and its process tree', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-maven-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jdk = path.join(root, 'jdk');
  const maven = path.join(root, 'maven');
  fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(maven, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pom.xml'), '<project />');
  fs.writeFileSync(path.join(jdk, 'bin', 'java.exe'), 'fixture');
  fs.writeFileSync(path.join(maven, 'bin', 'mvn.cmd'), 'fixture');

  const child = new EventEmitter();
  child.pid = 9191;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let spawnCount = 0;
  const manager = new MavenTaskManager({
    platform: 'win32',
    spawnProcess: (command) => {
      spawnCount += 1;
      if (spawnCount === 1) {
        process.nextTick(() => child.emit('spawn'));
        return child;
      }
      assert.equal(command, 'taskkill');
      const killer = new EventEmitter();
      process.nextTick(() => {
        child.exitCode = 0;
        child.emit('close', 0, null);
        killer.emit('close', 0);
      });
      return killer;
    }
  });

  await manager.run({ moduleName: 'demo', workingDirectory: root, goal: 'test', profiles: '' }, {
    jdkHome: jdk,
    mavenHome: maven
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getState().status, 'running');
  const stopped = await manager.stop();
  assert.equal(stopped.status, 'stopped');
  assert.equal(spawnCount, 2);
});
