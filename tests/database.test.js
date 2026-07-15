'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { AppDatabase } = require('../src/main/database');
const { MODULE_WORKING_DIR_MACRO } = require('../src/main/working-directory');

test('persists projects, settings and discovered tools in SQLite', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-db-'));
  const database = new AppDatabase(path.join(directory, 'app.sqlite'));
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const saved = database.saveProject({
    name: 'Order service',
    type: 'spring-boot-maven',
    projectPath: path.join(directory, 'orders'),
    workingDirectory: path.join(directory, 'orders-module'),
    mainClass: 'dev.example.OrdersApplication',
    environmentVariables: 'SERVER_PORT=8081\nFEATURE_FLAG=true',
    artifactPath: null,
    jdkHome: path.join(directory, 'jdk'),
    mavenHome: path.join(directory, 'maven'),
    tomcatHome: null,
    profiles: 'local',
    arguments: '--server.port=8081',
    startupOrder: 20,
    enabled: true,
    debugEnabled: true,
    debugPort: 5006
  });
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal(saved.workingDirectory, path.join(directory, 'orders-module'));
  assert.equal(saved.moduleWorkingDirectory, path.join(directory, 'orders-module'));
  assert.equal(saved.mainClass, 'dev.example.OrdersApplication');
  assert.match(saved.environmentVariables, /SERVER_PORT=8081/);
  assert.equal(saved.debugEnabled, true);

  const updated = database.saveProject({
    ...saved,
    name: 'Orders',
    enabled: false,
    workingDirectory: MODULE_WORKING_DIR_MACRO
  });
  assert.equal(updated.name, 'Orders');
  assert.equal(updated.enabled, false);
  assert.equal(updated.workingDirectory, MODULE_WORKING_DIR_MACRO);
  assert.equal(updated.moduleWorkingDirectory, path.join(directory, 'orders-module'));
  assert.equal(database.listProjects().length, 1);

  assert.throws(() => database.saveProject({
    ...saved,
    id: null,
    projectPath: path.join(directory, 'another'),
    workingDirectory: path.join(directory, 'another-module'),
    name: 'Port conflict'
  }), /Debug 端口 5006 已被/);

  const reimported = database.saveProject({ ...saved, id: null, name: 'Orders imported again' });
  assert.equal(reimported.id, saved.id);
  assert.equal(reimported.name, 'Orders imported again');
  assert.equal(database.listProjects().length, 1);

  database.setSetting('defaultJdk', path.join(directory, 'jdk'));
  assert.equal(database.getSettings().defaultJdk, path.join(directory, 'jdk'));

  database.replaceAutoTools([
    { kind: 'jdk', path: path.join(directory, 'jdk'), version: 'JDK 21.0.7' },
    { kind: 'maven', path: path.join(directory, 'maven'), version: 'Maven 3.9.9' }
  ], '2026-07-15T00:00:00.000Z');
  assert.equal(database.listTools().length, 2);
  const manual = database.saveManualTool({ kind: 'jdk', path: path.join(directory, 'jdk'), version: 'JDK 21.0.8' });
  assert.equal(manual.source, 'manual');
  database.replaceAutoTools([], '2026-07-15T00:01:00.000Z');
  assert.deepEqual(database.listTools().map((tool) => tool.version), ['JDK 21.0.8']);
  assert.equal(database.deleteManualTool(manual.id), true);
  assert.equal(database.deleteProject(saved.id), true);
  assert.equal(database.listProjects().length, 0);
});

test('migrates version 1 project rows to the new run configuration fields', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-db-migrate-'));
  const databasePath = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, project_path TEXT NOT NULL,
      source_path TEXT, artifact_path TEXT, jdk_home TEXT NOT NULL, maven_home TEXT, tomcat_home TEXT,
      profiles TEXT NOT NULL DEFAULT '', arguments TEXT NOT NULL DEFAULT '', startup_order INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1, debug_enabled INTEGER NOT NULL DEFAULT 0, debug_port INTEGER NOT NULL DEFAULT 5005,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES (
      'legacy', 'Legacy', 'spring-boot-maven', '${directory.replaceAll("'", "''")}', NULL, NULL,
      '${path.join(directory, 'jdk').replaceAll("'", "''")}', '${path.join(directory, 'maven').replaceAll("'", "''")}', NULL,
      '', '', 100, 1, 0, 5005, '2026-01-01', '2026-01-01'
    );
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const database = new AppDatabase(databasePath);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const project = database.getProject('legacy');
  assert.equal(project.workingDirectory, directory);
  assert.equal(project.moduleWorkingDirectory, directory);
  assert.equal(project.mainClass, '');
  assert.equal(project.environmentVariables, '');
  assert.equal(database.database.prepare('PRAGMA user_version').get().user_version, 4);
});

test('rejects invalid data before it reaches SQLite', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-db-invalid-'));
  const database = new AppDatabase(path.join(directory, 'app.sqlite'));
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.throws(() => database.saveProject({ name: '', type: 'unknown' }), /项目名称/);
  assert.throws(() => database.setSetting('', 'value'), /设置名称/);
});
