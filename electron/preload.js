'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response?.ok) {
    throw new Error(response?.error || '操作失败');
  }
  return response.value;
}

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('javaRuns', {
  platform: process.platform,
  bootstrap: () => invoke('app:bootstrap'),
  projects: {
    list: () => invoke('projects:list'),
    inspect: (projectPath) => invoke('projects:inspect', projectPath),
    save: (project) => invoke('projects:save', project),
    import: (projects) => invoke('projects:import', projects),
    delete: (projectId) => invoke('projects:delete', projectId),
    reveal: (projectId) => invoke('projects:reveal', projectId)
  },
  dialogs: {
    chooseDirectory: (initialPath) => invoke('dialog:choose-directory', initialPath),
    chooseJar: (initialPath) => invoke('dialog:choose-jar', initialPath)
  },
  toolchains: {
    scan: () => invoke('toolchains:scan'),
    add: (kind) => invoke('toolchains:add', kind),
    remove: (toolId) => invoke('toolchains:remove', toolId)
  },
  settings: {
    set: (key, value) => invoke('settings:set', key, value)
  },
  processes: {
    start: (projectId, mode) => invoke('process:start', projectId, mode),
    stop: (projectId) => invoke('process:stop', projectId),
    restart: (projectId) => invoke('process:restart', projectId),
    startAll: () => invoke('process:start-all'),
    stopAll: () => invoke('process:stop-all'),
    startProject: (projectPath) => invoke('process:start-project', projectPath),
    stopProject: (projectPath) => invoke('process:stop-project', projectPath),
    onState: (listener) => subscribe('process:state', listener),
    onLog: (listener) => subscribe('process:log', listener),
    onSequence: (listener) => subscribe('process:sequence', listener)
  },
  debug: {
    getState: (projectId) => invoke('debug:get-state', projectId),
    listBreakpoints: (projectId) => invoke('debug:list-breakpoints', projectId),
    setBreakpoint: (projectId, relativePath, line) => invoke('debug:set-breakpoint', projectId, relativePath, line),
    clearBreakpoint: (projectId, className, line) => invoke('debug:clear-breakpoint', projectId, className, line),
    resume: (projectId) => invoke('debug:resume', projectId),
    onState: (listener) => subscribe('debug:state', listener),
    onBreakpoints: (listener) => subscribe('debug:breakpoints', listener)
  },
  maven: {
    run: (request) => invoke('maven:run', request),
    stop: () => invoke('maven:stop'),
    onState: (listener) => subscribe('maven:state', listener),
    onLog: (listener) => subscribe('maven:log', listener)
  },
  source: {
    list: (projectId) => invoke('source:list', projectId),
    read: (projectId, relativePath) => invoke('source:read', projectId, relativePath)
  }
});
