'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const { AppDatabase } = require('../src/main/database');
const { ProcessManager } = require('../src/main/process-manager');
const { MavenTaskManager } = require('../src/main/maven-task-manager');
const { DebugManager } = require('../src/main/debug-manager');
const { MavenClasspathResolver } = require('../src/main/classpath-resolver');
const { registerIpc } = require('./ipc');

app.commandLine.removeSwitch('remote-debugging-port');

let mainWindow = null;
let database = null;
let processManager = null;
let mavenTaskManager = null;
let debugManager = null;
let shutdownStarted = false;
const rendererFile = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

app.setName('JLaunch');
app.setAppUserModelId('com.learnaihub.jlaunch');

if (singleInstance) {
  app.whenReady().then(() => {
    try {
      database = new AppDatabase(path.join(app.getPath('userData'), 'java-runs.sqlite'));
      const classpathResolver = new MavenClasspathResolver();
      processManager = new ProcessManager({ prepareProject: (project) => classpathResolver.prepare(project) });
      mavenTaskManager = new MavenTaskManager();
      debugManager = new DebugManager();
      createMainWindow();
      installMenu();
      registerIpc({
        ipcMain, dialog, shell, database, processManager, mavenTaskManager, debugManager, getWindow: () => mainWindow
      });
      mainWindow.loadFile(rendererFile).then(() => {
        mainWindow?.webContents.on('will-navigate', (event, url) => {
          if (url !== rendererUrl) event.preventDefault();
        });
      }).catch((error) => {
        dialog.showErrorBox('JLaunch 页面加载失败', error.message);
        app.quit();
      });
    } catch (error) {
      dialog.showErrorBox('JLaunch 无法启动', error.message);
      app.exit(1);
    }
  });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (event) => {
  if (shutdownStarted || !processManager) return;
  event.preventDefault();
  shutdownStarted = true;
  Promise.race([
    Promise.all([processManager.stopAll(), mavenTaskManager?.stop(), debugManager?.stopAll()]),
    new Promise((resolve) => setTimeout(resolve, 6000))
  ]).finally(() => {
    processManager.killAllImmediately();
    mavenTaskManager?.killImmediately();
    debugManager?.killImmediately();
    database?.close();
    app.quit();
  });
});

function createMainWindow() {
  const titleBarOptions = process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 25 } }
    : process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#0d1218', symbolColor: '#94a2b3', height: 64 }
        }
      : {};
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0f14',
    title: 'JLaunch',
    ...titleBarOptions,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: false
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (isDevToolsShortcut(input)) event.preventDefault();
  });
  mainWindow.webContents.on('devtools-opened', () => mainWindow?.webContents.closeDevTools());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function isDevToolsShortcut(input) {
  if (input.type !== 'keyDown') return false;
  const key = String(input.key).toLocaleLowerCase();
  if (key === 'f12') return true;
  const modifier = (input.control && input.shift) || (input.meta && input.alt);
  return modifier && ['i', 'j', 'c'].includes(key);
}

function installMenu() {
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: 'JLaunch',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }
  template.push({
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' }
    ]
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
