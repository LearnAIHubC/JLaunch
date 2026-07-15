'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeProject } = require('../src/main/database');
const { validateProject } = require('../src/main/launch');
const { discoverToolchains, inspectTool } = require('../src/main/toolchain');
const { listSourceFiles, readSourceFile } = require('../src/main/source-service');
const { inspectSpringBootProject } = require('../src/main/project-inspector');
const { ACTIVE_STATES } = require('../src/main/process-manager');
const { resolveWorkingDirectory } = require('../src/main/working-directory');

const ALLOWED_SETTINGS = new Set(['defaultJdk', 'defaultMaven', 'defaultTomcat']);
const TOOL_KIND_LABELS = { jdk: 'JDK', maven: 'Maven', tomcat: 'Tomcat' };

function registerIpc({ ipcMain, dialog, shell, database, processManager, mavenTaskManager, debugManager, getWindow }) {
  const handle = (channel, listener) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event, getWindow())) {
        return { ok: false, error: '已拒绝来自未知页面的请求' };
      }
      try {
        return { ok: true, value: await listener(...args) };
      } catch (error) {
        return { ok: false, error: publicError(error) };
      }
    });
  };

  const startManagedProject = async (project, mode) => {
    if (!['run', 'debug'].includes(mode)) throw new Error('启动模式无效');
    await debugManager.stop(project.id);
    const launchProject = { ...project, debugEnabled: mode === 'debug' };
    const state = await processManager.start(launchProject);
    if (mode !== 'debug') return state;
    try {
      await debugManager.start(launchProject);
      return processManager.getState(project.id);
    } catch (error) {
      await processManager.stop(project.id);
      throw error;
    }
  };

  handle('app:bootstrap', async () => ({
    projects: database.listProjects(),
    tools: database.listTools(),
    settings: database.getSettings(),
    states: processManager.listStates(),
    debugStates: debugManager.listStates(),
    mavenState: mavenTaskManager.getState(),
    platform: process.platform
  }));

  handle('projects:list', async () => database.listProjects());
  handle('projects:inspect', async (projectPath) => inspectSpringBootProject(projectPath));
  handle('projects:save', async (input) => {
    const normalized = normalizeProject(input);
    const active = normalized.id && processManager.getState(normalized.id);
    if (active && ACTIVE_STATES.has(active.status)) {
      throw new Error('请先停止项目，再修改运行配置');
    }
    const errors = validateProject(normalized);
    if (errors.length > 0) throw new Error(errors.join('\n'));
    return database.saveProject(normalized);
  });
  handle('projects:import', async (inputs) => {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 50) {
      throw new Error('请选择 1 到 50 个可运行工程');
    }
    const projects = inputs.map((input) => normalizeProject(input));
    for (const project of projects) {
      const active = project.id && processManager.getState(project.id);
      if (active && ACTIVE_STATES.has(active.status)) {
        throw new Error(`请先停止 ${project.name}，再更新配置`);
      }
      const errors = validateProject(project);
      if (errors.length > 0) throw new Error(`${project.name}：\n${errors.join('\n')}`);
    }
    return database.saveProjects(projects);
  });
  handle('projects:delete', async (projectId) => {
    const project = requireProject(database, projectId);
    if (ACTIVE_STATES.has(processManager.getState(project.id).status)) {
      throw new Error('请先停止项目，再删除配置');
    }
    return database.deleteProject(project.id);
  });
  handle('projects:reveal', async (projectId) => {
    const project = requireProject(database, projectId);
    const error = await shell.openPath(resolveWorkingDirectory(project));
    if (error) throw new Error(error);
    return true;
  });

  handle('dialog:choose-directory', async (initialPath) => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择目录',
      defaultPath: isDirectory(initialPath) ? initialPath : undefined,
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('dialog:choose-jar', async (initialPath) => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择 Spring Boot 可执行 JAR',
      defaultPath: isFile(initialPath) ? initialPath : undefined,
      properties: ['openFile'],
      filters: [{ name: 'Java Archive', extensions: ['jar'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('toolchains:scan', async () => {
    const existing = database.listTools();
    const projectTools = database.listProjects().flatMap((project) => [
      { kind: 'jdk', path: project.jdkHome },
      { kind: 'maven', path: project.mavenHome },
      { kind: 'tomcat', path: project.tomcatHome }
    ]).filter((tool) => tool.path);
    const tools = await discoverToolchains([...existing, ...projectTools]);
    return database.replaceAutoTools(tools);
  });
  handle('toolchains:add', async (kind) => {
    if (!(kind in TOOL_KIND_LABELS)) throw new Error('工具类型无效');
    const result = await dialog.showOpenDialog(getWindow(), {
      title: `选择 ${TOOL_KIND_LABELS[kind]} 安装目录`,
      properties: ['openDirectory']
    });
    if (result.canceled) return null;
    const jdk = database.listTools().find((tool) => tool.kind === 'jdk');
    const tool = await inspectTool(kind, result.filePaths[0], process.platform, jdk?.path);
    return database.saveManualTool(tool);
  });
  handle('toolchains:remove', async (toolId) => database.deleteManualTool(Number(toolId)));

  handle('settings:set', async (key, value) => {
    if (!ALLOWED_SETTINGS.has(key)) throw new Error('不支持的设置');
    database.setSetting(key, value ?? '');
    return database.getSettings();
  });

  handle('process:start', async (projectId, mode = 'run') => startManagedProject(requireProject(database, projectId), mode));
  handle('process:stop', async (projectId) => {
    const project = requireProject(database, projectId);
    const state = await processManager.stop(project.id);
    await debugManager.stop(project.id);
    return state;
  });
  handle('process:restart', async (projectId) => {
    const project = requireProject(database, projectId);
    const mode = processManager.getState(project.id).runMode ?? 'run';
    await processManager.stop(project.id);
    await debugManager.stop(project.id);
    return startManagedProject(project, mode);
  });
  handle('process:start-all', async () => processManager.startAll(
    database.listProjects().map((project) => ({ ...project, debugEnabled: false }))
  ));
  handle('process:stop-all', async () => {
    await processManager.stopAll();
    await debugManager.stopAll();
    return true;
  });
  handle('process:start-project', async (projectPath) => {
    const projects = requireProjectGroup(database, projectPath)
      .map((project) => ({ ...project, debugEnabled: false }));
    return processManager.startGroup(projects);
  });
  handle('process:stop-project', async (projectPath) => {
    const projects = requireProjectGroup(database, projectPath);
    await Promise.allSettled(projects.map((project) => processManager.stop(project.id)));
    await Promise.allSettled(projects.map((project) => debugManager.stop(project.id)));
    return true;
  });

  handle('maven:run', async (request) => {
    if (!request || typeof request !== 'object') throw new Error('Maven 任务无效');
    const projects = requireProjectGroup(database, request.projectPath);
    const inspected = await inspectSpringBootProject(request.projectPath);
    const module = inspected.modules.find((item) => item.workingDirectory === request.workingDirectory);
    if (!module) throw new Error('所选 Maven 工程不属于当前项目');
    const project = projects.find((item) => resolveWorkingDirectory(item) === module.workingDirectory)
      ?? projects.find((item) => item.mavenHome);
    if (!project) throw new Error('项目没有可用的 Maven/JDK 配置');
    const profiles = typeof request.profiles === 'string' && request.profiles.length <= 500 ? request.profiles : '';
    return mavenTaskManager.run({
      moduleName: module.name,
      workingDirectory: module.workingDirectory,
      goal: request.goal,
      profiles
    }, project);
  });
  handle('maven:stop', async () => mavenTaskManager.stop());

  handle('source:list', async (projectId) => {
    const project = requireDebugProject(database, processManager, projectId);
    return listSourceFiles(project);
  });
  handle('source:read', async (projectId, relativePath) => {
    const project = requireDebugProject(database, processManager, projectId);
    return readSourceFile(project, relativePath);
  });

  handle('debug:get-state', async (projectId) => {
    requireProject(database, projectId);
    return debugManager.getState(projectId);
  });
  handle('debug:list-breakpoints', async (projectId) => {
    requireProject(database, projectId);
    return debugManager.listBreakpoints(projectId);
  });
  handle('debug:set-breakpoint', async (projectId, relativePath, line) => {
    const project = requireDebugProject(database, processManager, projectId);
    const source = await readSourceFile(project, relativePath);
    if (source.language !== 'java' || !source.className) {
      throw new Error('当前断点调试仅支持 Java 源文件');
    }
    return debugManager.setBreakpoint(project.id, {
      relativePath: source.path,
      className: source.className,
      line
    });
  });
  handle('debug:clear-breakpoint', async (projectId, className, line) => {
    requireDebugProject(database, processManager, projectId);
    return debugManager.clearBreakpoint(projectId, className, line);
  });
  handle('debug:resume', async (projectId) => {
    requireDebugProject(database, processManager, projectId);
    return debugManager.resume(projectId);
  });

  const send = (channel, payload) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  };
  processManager.on('state', (payload) => {
    send('process:state', payload);
    if (!ACTIVE_STATES.has(payload.status)) debugManager.stop(payload.projectId).catch(() => {});
  });
  processManager.on('log', (payload) => send('process:log', payload));
  processManager.on('sequence', (payload) => send('process:sequence', payload));
  mavenTaskManager.on('state', (payload) => send('maven:state', payload));
  mavenTaskManager.on('log', (payload) => send('maven:log', payload));
  debugManager.on('state', (payload) => send('debug:state', payload));
  debugManager.on('breakpoints', (payload) => send('debug:breakpoints', payload));
}

function requireProject(database, projectId) {
  if (typeof projectId !== 'string' || projectId.length > 64) {
    throw new Error('项目标识无效');
  }
  const project = database.getProject(projectId);
  if (!project) throw new Error('项目不存在或已删除');
  return project;
}

function requireDebugProject(database, processManager, projectId) {
  const project = requireProject(database, projectId);
  if (processManager.getState(project.id).runMode !== 'debug') {
    throw new Error('请先使用 Debug 模式启动此工程');
  }
  return project;
}

function requireProjectGroup(database, projectPath) {
  if (typeof projectPath !== 'string' || projectPath.length > 4096) {
    throw new Error('项目路径无效');
  }
  const projects = database.listProjects().filter((project) => project.projectPath === projectPath);
  if (projects.length === 0) throw new Error('项目不存在或没有可运行工程');
  return projects;
}

function isTrustedSender(event, window) {
  return Boolean(window && !window.isDestroyed()
    && event.sender.id === window.webContents.id
    && event.senderFrame === window.webContents.mainFrame);
}

function publicError(error) {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 4000);
  }
  return '操作失败，请重试';
}

function isDirectory(value) {
  if (!value || typeof value !== 'string') return false;
  try { return fs.statSync(path.resolve(value)).isDirectory(); } catch { return false; }
}

function isFile(value) {
  if (!value || typeof value !== 'string') return false;
  try { return fs.statSync(path.resolve(value)).isFile(); } catch { return false; }
}

module.exports = { registerIpc, isTrustedSender, publicError };
