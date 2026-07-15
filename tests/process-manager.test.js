'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ProcessManager } = require('../src/main/process-manager');

test('tracks a managed process from startup through tree termination', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jdk = path.join(root, 'jdk');
  fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(jdk, 'bin', 'java.exe'), 'fixture');
  fs.writeFileSync(path.join(jdk, 'release'), 'JAVA_VERSION="21.0.7"\n');
  const jar = path.join(root, 'app.jar');
  fs.writeFileSync(jar, 'fixture');

  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let initialSpawned = false;
  const spawnProcess = (command) => {
    if (!initialSpawned) {
      initialSpawned = true;
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
  };

  const manager = new ProcessManager({ platform: 'win32', spawnProcess });
  const states = [];
  const logs = [];
  manager.on('state', (value) => states.push(value));
  manager.on('log', (value) => logs.push(value));
  const project = {
    id: 'fixture', name: 'Fixture', type: 'spring-boot-jar', projectPath: root,
    artifactPath: jar, jdkHome: jdk, mavenHome: null, tomcatHome: null,
    profiles: '', arguments: '', startupOrder: 1, enabled: true,
    debugEnabled: false, debugPort: 5005
  };

  const running = await manager.start(project);
  assert.equal(running.status, 'running');
  assert.equal(running.pid, 4242);
  child.stdout.write('ready\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((entry) => entry.text.includes('ready')));

  const stopped = await manager.stop(project.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pid, null);
  assert.deepEqual(states.map((item) => item.status), ['starting', 'running', 'stopping', 'stopped']);
});

test('starts enabled projects in configured order', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-sequence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jdk = path.join(root, 'jdk');
  fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(jdk, 'bin', 'java.exe'), 'fixture');
  fs.writeFileSync(path.join(jdk, 'release'), 'JAVA_VERSION="21"\n');
  const artifacts = ['first.jar', 'second.jar', 'disabled.jar'];
  for (const artifact of artifacts) fs.writeFileSync(path.join(root, artifact), 'fixture');

  let nextPid = 5000;
  const launchedArtifacts = [];
  const manager = new ProcessManager({
    platform: 'win32',
    spawnProcess: (_command, args) => {
      launchedArtifacts.push(args[args.indexOf('-jar') + 1]);
      const child = new EventEmitter();
      child.pid = nextPid++;
      child.exitCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => child.emit('spawn'));
      return child;
    }
  });
  const project = (id, artifact, startupOrder, enabled = true) => ({
    id, name: id, type: 'spring-boot-jar', projectPath: root,
    artifactPath: path.join(root, artifact), jdkHome: jdk, mavenHome: null, tomcatHome: null,
    profiles: '', arguments: '', startupOrder, enabled, debugEnabled: false, debugPort: 5005
  });

  const started = await manager.startAll([
    project('second', 'second.jar', 20),
    project('disabled', 'disabled.jar', 1, false),
    project('first', 'first.jar', 10)
  ]);
  assert.deepEqual(started, ['first', 'second']);
  assert.deepEqual(launchedArtifacts, [path.join(root, 'first.jar'), path.join(root, 'second.jar')]);
});
