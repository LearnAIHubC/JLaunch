'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listSourceFiles, readSourceFile, isInside } = require('../src/main/source-service');

test('lists readable source files and ignores build output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/main/java/dev/example'), { recursive: true });
  fs.mkdirSync(path.join(root, 'target/classes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/main/java/dev/example/App.java'), 'package dev.example;\nclass App {\n}\n');
  fs.writeFileSync(path.join(root, 'src/main/resources.yml'), 'enabled: true\n');
  fs.writeFileSync(path.join(root, 'target/classes/App.java'), 'generated');
  fs.writeFileSync(path.join(root, 'README.md'), 'ignored');

  const project = { projectPath: root };
  const listed = await listSourceFiles(project);
  assert.deepEqual(listed.files.map((file) => file.path).sort(), [
    path.join('src', 'main', 'java', 'dev', 'example', 'App.java'),
    path.join('src', 'main', 'resources.yml')
  ]);
  const source = await readSourceFile(project, path.join('src', 'main', 'java', 'dev', 'example', 'App.java'));
  assert.equal(source.language, 'java');
  assert.equal(source.className, 'dev.example.App');
  assert.match(source.content, /class App/);
});

test('blocks source path traversal', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-traversal-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(parent, 'secret.java'), 'secret');
  assert.equal(isInside(root, path.join(parent, 'secret.java')), false);
  await assert.rejects(() => readSourceFile({ projectPath: root }, '../secret.java'), /项目目录之外/);
});
