'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DebugManager } = require('../src/main/debug-manager');

test('attaches jdb, manages a breakpoint and resumes a paused thread', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-debug-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jdk = path.join(root, 'jdk');
  fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(jdk, 'bin', 'jdb'), 'fixture');

  const child = new EventEmitter();
  child.pid = 7001;
  child.exitCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.exitCode = 0;
    process.nextTick(() => child.emit('close', 0));
  };
  child.stdin.once('finish', () => {
    child.exitCode = 0;
    process.nextTick(() => child.emit('close', 0));
  });
  const commands = [];
  child.stdin.on('data', (chunk) => commands.push(String(chunk)));
  const manager = new DebugManager({ platform: 'darwin', spawnProcess: () => child });
  const states = [];
  manager.on('state', (state) => states.push(state));

  const attaching = manager.start({ id: 'orders', name: 'Orders', jdkHome: jdk, debugPort: 5005 });
  child.stdout.write('Set uncaught java.lang.Throwable\nInitializing jdb ...\n');
  const attached = await attaching;
  assert.equal(attached.status, 'attached');

  manager.setBreakpoint('orders', {
    relativePath: 'src/main/java/dev/example/OrdersController.java',
    className: 'dev.example.OrdersController',
    line: 42
  });
  assert.ok(commands.some((command) => command.includes('stop at dev.example.OrdersController:42')));
  child.stdout.write('Deferring breakpoint dev.example.OrdersController:42.\n');
  assert.equal(manager.listBreakpoints('orders')[0].status, 'verified');

  child.stdout.write('Breakpoint hit: "thread=http-nio-8080-exec-1", dev.example.OrdersController.find(), line=42 bci=0\n');
  const paused = manager.getState('orders');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.paused.relativePath, 'src/main/java/dev/example/OrdersController.java');
  assert.equal(paused.paused.threadName, 'http-nio-8080-exec-1');

  const resumed = manager.resume('orders');
  assert.equal(resumed.status, 'attached');
  assert.ok(commands.some((command) => command === 'cont\n'));
  await Promise.all([manager.stop('orders'), manager.stop('orders')]);
  assert.equal(manager.getState('orders').status, 'disconnected');
  assert.equal(commands.filter((command) => command === 'exit\n').length, 1);
  assert.ok(states.some((state) => state.status === 'paused'));
});
