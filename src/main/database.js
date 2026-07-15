'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { MODULE_WORKING_DIR_MACRO } = require('./working-directory');

const PROJECT_TYPES = new Set(['spring-boot-maven', 'spring-boot-jar', 'tomcat']);
const TOOL_KINDS = new Set(['jdk', 'maven', 'tomcat']);

class AppDatabase {
  constructor(databasePath, Database = DatabaseSync) {
    this.database = new Database(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    const version = this.database.prepare('PRAGMA user_version').get().user_version;
    if (version > 4) {
      throw new Error(`数据库版本 ${version} 高于当前应用支持的版本`);
    }
    if (version === 0) {
      this.database.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('spring-boot-maven', 'spring-boot-jar', 'tomcat')),
          project_path TEXT NOT NULL,
          working_directory TEXT NOT NULL,
          module_working_directory TEXT NOT NULL,
          main_class TEXT NOT NULL DEFAULT '',
          environment_variables TEXT NOT NULL DEFAULT '',
          artifact_path TEXT,
          jdk_home TEXT NOT NULL,
          maven_home TEXT,
          tomcat_home TEXT,
          profiles TEXT NOT NULL DEFAULT '',
          arguments TEXT NOT NULL DEFAULT '',
          startup_order INTEGER NOT NULL DEFAULT 100,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          debug_enabled INTEGER NOT NULL DEFAULT 0 CHECK(debug_enabled IN (0, 1)),
          debug_port INTEGER NOT NULL DEFAULT 5005 CHECK(debug_port BETWEEN 1 AND 65535),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE tool_installations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK(kind IN ('jdk', 'maven', 'tomcat')),
          path TEXT NOT NULL,
          version TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('auto', 'manual')),
          last_seen TEXT NOT NULL,
          UNIQUE(kind, path)
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE INDEX idx_projects_startup_order ON projects(startup_order, name);
        CREATE UNIQUE INDEX idx_projects_debug_port ON projects(debug_port);
        CREATE INDEX idx_tools_kind ON tool_installations(kind, version);
        PRAGMA user_version = 4;
      `);
    }
    if (version === 1) {
      this.database.exec(`
        ALTER TABLE projects ADD COLUMN working_directory TEXT;
        ALTER TABLE projects ADD COLUMN main_class TEXT NOT NULL DEFAULT '';
        ALTER TABLE projects ADD COLUMN environment_variables TEXT NOT NULL DEFAULT '';
        UPDATE projects SET working_directory = project_path WHERE working_directory IS NULL;
        PRAGMA user_version = 2;
      `);
    }
    if (version === 1 || version === 2) {
      this.assignUniqueDebugPorts();
      this.database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_debug_port ON projects(debug_port);
        PRAGMA user_version = 3;
      `);
    }
    if (version >= 1 && version <= 3) {
      this.database.exec(`
        ALTER TABLE projects ADD COLUMN module_working_directory TEXT NOT NULL DEFAULT '';
        UPDATE projects SET module_working_directory = working_directory;
        PRAGMA user_version = 4;
      `);
    }
  }

  assignUniqueDebugPorts() {
    const rows = this.database.prepare('SELECT id, debug_port AS debugPort FROM projects ORDER BY startup_order, created_at').all();
    const used = new Set();
    const update = this.database.prepare('UPDATE projects SET debug_port = ? WHERE id = ?');
    for (const row of rows) {
      let port = row.debugPort;
      if (used.has(port)) {
        port = 5005;
        while (used.has(port) && port < 65535) port += 1;
        if (used.has(port)) throw new Error('没有可用的 Debug 端口');
        update.run(port, row.id);
      }
      used.add(port);
    }
  }

  listProjects() {
    return this.database.prepare(`
      SELECT id, name, type,
             project_path AS projectPath,
             working_directory AS workingDirectory,
             module_working_directory AS moduleWorkingDirectory,
             main_class AS mainClass,
             environment_variables AS environmentVariables,
             artifact_path AS artifactPath,
             jdk_home AS jdkHome,
             maven_home AS mavenHome,
             tomcat_home AS tomcatHome,
             profiles, arguments,
             startup_order AS startupOrder,
             enabled,
             debug_enabled AS debugEnabled,
             debug_port AS debugPort,
             created_at AS createdAt,
             updated_at AS updatedAt
      FROM projects
      ORDER BY startup_order, name COLLATE NOCASE
    `).all().map(mapProjectRow);
  }

  getProject(id) {
    const row = this.database.prepare(`
      SELECT id, name, type,
             project_path AS projectPath,
             working_directory AS workingDirectory,
             module_working_directory AS moduleWorkingDirectory,
             main_class AS mainClass,
             environment_variables AS environmentVariables,
             artifact_path AS artifactPath,
             jdk_home AS jdkHome,
             maven_home AS mavenHome,
             tomcat_home AS tomcatHome,
             profiles, arguments,
             startup_order AS startupOrder,
             enabled,
             debug_enabled AS debugEnabled,
             debug_port AS debugPort,
             created_at AS createdAt,
             updated_at AS updatedAt
      FROM projects WHERE id = ?
    `).get(id);
    return row ? mapProjectRow(row) : null;
  }

  getProjectByLocation(projectPath, moduleWorkingDirectory, mainClass) {
    const row = this.database.prepare(`
      SELECT id FROM projects
      WHERE project_path = ? AND module_working_directory = ? AND main_class = ?
      ORDER BY created_at
      LIMIT 1
    `).get(projectPath, moduleWorkingDirectory, mainClass);
    return row ? this.getProject(row.id) : null;
  }

  saveProject(input) {
    const project = normalizeProject(input);
    const existing = (project.id ? this.getProject(project.id) : null)
      ?? this.getProjectByLocation(project.projectPath, project.moduleWorkingDirectory, project.mainClass);
    const id = existing?.id ?? crypto.randomUUID();
    const portConflict = this.database.prepare('SELECT name FROM projects WHERE debug_port = ? AND id <> ? LIMIT 1')
      .get(project.debugPort, id);
    if (portConflict) {
      throw new Error(`Debug 端口 ${project.debugPort} 已被 ${portConflict.name} 使用`);
    }
    const now = new Date().toISOString();
    const createdAt = existing?.createdAt ?? now;

    this.database.prepare(`
      INSERT INTO projects (
        id, name, type, project_path, working_directory, module_working_directory, main_class, environment_variables,
        artifact_path, jdk_home, maven_home, tomcat_home,
        profiles, arguments, startup_order, enabled, debug_enabled, debug_port, created_at, updated_at
      ) VALUES (
        @id, @name, @type, @projectPath, @workingDirectory, @moduleWorkingDirectory, @mainClass, @environmentVariables,
        @artifactPath, @jdkHome, @mavenHome, @tomcatHome,
        @profiles, @arguments, @startupOrder, @enabled, @debugEnabled, @debugPort, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        project_path = excluded.project_path,
        working_directory = excluded.working_directory,
        module_working_directory = excluded.module_working_directory,
        main_class = excluded.main_class,
        environment_variables = excluded.environment_variables,
        artifact_path = excluded.artifact_path,
        jdk_home = excluded.jdk_home,
        maven_home = excluded.maven_home,
        tomcat_home = excluded.tomcat_home,
        profiles = excluded.profiles,
        arguments = excluded.arguments,
        startup_order = excluded.startup_order,
        enabled = excluded.enabled,
        debug_enabled = excluded.debug_enabled,
        debug_port = excluded.debug_port,
        updated_at = excluded.updated_at
    `).run({
      ...project,
      id,
      enabled: project.enabled ? 1 : 0,
      debugEnabled: project.debugEnabled ? 1 : 0,
      createdAt,
      updatedAt: now
    });
    return this.getProject(id);
  }

  saveProjects(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) return [];
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const projects = inputs.map((input) => this.saveProject(input));
      this.database.exec('COMMIT');
      return projects;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  deleteProject(id) {
    return this.database.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }

  listTools() {
    return this.database.prepare(`
      SELECT id, kind, path, version, source, last_seen AS lastSeen
      FROM tool_installations
      ORDER BY kind, version DESC, path COLLATE NOCASE
    `).all();
  }

  replaceAutoTools(tools, scanTime = new Date().toISOString()) {
    const upsert = this.database.prepare(`
      INSERT INTO tool_installations(kind, path, version, source, last_seen)
      VALUES (@kind, @path, @version, 'auto', @lastSeen)
      ON CONFLICT(kind, path) DO UPDATE SET
        version = excluded.version,
        last_seen = excluded.last_seen,
        source = CASE WHEN tool_installations.source = 'manual' THEN 'manual' ELSE 'auto' END
    `);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const item of tools) {
        upsert.run({ ...normalizeTool(item), lastSeen: scanTime });
      }
      this.database.prepare("DELETE FROM tool_installations WHERE source = 'auto' AND last_seen <> ?").run(scanTime);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.listTools();
  }

  saveManualTool(tool) {
    const normalized = normalizeTool(tool);
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO tool_installations(kind, path, version, source, last_seen)
      VALUES (@kind, @path, @version, 'manual', @lastSeen)
      ON CONFLICT(kind, path) DO UPDATE SET
        version = excluded.version,
        source = 'manual',
        last_seen = excluded.last_seen
    `).run({ ...normalized, lastSeen: now });
    return this.database.prepare(`
      SELECT id, kind, path, version, source, last_seen AS lastSeen
      FROM tool_installations WHERE kind = ? AND path = ?
    `).get(normalized.kind, normalized.path);
  }

  deleteManualTool(id) {
    return this.database.prepare("DELETE FROM tool_installations WHERE id = ? AND source = 'manual'").run(id).changes > 0;
  }

  getSettings() {
    return Object.fromEntries(this.database.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, value]));
  }

  setSetting(key, value) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 100) {
      throw new TypeError('设置名称无效');
    }
    this.database.prepare(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  close() {
    this.database.close();
  }
}

function normalizeProject(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('项目配置无效');
  }
  const name = cleanText(input.name, '项目名称', 120, true);
  const type = String(input.type ?? '');
  if (!PROJECT_TYPES.has(type)) {
    throw new TypeError('项目类型无效');
  }
  const debugPort = integer(input.debugPort, 1, 65535, 'Debug 端口');
  const projectPath = absolutePath(input.projectPath, '项目目录');
  const configuredWorkingDirectory = cleanText(input.workingDirectory, 'Working directory', 4096, false) || projectPath;
  const workingDirectory = configuredWorkingDirectory === MODULE_WORKING_DIR_MACRO
    ? MODULE_WORKING_DIR_MACRO
    : absolutePath(configuredWorkingDirectory, 'Working directory');
  const moduleWorkingDirectory = optionalAbsolutePath(input.moduleWorkingDirectory)
    ?? (workingDirectory === MODULE_WORKING_DIR_MACRO ? projectPath : workingDirectory);
  return {
    id: typeof input.id === 'string' && input.id.length <= 64 ? input.id : null,
    name,
    type,
    projectPath,
    workingDirectory,
    moduleWorkingDirectory,
    mainClass: cleanText(input.mainClass, '主类', 500, false),
    environmentVariables: cleanText(input.environmentVariables, '环境变量', 20_000, false),
    artifactPath: optionalAbsolutePath(input.artifactPath),
    jdkHome: absolutePath(input.jdkHome, 'JDK 目录'),
    mavenHome: optionalAbsolutePath(input.mavenHome),
    tomcatHome: optionalAbsolutePath(input.tomcatHome),
    profiles: cleanText(input.profiles, 'Profiles', 500, false),
    arguments: cleanText(input.arguments, '启动参数', 4000, false),
    startupOrder: integer(input.startupOrder, -100000, 100000, '启动顺序'),
    enabled: input.enabled !== false,
    debugEnabled: input.debugEnabled === true,
    debugPort
  };
}

function normalizeTool(input) {
  if (!input || !TOOL_KINDS.has(input.kind)) {
    throw new TypeError('工具类型无效');
  }
  return {
    kind: input.kind,
    path: absolutePath(input.path, '工具目录'),
    version: cleanText(input.version, '工具版本', 300, true)
  };
}

function mapProjectRow(row) {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    debugEnabled: Boolean(row.debugEnabled)
  };
}

function cleanText(value, label, maxLength, required) {
  const text = String(value ?? '').trim();
  if (required && !text) {
    throw new TypeError(`${label}不能为空`);
  }
  if (text.length > maxLength) {
    throw new TypeError(`${label}不能超过 ${maxLength} 个字符`);
  }
  return text;
}

function absolutePath(value, label) {
  const text = cleanText(value, label, 4096, true);
  if (!path.isAbsolute(text)) {
    throw new TypeError(`${label}必须是绝对路径`);
  }
  return path.normalize(text);
}

function optionalAbsolutePath(value) {
  const text = String(value ?? '').trim();
  return text ? absolutePath(text, '文件路径') : null;
}

function integer(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return number;
}

module.exports = {
  AppDatabase,
  normalizeProject
};
