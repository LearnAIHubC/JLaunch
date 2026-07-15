'use strict';

const api = window.javaRuns;
const { appendBoundedLog } = window.javaRunsLogBuffer;
const { filterLogLines } = window.javaRunsLogFilter;
const $ = (selector) => document.querySelector(selector);

document.documentElement.dataset.platform = api.platform;

const STATUS = {
  stopped: { label: '已停止', className: 'stopped' },
  starting: { label: '启动中', className: 'starting' },
  running: { label: '运行中', className: 'running' },
  stopping: { label: '停止中', className: 'stopping' },
  failed: { label: '启动失败', className: 'failed' }
};
const TYPE = {
  'spring-boot-maven': { label: 'Spring Boot · 直接 Java（Maven 工程）', avatarClass: '' },
  'spring-boot-jar': { label: 'Spring Boot · JAR', avatarClass: 'jar' },
  tomcat: { label: 'Tomcat', avatarClass: 'tomcat' }
};
const TOOL_GROUPS = [
  { kind: 'jdk', label: 'JDK', icon: 'JDK', setting: 'defaultJdk' },
  { kind: 'maven', label: 'Maven', icon: 'MVN', setting: 'defaultMaven' },
  { kind: 'tomcat', label: 'Tomcat', icon: 'TC', setting: 'defaultTomcat' }
];
const ACTIVE_STATES = new Set(['starting', 'running', 'stopping']);
const MAVEN_ACTIVE_STATES = new Set(['starting', 'running', 'stopping']);
const MAVEN_LIFECYCLE = ['clean', 'validate', 'compile', 'test', 'package', 'verify', 'install', 'site', 'deploy'];
const MAX_LOG_LINES = 2_000;
const MAX_CACHED_SOURCE_FILES = 12;
const MODULE_WORKING_DIR_MACRO = '$MODULE_WORKING_DIR$';
const SOURCE_SIDEBAR_DEFAULT_WIDTH = 260;
const SOURCE_SIDEBAR_MIN_WIDTH = 180;
const SOURCE_EDITOR_MIN_WIDTH = 280;
const SOURCE_SIDEBAR_MAX_WIDTH = 720;

const state = {
  projects: [],
  tools: [],
  settings: {},
  processStates: new Map(),
  debugStates: new Map(),
  breakpoints: new Map(),
  logs: new Map(),
  selectedProjectId: null,
  activePanel: 'console',
  sourceLists: new Map(),
  sourceOpenDirectories: new Map(),
  sourceDocuments: new Map(),
  activeSourcePaths: new Map(),
  scanning: false,
  sequenceRunning: false,
  consoleRenderPending: false,
  projectNameAuto: true,
  formInspection: null,
  formInspectionGeneration: 0,
  mavenState: { status: 'idle', pid: null, moduleName: null, goal: null, startedAt: null },
  mavenLog: '',
  mavenProjectPath: null,
  mavenInspections: new Map(),
  mavenProfiles: new Map()
};

initialize();

async function initialize() {
  bindEvents();
  bindProcessEvents();
  try {
    const bootstrap = await api.bootstrap();
    state.projects = bootstrap.projects;
    state.tools = bootstrap.tools;
    state.settings = bootstrap.settings;
    state.mavenState = bootstrap.mavenState ?? state.mavenState;
    state.processStates = new Map(bootstrap.states.map((item) => [item.projectId, item]));
    state.debugStates = new Map((bootstrap.debugStates ?? []).map((item) => [item.projectId, item]));
    const remembered = localStorage.getItem('selectedProjectId');
    state.selectedProjectId = state.projects.some((project) => project.id === remembered)
      ? remembered
      : state.projects[0]?.id ?? null;
    renderAll();
    const paused = projectDebugState(state.selectedProjectId);
    if (paused.status === 'paused' && paused.paused?.relativePath) {
      await focusPausedLocation(paused.paused.relativePath);
    }
    hideLoading();
    scanTools(true);
  } catch (error) {
    hideLoading();
    toast(`初始化失败：${error.message}`, 'error', 8000);
  }
}

function bindEvents() {
  $('#add-project-button').addEventListener('click', () => openProjectDialog());
  $('#empty-add-button').addEventListener('click', () => openProjectDialog());
  $('#welcome-add-button').addEventListener('click', () => openProjectDialog());
  $('#project-search').addEventListener('input', renderProjectList);
  $('#toolchains-button').addEventListener('click', openToolchainsDialog);
  $('#maven-button').addEventListener('click', openMavenDrawer);
  $('#close-maven-button').addEventListener('click', closeMavenDrawer);
  $('#maven-project-select').addEventListener('change', () => {
    state.mavenProjectPath = $('#maven-project-select').value || null;
    if (state.mavenProjectPath) localStorage.setItem('mavenProjectPath', state.mavenProjectPath);
    loadMavenProject(false);
  });
  $('#refresh-maven-button').addEventListener('click', () => loadMavenProject(true));
  $('#stop-maven-button').addEventListener('click', stopMavenTask);
  $('#clear-maven-console').addEventListener('click', clearMavenConsole);
  $('#scan-tools-button').addEventListener('click', () => scanTools(false));
  $('#start-project-button').addEventListener('click', () => runSelected('start', 'run'));
  $('#debug-project-button').addEventListener('click', () => runSelected('start', 'debug'));
  $('#stop-project-button').addEventListener('click', () => runSelected('stop'));
  $('#restart-project-button').addEventListener('click', () => runSelected('restart'));
  $('#edit-project-button').addEventListener('click', () => openProjectDialog(selectedProject()));
  $('#delete-project-button').addEventListener('click', deleteSelectedProject);
  $('#selected-project-path').addEventListener('click', revealSelectedProject);
  $('#clear-console-button').addEventListener('click', clearSelectedConsole);
  bindLogFilterEvents('console', renderConsole);
  bindLogFilterEvents('maven', renderMavenConsole);
  $('#console-tab').addEventListener('click', () => switchPanel('console'));
  $('#source-tab').addEventListener('click', () => switchPanel('source'));
  $('#refresh-source-button').addEventListener('click', () => loadSourceList(true));
  $('#source-filter').addEventListener('input', renderSourceList);
  bindSourceResizer();
  $('#resume-debug-button').addEventListener('click', resumeDebug);
  $('#line-numbers').addEventListener('click', (event) => {
    const line = event.target.closest('.line-number');
    if (line) toggleBreakpoint(Number(line.dataset.line));
  });
  $('#line-numbers').addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    const line = event.target.closest('.line-number');
    if (!line) return;
    event.preventDefault();
    toggleBreakpoint(Number(line.dataset.line));
  });

  $('#project-type').addEventListener('change', () => {
    updateProjectFormVisibility();
    inspectProjectForForm();
  });
  $('#project-name').addEventListener('input', () => { state.projectNameAuto = false; });
  $('#project-form').addEventListener('submit', saveProjectFromForm);
  $('#open-tools-from-form').addEventListener('click', () => {
    $('#project-dialog').close();
    openToolchainsDialog();
    toast('添加工具链后，请重新打开项目配置', 'info');
  });
  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close());
  });
  document.querySelectorAll('[data-browse]').forEach((button) => {
    button.addEventListener('click', () => browseForField(button.dataset.browse));
  });
  document.querySelectorAll('[data-clear]').forEach((button) => {
    button.addEventListener('click', () => { document.getElementById(button.dataset.clear).value = ''; });
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      openProjectDialog();
    }
  });
}

function bindProcessEvents() {
  api.processes.onState((processState) => {
    state.processStates.set(processState.projectId, processState);
    renderProjectList();
    renderRunningSummary();
    if (processState.projectId === state.selectedProjectId) renderWorkspace();
  });
  api.processes.onLog((entry) => {
    appendLog(entry);
    if (entry.projectId === state.selectedProjectId && state.activePanel === 'console') scheduleConsoleRender();
  });
  api.processes.onSequence((sequence) => {
    state.sequenceRunning = sequence.status === 'starting';
    renderProjectList();
    if (sequence.status === 'complete') {
      toast(`按序启动完成，共启动 ${sequence.started.length} 个工程`, 'success');
    } else if (sequence.status === 'failed') {
      toast(sequence.message || '按序启动失败', 'error', 7000);
    }
  });
  api.maven.onState((mavenState) => {
    state.mavenState = mavenState;
    renderMavenTaskState();
  });
  api.maven.onLog((entry) => {
    appendMavenLog(entry);
    renderMavenConsole();
  });
  api.debug.onState((debugState) => {
    state.debugStates.set(debugState.projectId, debugState);
    if (debugState.projectId === state.selectedProjectId) {
      renderWorkspace();
      if (debugState.status === 'paused' && debugState.paused?.relativePath) {
        focusPausedLocation(debugState.paused.relativePath);
      }
    }
  });
  api.debug.onBreakpoints((payload) => {
    state.breakpoints.set(payload.projectId, payload.breakpoints);
    if (payload.projectId === state.selectedProjectId) updateBreakpointMarkers();
  });
}

function renderAll() {
  renderProjectList();
  renderRunningSummary();
  renderWorkspace();
  renderToolchains();
  renderMavenPanel();
}

function renderProjectList() {
  const container = $('#project-list');
  const query = $('#project-search').value.trim().toLocaleLowerCase();
  const groups = projectGroups().map((group) => {
    const groupMatches = !query
      || group.name.toLocaleLowerCase().includes(query)
      || group.projectPath.toLocaleLowerCase().includes(query);
    const projects = groupMatches ? group.projects : group.projects.filter((project) =>
      project.name.toLocaleLowerCase().includes(query)
      || TYPE[project.type].label.toLocaleLowerCase().includes(query));
    return { ...group, projects };
  }).filter((group) => group.projects.length > 0);
  container.replaceChildren();

  for (const group of groups) {
    const section = element('section', 'project-group');
    const header = element('div', 'project-group-header');
    const title = element('div', 'project-group-title');
    title.title = group.projectPath;
    title.append(element('span', 'project-group-caret', '⌄'));
    title.append(element('span', 'project-group-name', group.name));
    title.append(element('span', 'project-group-count', `${group.projects.length} 个工程`));

    const actions = element('div', 'project-group-actions');
    const states = group.projects.map((project) => projectState(project.id));
    const hasActive = states.some((item) => ACTIVE_STATES.has(item.status));
    const hasStartable = states.some((item) => !ACTIVE_STATES.has(item.status));
    const transitioning = states.some((item) => item.status === 'starting' || item.status === 'stopping');
    const start = element('button', 'project-group-action', '▶');
    start.type = 'button';
    start.title = `按顺序运行 ${group.name}`;
    start.setAttribute('aria-label', start.title);
    start.disabled = state.sequenceRunning || transitioning || !hasStartable;
    start.addEventListener('click', () => runProjectGroup(group.projectPath, 'start', start));
    const stop = element('button', 'project-group-action stop', '■');
    stop.type = 'button';
    stop.title = `停止 ${group.name} 的全部工程`;
    stop.setAttribute('aria-label', stop.title);
    stop.disabled = transitioning || !hasActive;
    stop.addEventListener('click', () => runProjectGroup(group.projectPath, 'stop', stop));
    actions.append(start, stop);
    header.append(title, actions);

    const children = element('div', 'project-group-children');
    for (const project of group.projects) children.append(createProjectCard(project));
    section.append(header, children);
    container.append(section);
  }

  $('#project-count').textContent = `${projectGroups().length} 个项目 · ${state.projects.length} 个可运行工程`;
  const noProjects = state.projects.length === 0;
  $('#sidebar-empty').classList.toggle('hidden', !noProjects);
  container.classList.toggle('hidden', noProjects);
  if (!noProjects && groups.length === 0) {
    container.append(element('div', 'source-list-message', '没有匹配的项目'));
  }
}

function createProjectCard(project) {
  const processState = projectState(project.id);
  const card = document.createElement('button');
  card.type = 'button';
  card.className = `project-card${project.id === state.selectedProjectId ? ' selected' : ''}`;
  card.dataset.type = project.type;
  card.dataset.projectId = project.id;
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', String(project.id === state.selectedProjectId));

  const avatar = element('span', 'project-card-avatar', projectInitials(project.name));
  const body = element('span', 'project-card-body');
  body.append(element('span', 'project-card-name', project.name));
  const meta = element('span', 'project-card-meta');
  meta.append(element('span', 'project-card-order', String(project.startupOrder)));
  meta.append(document.createTextNode(shortType(project.type)));
  if (processState.runMode === 'debug') meta.append(element('span', 'debug-mini', `• Debug :${project.debugPort}`));
  body.append(meta);
  const status = element('span', `project-card-status ${processState.status}`);
  status.title = STATUS[processState.status]?.label ?? processState.status;
  card.append(avatar, body, status);
  card.addEventListener('click', () => selectProject(project.id));
  return card;
}

function renderWorkspace() {
  const project = selectedProject();
  $('#welcome-state').classList.toggle('hidden', Boolean(project));
  $('#project-workspace').classList.toggle('hidden', !project);
  if (!project) return;

  const processState = projectState(project.id);
  const debugMode = processState.runMode === 'debug';
  const debugState = projectDebugState(project.id);
  const status = STATUS[processState.status] ?? STATUS.stopped;
  const type = TYPE[project.type];
  $('#selected-project-name').textContent = project.name;
  $('#selected-project-type').textContent = type.label;
  const workingDirectory = resolvedWorkingDirectory(project);
  $('#selected-project-path').textContent = workingDirectory;
  $('#selected-project-path').title = project.workingDirectory === MODULE_WORKING_DIR_MACRO
    ? `${MODULE_WORKING_DIR_MACRO} → ${workingDirectory}\n点击在文件管理器中打开`
    : `Working directory：${workingDirectory}\n点击在文件管理器中打开`;
  $('#project-avatar').textContent = projectInitials(project.name);
  $('#project-avatar').className = `project-avatar ${type.avatarClass}`;
  $('#selected-project-status').textContent = status.label;
  $('#selected-project-status').className = `status-pill ${status.className}`;
  $('#selected-project-debug').classList.toggle('hidden', !debugMode);
  $('#selected-project-debug').textContent = debugState.status === 'paused'
    ? `DEBUG 已暂停 :${project.debugPort}`
    : `DEBUG :${project.debugPort}`;

  $('#runtime-status').textContent = status.label;
  $('#runtime-pid').textContent = processState.pid ?? '—';
  $('#runtime-started').textContent = processState.startedAt ? formatDateTime(processState.startedAt) : '—';
  $('#debug-runtime').classList.toggle('hidden', !debugMode);
  $('#runtime-debug-port').textContent = `localhost:${project.debugPort}`;

  const active = ACTIVE_STATES.has(processState.status);
  const transitioning = processState.status === 'starting' || processState.status === 'stopping';
  $('#start-project-button').classList.toggle('hidden', active);
  $('#debug-project-button').classList.toggle('hidden', active);
  $('#stop-project-button').classList.toggle('hidden', !active);
  $('#stop-project-button').disabled = processState.status === 'stopping';
  $('#restart-project-button').disabled = transitioning;
  $('#edit-project-button').disabled = active;
  $('#delete-project-button').disabled = active;

  $('#source-tab').classList.toggle('hidden', !debugMode);
  if (!debugMode && state.activePanel === 'source') state.activePanel = 'console';
  updatePanelVisibility();
  updateDebugToolbar();
  renderConsole();
  renderConsoleState(processState.status);
  if (state.activePanel === 'source') loadSourceList(false);
}

function renderRunningSummary() {
  const states = state.projects.map((project) => projectState(project.id));
  const running = states.filter((item) => item.status === 'running').length;
  const busy = states.some((item) => item.status === 'starting' || item.status === 'stopping');
  const failed = states.some((item) => item.status === 'failed');
  const dot = $('.sidebar-footer .status-dot');
  dot.className = `status-dot ${busy ? 'busy' : running ? 'running' : failed ? 'failed' : 'neutral'}`;
  $('#running-summary').textContent = running ? `${running} 个进程正在运行` : busy ? '正在处理进程…' : '没有运行中的进程';
}

function renderConsole() {
  const project = selectedProject();
  if (!project) return;
  const output = $('#console-output');
  const log = state.logs.get(project.id) ?? '';
  const filter = readLogFilter('console');
  const filtered = filterLogLines(log, filter.query, filter);
  renderLogFilterState('console', filter, filtered);
  if (log) {
    if (filtered.text) output.textContent = filtered.text;
    else output.replaceChildren(element('span', 'console-placeholder', '没有匹配的日志。'));
  } else {
    output.replaceChildren(element('span', 'console-placeholder', '启动项目后，日志会显示在这里。'));
  }
  if ($('#autoscroll-checkbox').checked) output.scrollTop = output.scrollHeight;
}

function bindLogFilterEvents(prefix, render) {
  $(`#${prefix}-filter`).addEventListener('input', render);
  $(`#${prefix}-filter-regex`).addEventListener('change', render);
  $(`#${prefix}-filter-case-sensitive`).addEventListener('change', render);
  $(`#clear-${prefix}-filter`).addEventListener('click', () => clearLogFilter(prefix, render));
}

function readLogFilter(prefix) {
  return {
    query: $(`#${prefix}-filter`).value,
    regex: $(`#${prefix}-filter-regex`).checked,
    caseSensitive: $(`#${prefix}-filter-case-sensitive`).checked
  };
}

function renderLogFilterState(prefix, filter, filtered) {
  const summary = $(`#${prefix}-filter-summary`);
  const hasFilter = Boolean(filter.query.trim());
  summary.textContent = filtered.error
    ? filtered.error
    : hasFilter ? `显示 ${filtered.matched} / ${filtered.total} 行` : `共 ${filtered.total} 行`;
  summary.classList.toggle('error', Boolean(filtered.error));
  $(`#clear-${prefix}-filter`).disabled = !hasFilter && !filter.regex && !filter.caseSensitive;
}

function renderConsoleState(statusName) {
  const status = STATUS[statusName] ?? STATUS.stopped;
  $('#console-label').textContent = statusName === 'stopped' ? '等待启动' : status.label;
  $('#console-dot').className = `status-dot ${statusName === 'running' ? 'running' : ['starting', 'stopping'].includes(statusName) ? 'busy' : statusName === 'failed' ? 'failed' : 'neutral'}`;
}

function scheduleConsoleRender() {
  if (state.consoleRenderPending) return;
  state.consoleRenderPending = true;
  requestAnimationFrame(() => {
    state.consoleRenderPending = false;
    renderConsole();
  });
}

function appendLog(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  const tag = entry.stream === 'stderr' ? 'ERR' : entry.stream === 'system' ? 'SYS' : 'OUT';
  const prefix = `${time}  ${tag}  `;
  const normalized = String(entry.text).replace(/\r/g, '').replace(/\n+$/, '');
  if (!normalized) return;
  const lines = normalized.split('\n');
  const formatted = lines.map((line, index) => index === 0 ? `${prefix}${line}` : `${' '.repeat(prefix.length)}${line}`).join('\n');
  state.logs.set(entry.projectId, appendBoundedLog(
    state.logs.get(entry.projectId) ?? '',
    `${formatted}\n`,
    MAX_LOG_LINES,
    '[JLaunch] 已丢弃超过 2,000 行的较早日志。'
  ));
}

function bindSourceResizer() {
  const resizer = $('#source-resizer');
  const remembered = Number(localStorage.getItem('sourceSidebarWidth'));
  setSourceSidebarWidth(Number.isFinite(remembered) && remembered > 0 ? remembered : SOURCE_SIDEBAR_DEFAULT_WIDTH, false);

  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    $('#source-panel').classList.add('resizing');
    document.body.classList.add('source-resizing');
    resizeSourceSidebarFromPointer(event.clientX);
  });
  resizer.addEventListener('pointermove', (event) => {
    if (resizer.hasPointerCapture(event.pointerId)) resizeSourceSidebarFromPointer(event.clientX);
  });
  const finishResize = (event) => {
    if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
    $('#source-panel').classList.remove('resizing');
    document.body.classList.remove('source-resizing');
  };
  const clearResizeState = () => {
    $('#source-panel').classList.remove('resizing');
    document.body.classList.remove('source-resizing');
  };
  resizer.addEventListener('pointerup', finishResize);
  resizer.addEventListener('pointercancel', finishResize);
  resizer.addEventListener('lostpointercapture', clearResizeState);
  window.addEventListener('blur', clearResizeState);
  resizer.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const current = sourceSidebarWidth();
    const step = event.shiftKey ? 40 : 10;
    setSourceSidebarWidth(current + (event.key === 'ArrowRight' ? step : -step));
  });
  window.addEventListener('resize', clampSourceSidebarWidth);
}

function resizeSourceSidebarFromPointer(clientX) {
  const panel = $('#source-panel');
  setSourceSidebarWidth(clientX - panel.getBoundingClientRect().left);
}

function sourceSidebarBounds() {
  const panelWidth = $('#source-panel').clientWidth;
  const availableMaximum = panelWidth > 0
    ? panelWidth - SOURCE_EDITOR_MIN_WIDTH - $('#source-resizer').offsetWidth
    : SOURCE_SIDEBAR_MAX_WIDTH;
  return {
    minimum: SOURCE_SIDEBAR_MIN_WIDTH,
    maximum: Math.max(SOURCE_SIDEBAR_MIN_WIDTH, Math.min(SOURCE_SIDEBAR_MAX_WIDTH, availableMaximum))
  };
}

function sourceSidebarWidth() {
  const value = Number.parseFloat(getComputedStyle($('#source-panel')).getPropertyValue('--source-sidebar-width'));
  return Number.isFinite(value) ? value : SOURCE_SIDEBAR_DEFAULT_WIDTH;
}

function setSourceSidebarWidth(width, persist = true) {
  const bounds = sourceSidebarBounds();
  const next = Math.round(Math.min(bounds.maximum, Math.max(bounds.minimum, width)));
  $('#source-panel').style.setProperty('--source-sidebar-width', `${next}px`);
  const resizer = $('#source-resizer');
  resizer.setAttribute('aria-valuemin', String(bounds.minimum));
  resizer.setAttribute('aria-valuemax', String(Math.round(bounds.maximum)));
  resizer.setAttribute('aria-valuenow', String(next));
  if (persist) localStorage.setItem('sourceSidebarWidth', String(next));
}

function clampSourceSidebarWidth() {
  if ($('#source-panel').classList.contains('hidden')) return;
  setSourceSidebarWidth(sourceSidebarWidth());
}

function switchPanel(panel) {
  const project = selectedProject();
  if (panel === 'source' && projectState(project?.id).runMode !== 'debug') return;
  state.activePanel = panel;
  updatePanelVisibility();
  if (panel === 'source') loadSourceList(false);
}

function updatePanelVisibility() {
  const sourceActive = state.activePanel === 'source';
  $('#console-tab').classList.toggle('active', !sourceActive);
  $('#console-tab').setAttribute('aria-selected', String(!sourceActive));
  $('#source-tab').classList.toggle('active', sourceActive);
  $('#source-tab').setAttribute('aria-selected', String(sourceActive));
  $('#console-panel').classList.toggle('hidden', sourceActive);
  $('#source-panel').classList.toggle('hidden', !sourceActive);
  if (sourceActive) {
    requestAnimationFrame(clampSourceSidebarWidth);
  } else {
    $('#source-panel').classList.remove('resizing');
    document.body.classList.remove('source-resizing');
  }
}

async function loadSourceList(force) {
  const project = selectedProject();
  if (!project || projectState(project.id).runMode !== 'debug') return;
  await loadProjectBreakpoints(project.id);
  const cached = state.sourceLists.get(project.id);
  if (cached?.loading || (cached?.files && !force)) {
    renderSourceList();
    return;
  }
  state.sourceLists.set(project.id, { loading: true, files: cached?.files ?? [] });
  renderSourceList();
  try {
    const result = await api.source.list(project.id);
    state.sourceLists.set(project.id, { ...result, loading: false });
  } catch (error) {
    state.sourceLists.set(project.id, { loading: false, files: [], error: error.message });
  }
  renderSourceList();
}

function renderSourceList() {
  const project = selectedProject();
  if (!project) return;
  const container = $('#source-file-list');
  const source = state.sourceLists.get(project.id);
  container.replaceChildren();
  if (!source || source.loading) {
    container.append(element('div', 'source-list-message', '正在扫描源码…'));
    return;
  }
  if (source.error) {
    container.append(element('div', 'source-list-message', source.error));
    return;
  }
  const query = $('#source-filter').value.trim().toLocaleLowerCase();
  const files = source.files.filter((file) => file.path.toLocaleLowerCase().includes(query));
  if (files.length === 0) {
    container.append(element('div', 'source-list-message', query ? '没有匹配的文件' : '没有找到可显示的源码文件'));
    return;
  }
  const tree = buildSourceTree(files);
  for (const child of sortedSourceNodes(tree.children.values())) {
    container.append(renderSourceNode(child, 0, Boolean(query), project));
  }
  if (source.truncated) {
    container.append(element('div', 'source-list-message', '文件较多，仅显示前 5000 个'));
  }
}

function buildSourceTree(files) {
  const root = { children: new Map() };
  for (const file of files) {
    const segments = file.path.split(/[\\/]/).filter(Boolean);
    let parent = root;
    const directoryParts = [];
    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      if (isFile) {
        parent.children.set(`file:${segment}`, { type: 'file', name: segment, file });
        return;
      }
      directoryParts.push(segment);
      const key = `directory:${segment}`;
      if (!parent.children.has(key)) {
        parent.children.set(key, {
          type: 'directory',
          name: segment,
          path: directoryParts.join('/'),
          children: new Map()
        });
      }
      parent = parent.children.get(key);
    });
  }
  return root;
}

function sortedSourceNodes(nodes) {
  return [...nodes].sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function renderSourceNode(node, depth, searching, project) {
  if (node.type === 'file') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `source-file${state.activeSourcePaths.get(project.id) === node.file.path ? ' active' : ''}`;
    button.append(element('span', 'source-file-icon', node.file.language.slice(0, 2).toUpperCase()));
    button.append(element('span', 'source-file-name', node.file.name));
    button.title = node.file.path;
    button.addEventListener('click', () => openSourceFile(node.file.path));
    return button;
  }

  const details = element('details', 'source-tree-directory');
  const openDirectories = sourceOpenDirectories(project.id);
  details.open = searching || openDirectories.has(node.path) || depth < 2;
  const summary = document.createElement('summary');
  summary.append(element('span', 'source-directory-icon', '▸'));
  summary.append(element('span', 'source-directory-name', node.name));
  summary.title = node.path;
  details.append(summary);
  const children = element('div', 'source-tree-children');
  for (const child of sortedSourceNodes(node.children.values())) {
    children.append(renderSourceNode(child, depth + 1, searching, project));
  }
  details.append(children);
  details.addEventListener('toggle', () => {
    if (details.open) openDirectories.add(node.path);
    else openDirectories.delete(node.path);
  });
  return details;
}

function sourceOpenDirectories(projectId) {
  if (!state.sourceOpenDirectories.has(projectId)) state.sourceOpenDirectories.set(projectId, new Set());
  return state.sourceOpenDirectories.get(projectId);
}

function revealSourcePath(projectId, relativePath) {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  const openDirectories = sourceOpenDirectories(projectId);
  for (let index = 1; index < segments.length; index++) {
    openDirectories.add(segments.slice(0, index).join('/'));
  }
}

async function openSourceFile(relativePath) {
  const project = selectedProject();
  if (!project) return;
  state.activeSourcePaths.set(project.id, relativePath);
  revealSourcePath(project.id, relativePath);
  renderSourceList();
  $('#editor-file-name').textContent = '正在读取…';
  $('#editor-empty').classList.remove('hidden');
  $('#code-scroll').classList.add('hidden');
  const cacheKey = `${project.id}\0${relativePath}`;
  try {
    let document = state.sourceDocuments.get(cacheKey);
    if (!document) {
      document = await api.source.read(project.id, relativePath);
      cacheSourceDocument(cacheKey, document);
    }
    if (state.selectedProjectId !== project.id || state.activeSourcePaths.get(project.id) !== relativePath) return;
    $('#editor-file-name').textContent = document.path;
    $('#editor-language').textContent = document.language;
    renderSourceDocument(document);
    $('#editor-empty').classList.add('hidden');
    $('#code-scroll').classList.remove('hidden');
    $('#code-scroll').scrollTop = 0;
    $('#code-scroll').scrollLeft = 0;
  } catch (error) {
    $('#editor-file-name').textContent = relativePath;
    $('#editor-empty').replaceChildren(element('div', '', '!'), element('span', '', error.message));
    toast(error.message, 'error');
  }
}

function renderSourceDocument(document) {
  const lines = document.content.split('\n');
  const numbers = $('#line-numbers');
  const code = $('#code-content');
  numbers.replaceChildren();
  code.replaceChildren();
  lines.forEach((text, index) => {
    const lineNumber = index + 1;
    const number = element('span', 'line-number', String(lineNumber));
    number.dataset.line = String(lineNumber);
    if (document.className) {
      number.tabIndex = 0;
      number.setAttribute('role', 'button');
      number.setAttribute('aria-label', `切换第 ${lineNumber} 行断点`);
    } else {
      number.classList.add('disabled');
    }
    const codeLine = element('span', 'code-line', text || '\u00a0');
    codeLine.dataset.line = String(lineNumber);
    numbers.append(number);
    code.append(codeLine);
  });
  updateBreakpointMarkers();
}

async function loadProjectBreakpoints(projectId) {
  if (state.breakpoints.has(projectId)) return;
  try {
    state.breakpoints.set(projectId, await api.debug.listBreakpoints(projectId));
  } catch (error) {
    toast(`读取断点失败：${error.message}`, 'error');
  }
}

async function toggleBreakpoint(line) {
  const project = selectedProject();
  const relativePath = project && state.activeSourcePaths.get(project.id);
  if (!project || !relativePath || !Number.isInteger(line)) return;
  const document = state.sourceDocuments.get(`${project.id}\0${relativePath}`);
  if (!document?.className) {
    toast('当前断点调试仅支持 Java 源文件', 'info');
    return;
  }
  const breakpoints = state.breakpoints.get(project.id) ?? [];
  const existing = breakpoints.find((item) => item.relativePath === relativePath && item.line === line);
  try {
    if (existing) {
      await api.debug.clearBreakpoint(project.id, existing.className, existing.line);
      state.breakpoints.set(project.id, breakpoints.filter((item) => item !== existing));
    } else {
      const saved = await api.debug.setBreakpoint(project.id, relativePath, line);
      state.breakpoints.set(project.id, [...breakpoints, saved]);
    }
    updateBreakpointMarkers();
  } catch (error) {
    toast(`设置断点失败：${error.message}`, 'error', 7000);
  }
}

function updateBreakpointMarkers() {
  const project = selectedProject();
  if (!project) return;
  const relativePath = state.activeSourcePaths.get(project.id);
  const breakpoints = state.breakpoints.get(project.id) ?? [];
  const paused = projectDebugState(project.id).paused;
  document.querySelectorAll('.line-number').forEach((node) => {
    const line = Number(node.dataset.line);
    const breakpoint = breakpoints.find((item) => item.relativePath === relativePath && item.line === line);
    const isPaused = paused?.relativePath === relativePath && paused.line === line;
    node.classList.toggle('breakpoint', Boolean(breakpoint));
    node.classList.toggle('breakpoint-error', breakpoint?.status === 'error');
    node.classList.toggle('paused', isPaused);
    node.title = breakpoint?.message || (breakpoint ? `${breakpoint.className}:${breakpoint.line}` : '点击切换断点');
  });
  document.querySelectorAll('.code-line').forEach((node) => {
    node.classList.toggle('paused', paused?.relativePath === relativePath && paused.line === Number(node.dataset.line));
  });
}

async function focusPausedLocation(relativePath) {
  const project = selectedProject();
  if (!project || projectDebugState(project.id).status !== 'paused') return;
  state.activePanel = 'source';
  updatePanelVisibility();
  await loadSourceList(false);
  await openSourceFile(relativePath);
  const paused = projectDebugState(project.id).paused;
  const line = paused && document.querySelector(`.code-line[data-line="${paused.line}"]`);
  if (line) {
    const scroll = $('#code-scroll');
    scroll.scrollTop = Math.max(0, line.offsetTop - scroll.clientHeight / 2);
  }
}

async function resumeDebug() {
  const project = selectedProject();
  if (!project) return;
  $('#resume-debug-button').disabled = true;
  try {
    const debugState = await api.debug.resume(project.id);
    state.debugStates.set(project.id, debugState);
    updateDebugToolbar();
    updateBreakpointMarkers();
  } catch (error) {
    toast(`继续运行失败：${error.message}`, 'error');
  } finally {
    $('#resume-debug-button').disabled = false;
  }
}

function updateDebugToolbar() {
  const project = selectedProject();
  if (!project) return;
  const debugState = projectDebugState(project.id);
  const labels = {
    disconnected: '调试器未连接',
    connecting: '正在连接调试器…',
    attached: '调试器已连接',
    paused: `已暂停 · ${debugState.paused?.threadName ?? '线程'}`,
    error: debugState.message || '调试器连接失败'
  };
  const status = $('#debug-connection-status');
  status.textContent = labels[debugState.status] ?? debugState.status;
  status.className = `debug-connection-status ${debugState.status}`;
  status.title = debugState.message || '';
  $('#resume-debug-button').classList.toggle('hidden', debugState.status !== 'paused');
  updateBreakpointMarkers();
}

function selectProject(projectId) {
  if (state.selectedProjectId === projectId) return;
  state.selectedProjectId = projectId;
  localStorage.setItem('selectedProjectId', projectId);
  state.activeSourcePaths.delete(projectId);
  const project = selectedProject();
  if (projectState(project?.id).runMode !== 'debug') state.activePanel = 'console';
  $('#source-filter').value = '';
  resetEditorPlaceholder();
  renderProjectList();
  renderWorkspace();
}

function openProjectDialog(project = null) {
  const dialog = $('#project-dialog');
  if (dialog.open) return;
  state.formInspectionGeneration += 1;
  state.formInspection = null;
  $('#project-dialog-title').textContent = project ? '编辑项目' : '添加项目';
  $('#save-project-button').textContent = '保存项目';
  $('#project-form-error').classList.add('hidden');
  $('#project-form-error').textContent = '';
  $('#project-id').value = project?.id ?? '';
  $('#project-name').value = project?.name ?? '';
  state.projectNameAuto = !project;
  $('#project-type').value = project?.type ?? 'spring-boot-maven';
  $('#project-path').value = project?.projectPath ?? '';
  $('#working-directory').value = project?.workingDirectory ?? project?.projectPath ?? '';
  $('#project-main-class').value = project?.mainClass ?? '';
  $('#project-environment-variables').value = project?.environmentVariables ?? '';
  $('#artifact-path').value = project?.artifactPath ?? '';
  $('#project-profiles').value = project?.profiles ?? '';
  $('#project-arguments').value = project?.arguments ?? '';
  $('#project-order').value = project?.startupOrder ?? nextStartupOrder();
  $('#project-enabled').checked = project?.enabled ?? true;
  $('#project-debug').checked = false;
  $('#project-debug-port').value = project?.debugPort ?? nextDebugPort();
  populateToolSelect($('#project-jdk'), 'jdk', project?.jdkHome, state.settings.defaultJdk, true);
  populateToolSelect($('#project-maven'), 'maven', project?.mavenHome, state.settings.defaultMaven, true);
  populateToolSelect($('#project-tomcat'), 'tomcat', project?.tomcatHome, state.settings.defaultTomcat, true);
  updateProjectFormVisibility();
  renderApplicationDiscovery();
  dialog.showModal();
  setTimeout(() => $('#project-name').focus(), 0);
}

function updateProjectFormVisibility() {
  const type = $('#project-type').value;
  const isMaven = type === 'spring-boot-maven';
  const isJar = type === 'spring-boot-jar';
  const isTomcat = type === 'tomcat';
  $('#artifact-field').classList.toggle('hidden', !isJar);
  $('#maven-field').classList.toggle('hidden', !isMaven);
  $('#tomcat-field').classList.toggle('hidden', !isTomcat);
  $('#artifact-path').required = isJar;
  $('#project-maven').required = isMaven;
  $('#project-tomcat').required = isTomcat;
  const importingApplications = isApplicationImportMode();
  $('#working-directory-field').classList.toggle('hidden', importingApplications);
  $('#main-class-field').classList.toggle('hidden', !isMaven || importingApplications);
  $('#project-profiles').closest('.field').classList.toggle('hidden', isTomcat);
  $('#project-path-label').textContent = isTomcat ? 'CATALINA_BASE' : '项目目录';
  $('#project-path-help').textContent = isTomcat
    ? '目录中应包含 conf/server.xml；可与 Tomcat 安装目录相同'
    : '用于项目名称、源码浏览和配置归属';
  $('#working-directory-help').textContent = isMaven
    ? `支持 ${MODULE_WORKING_DIR_MACRO}；运行时解析为当前 Application 的 Maven 模块目录`
    : `支持 ${MODULE_WORKING_DIR_MACRO}；也可以填写绝对路径`;
  $('#arguments-label').textContent = isTomcat ? 'JVM 参数（CATALINA_OPTS）' : '程序参数';
  $('#arguments-help').textContent = isTomcat ? '例如：-Xms128m -Xmx512m' : '带空格的参数可使用引号';
  $('#debug-port-field').classList.remove('hidden');
  const requiredKindMissing = state.tools.every((tool) => tool.kind !== 'jdk')
    || (isMaven && state.tools.every((tool) => tool.kind !== 'maven'))
    || (isTomcat && state.tools.every((tool) => tool.kind !== 'tomcat'));
  $('#missing-tools').classList.toggle('hidden', !requiredKindMissing);
  renderApplicationDiscovery();
}

function populateToolSelect(select, kind, currentPath, defaultPath, required) {
  const tools = state.tools.filter((tool) => tool.kind === kind);
  select.replaceChildren();
  const placeholder = new Option(tools.length ? `选择 ${kind.toUpperCase()}` : `未找到 ${kind.toUpperCase()}`, '');
  placeholder.disabled = required;
  select.add(placeholder);
  for (const tool of tools) {
    select.add(new Option(`${tool.version} — ${tool.path}`, tool.path));
  }
  if (currentPath && !tools.some((tool) => tool.path === currentPath)) {
    select.add(new Option(`已配置 — ${currentPath}`, currentPath));
  }
  const selected = currentPath || defaultPath || tools[0]?.path || '';
  select.value = selected;
}

async function saveProjectFromForm(event) {
  event.preventDefault();
  const form = $('#project-form');
  if (!form.reportValidity()) return;
  const type = $('#project-type').value;
  const existingProject = state.projects.find((item) => item.id === $('#project-id').value);
  const configuredWorkingDirectory = $('#working-directory').value.trim();
  const moduleWorkingDirectory = configuredWorkingDirectory === MODULE_WORKING_DIR_MACRO
    ? (existingProject?.moduleWorkingDirectory || resolvedWorkingDirectory(existingProject) || $('#project-path').value)
    : configuredWorkingDirectory;
  const project = {
    id: $('#project-id').value || null,
    name: $('#project-name').value,
    type,
    projectPath: $('#project-path').value,
    workingDirectory: configuredWorkingDirectory,
    moduleWorkingDirectory,
    mainClass: type === 'spring-boot-maven' ? $('#project-main-class').value : '',
    environmentVariables: $('#project-environment-variables').value,
    artifactPath: type === 'spring-boot-jar' ? $('#artifact-path').value : null,
    jdkHome: $('#project-jdk').value,
    mavenHome: type === 'spring-boot-maven' ? $('#project-maven').value : null,
    tomcatHome: type === 'tomcat' ? $('#project-tomcat').value : null,
    profiles: type === 'tomcat' ? '' : $('#project-profiles').value,
    arguments: $('#project-arguments').value,
    startupOrder: Number($('#project-order').value),
    enabled: $('#project-enabled').checked,
    debugEnabled: false,
    debugPort: Number($('#project-debug-port').value)
  };
  const button = $('#save-project-button');
  button.disabled = true;
  button.textContent = '正在保存…';
  try {
    const importingApplications = isApplicationImportMode();
    let savedProjects;
    if (importingApplications) {
      const applications = state.formInspection.data.applications;
      const selectedLocations = new Set(applications.map((application) => application.workingDirectory));
      const usedDebugPorts = new Set(state.projects
        .filter((item) => !(item.projectPath === project.projectPath && selectedLocations.has(resolvedWorkingDirectory(item))))
        .map((item) => item.debugPort));
      let debugPort = project.debugPort;
      const projects = applications.map((application, index) => {
        const startupOrder = project.startupOrder + index * 10;
        if (startupOrder > 100000) throw new Error('批量导入后的启动顺序不能超过 100000');
        const existing = state.projects.find((item) => item.projectPath === project.projectPath
          && resolvedWorkingDirectory(item) === application.workingDirectory);
        let assignedDebugPort = existing?.debugPort ?? debugPort;
        while (usedDebugPorts.has(assignedDebugPort) && assignedDebugPort <= 65535) assignedDebugPort += 1;
        if (assignedDebugPort > 65535) throw new Error('没有可用的 Debug 端口');
        const input = {
          ...project,
          id: existing?.id ?? null,
          name: application.name,
          workingDirectory: existing?.workingDirectory ?? MODULE_WORKING_DIR_MACRO,
          moduleWorkingDirectory: application.workingDirectory,
          mainClass: application.mainClass,
          environmentVariables: existing?.environmentVariables || project.environmentVariables,
          jdkHome: existing?.jdkHome || project.jdkHome,
          mavenHome: existing?.mavenHome || project.mavenHome,
          profiles: existing?.profiles || project.profiles,
          arguments: existing?.arguments || project.arguments,
          startupOrder: existing?.startupOrder ?? startupOrder,
          enabled: existing?.enabled ?? project.enabled,
          debugEnabled: false,
          debugPort: assignedDebugPort
        };
        usedDebugPorts.add(assignedDebugPort);
        debugPort = assignedDebugPort + 1;
        return input;
      });
      savedProjects = await api.projects.import(projects);
    } else {
      savedProjects = [await api.projects.save(project)];
    }
    for (const saved of savedProjects) {
      const index = state.projects.findIndex((item) => item.id === saved.id);
      if (index >= 0) state.projects[index] = saved;
      else state.projects.push(saved);
      state.sourceLists.delete(saved.id);
    }
    sortProjects();
    state.selectedProjectId = savedProjects[0].id;
    localStorage.setItem('selectedProjectId', savedProjects[0].id);
    dialogClose('#project-dialog');
    renderAll();
    toast(savedProjects.length > 1
      ? `已导入 ${savedProjects.length} 个可运行工程`
      : `${savedProjects[0].name} 已保存`, 'success');
  } catch (error) {
    const errorBox = $('#project-form-error');
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
    errorBox.scrollIntoView({ block: 'nearest' });
  } finally {
    button.disabled = false;
    if (isApplicationImportMode()) updateImportButtonLabel();
    else button.textContent = '保存项目';
  }
}

async function browseForField(fieldId) {
  const field = document.getElementById(fieldId);
  const previousPath = field.value;
  try {
    const selected = fieldId === 'artifact-path'
      ? await api.dialogs.chooseJar(field.value)
      : await api.dialogs.chooseDirectory(field.value);
    if (selected) applySelectedDirectory(fieldId, selected, previousPath);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function applySelectedDirectory(fieldId, selected, previousPath = '') {
  document.getElementById(fieldId).value = selected;
  if (fieldId !== 'project-path') return;
  if (state.projectNameAuto || !$('#project-name').value.trim()) {
    $('#project-name').value = directoryName(selected);
    state.projectNameAuto = true;
  }
  const workingDirectory = $('#working-directory');
  if (!workingDirectory.value || workingDirectory.value === previousPath) {
    workingDirectory.value = selected;
  }
  inspectProjectForForm(selected);
}

async function inspectProjectForForm(projectPath = $('#project-path').value) {
  const eligible = !$('#project-id').value && $('#project-type').value === 'spring-boot-maven' && projectPath;
  const generation = ++state.formInspectionGeneration;
  if (!eligible) {
    state.formInspection = null;
    updateProjectFormVisibility();
    return;
  }
  state.formInspection = { projectPath, loading: true, data: null, error: null };
  renderApplicationDiscovery();
  try {
    const data = await api.projects.inspect(projectPath);
    if (generation !== state.formInspectionGeneration || $('#project-path').value !== projectPath) return;
    state.formInspection = { projectPath, loading: false, data, error: null };
    if (state.projectNameAuto || !$('#project-name').value.trim()) {
      $('#project-name').value = data.name;
      state.projectNameAuto = true;
    }
  } catch (error) {
    if (generation !== state.formInspectionGeneration) return;
    state.formInspection = { projectPath, loading: false, data: null, error: error.message };
  }
  updateProjectFormVisibility();
}

function renderApplicationDiscovery() {
  const section = $('#application-discovery');
  const eligible = !$('#project-id').value
    && $('#project-type').value === 'spring-boot-maven'
    && Boolean($('#project-path').value);
  section.classList.toggle('hidden', !eligible);
  if (!eligible) return;
  const inspection = state.formInspection;
  const list = $('#application-discovery-list');
  const spinner = $('#application-discovery-spinner');
  list.replaceChildren();
  spinner.classList.toggle('hidden', !inspection?.loading);
  if (!inspection || inspection.loading) {
    $('#application-discovery-summary').textContent = '正在识别项目中的启动类…';
    list.append(element('div', 'application-discovery-empty', '正在扫描 Maven 模块和 Spring Boot 启动类'));
    return;
  }
  if (inspection.error) {
    $('#application-discovery-summary').textContent = '识别失败';
    list.append(element('div', 'application-discovery-empty', inspection.error));
    return;
  }
  const applications = inspection.data.applications;
  $('#application-discovery-summary').textContent = applications.length
    ? `已自动识别 ${applications.length} 个 Application，保存时会一次性全部添加；库模块不会加入运行列表`
    : '没有找到同时包含 Spring Boot 插件和启动类的工程';
  if (applications.length === 0) {
    list.append(element('div', 'application-discovery-empty', '可以继续使用下方工作目录和主类手动添加。'));
    return;
  }
  for (const application of applications) {
    const choice = element('div', 'application-choice');
    const details = element('span');
    details.append(element('strong', '', application.name));
    details.append(element('small', '', `Working directory: ${application.relativePath} · ${application.mainClass}`));
    choice.append(element('span', 'application-choice-mark', '✓'), details);
    list.append(choice);
  }
  updateImportButtonLabel();
}

function updateImportButtonLabel() {
  if (!isApplicationImportMode()) return;
  const count = state.formInspection.data.applications.length;
  $('#save-project-button').textContent = `添加项目（自动导入 ${count} 个工程）`;
}

function isApplicationImportMode() {
  return !$('#project-id').value
    && $('#project-type').value === 'spring-boot-maven'
    && Boolean(state.formInspection?.data?.applications.length);
}

function openMavenDrawer() {
  $('#maven-drawer').classList.remove('hidden');
  $('#maven-button').classList.add('active');
  $('#maven-button').setAttribute('aria-expanded', 'true');
  renderMavenPanel();
  loadMavenProject(false);
}

function closeMavenDrawer() {
  $('#maven-drawer').classList.add('hidden');
  $('#maven-button').classList.remove('active');
  $('#maven-button').setAttribute('aria-expanded', 'false');
}

function renderMavenPanel() {
  renderMavenProjectSelect();
  renderMavenTree();
  renderMavenTaskState();
  renderMavenConsole();
}

function renderMavenProjectSelect() {
  const select = $('#maven-project-select');
  const groups = mavenProjectGroups();
  const preferred = selectedProject()?.type === 'spring-boot-maven'
    ? selectedProject().projectPath
    : localStorage.getItem('mavenProjectPath');
  if (!groups.some((group) => group.projectPath === state.mavenProjectPath)) {
    state.mavenProjectPath = groups.some((group) => group.projectPath === preferred)
      ? preferred
      : groups[0]?.projectPath ?? null;
  }
  select.replaceChildren();
  if (groups.length === 0) {
    select.add(new Option('没有已配置的 Maven 项目', ''));
    select.disabled = true;
    return;
  }
  for (const group of groups) {
    select.add(new Option(`${group.name} · ${group.projects.length} 个 Application`, group.projectPath));
  }
  select.value = state.mavenProjectPath;
  select.disabled = MAVEN_ACTIVE_STATES.has(state.mavenState.status);
}

async function loadMavenProject(force) {
  const projectPath = state.mavenProjectPath;
  if (!projectPath) {
    renderMavenTree();
    return;
  }
  const cached = state.mavenInspections.get(projectPath);
  if (cached?.loading || (cached?.data && !force)) {
    renderMavenTree();
    return;
  }
  state.mavenInspections.set(projectPath, { loading: true, data: cached?.data ?? null, error: null });
  renderMavenTree();
  try {
    const data = await api.projects.inspect(projectPath);
    state.mavenInspections.set(projectPath, { loading: false, data, error: null });
    if (!state.mavenProfiles.has(projectPath)) {
      const configured = mavenProjectGroups().find((group) => group.projectPath === projectPath)
        ?.projects.find((project) => project.profiles)?.profiles ?? '';
      state.mavenProfiles.set(projectPath, new Set(configured.split(',').map((item) => item.trim()).filter(Boolean)));
    }
  } catch (error) {
    state.mavenInspections.set(projectPath, { loading: false, data: null, error: error.message });
  }
  if (state.mavenProjectPath === projectPath) renderMavenTree();
}

function renderMavenTree() {
  const container = $('#maven-tree');
  container.replaceChildren();
  const projectPath = state.mavenProjectPath;
  if (!projectPath) {
    container.append(element('div', 'maven-tree-message', '先添加一个 Spring Boot Maven 项目。'));
    return;
  }
  const inspection = state.mavenInspections.get(projectPath);
  if (!inspection || inspection.loading) {
    container.append(element('div', 'maven-tree-message', '正在加载 Maven 项目结构…'));
    return;
  }
  if (inspection.error) {
    container.append(element('div', 'maven-tree-message', `加载失败：${inspection.error}`));
    return;
  }

  const profiles = [...new Set(inspection.data.modules.flatMap((module) => module.profiles))];
  const profileSection = element('details', 'maven-section maven-profile-section');
  profileSection.open = profiles.length > 0;
  profileSection.append(element('summary', '', `Profiles${profiles.length ? ` · ${profiles.length}` : ''}`));
  const profileList = element('div', 'maven-profile-list');
  if (profiles.length === 0) {
    profileList.append(element('div', 'maven-profile-empty', '没有定义 Maven Profile'));
  } else {
    const selectedProfiles = state.mavenProfiles.get(projectPath) ?? new Set();
    for (const profile of profiles) {
      const label = element('label', 'maven-profile');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedProfiles.has(profile);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedProfiles.add(profile);
        else selectedProfiles.delete(profile);
        state.mavenProfiles.set(projectPath, selectedProfiles);
      });
      label.append(checkbox, element('span', '', profile));
      profileList.append(label);
    }
  }
  profileSection.append(profileList);
  container.append(profileSection);

  for (const module of inspection.data.modules) {
    const details = element('details', 'maven-module');
    details.open = module.relativePath === '.';
    const summary = document.createElement('summary');
    summary.append(element('span', 'maven-module-mark', 'm'));
    summary.append(element('span', '', module.name));
    summary.append(element('span', 'maven-module-path', module.relativePath));
    summary.title = module.workingDirectory;
    details.append(summary);

    const content = element('div', 'maven-module-content');
    const lifecycle = element('details', 'maven-section');
    lifecycle.open = module.relativePath === '.';
    lifecycle.append(element('summary', '', 'Lifecycle'));
    const goals = element('div', 'maven-goals');
    for (const goal of MAVEN_LIFECYCLE) {
      const button = element('button', 'maven-goal', goal);
      button.type = 'button';
      button.title = `运行 ${module.name}:${goal}`;
      button.disabled = MAVEN_ACTIVE_STATES.has(state.mavenState.status);
      button.addEventListener('click', () => runMavenGoal(module, goal));
      goals.append(button);
    }
    lifecycle.append(goals);
    content.append(lifecycle);
    details.append(content);
    container.append(details);
  }
}

function renderMavenTaskState() {
  const task = state.mavenState;
  const labels = {
    idle: 'Maven 控制台',
    starting: '正在启动',
    running: '正在运行',
    stopping: '正在停止',
    stopped: '已停止',
    complete: '执行完成',
    failed: '执行失败'
  };
  const taskName = task.moduleName && task.goal ? `${task.moduleName}:${task.goal}` : '';
  $('#maven-console-status').textContent = taskName ? `${taskName} · ${labels[task.status] ?? task.status}` : labels[task.status];
  const active = MAVEN_ACTIVE_STATES.has(task.status);
  $('#stop-maven-button').classList.toggle('hidden', !active);
  $('#stop-maven-button').disabled = task.status === 'stopping';
  $('#refresh-maven-button').disabled = active || !state.mavenProjectPath;
  $('#maven-project-select').disabled = active || mavenProjectGroups().length === 0;
  document.querySelectorAll('.maven-goal').forEach((button) => { button.disabled = active; });
  $('#maven-button').classList.toggle('task-running', active);
}

async function runMavenGoal(module, goal) {
  if (!state.mavenProjectPath || MAVEN_ACTIVE_STATES.has(state.mavenState.status)) return;
  try {
    const profiles = [...(state.mavenProfiles.get(state.mavenProjectPath) ?? [])].join(',');
    state.mavenState = await api.maven.run({
      projectPath: state.mavenProjectPath,
      workingDirectory: module.workingDirectory,
      goal,
      profiles
    });
    renderMavenTaskState();
  } catch (error) {
    toast(`Maven 执行失败：${error.message}`, 'error', 7000);
  }
}

async function stopMavenTask() {
  $('#stop-maven-button').disabled = true;
  try {
    state.mavenState = await api.maven.stop();
    renderMavenTaskState();
  } catch (error) {
    toast(`停止 Maven 失败：${error.message}`, 'error');
  }
}

function appendMavenLog(entry) {
  const text = String(entry.text).replace(/\r/g, '');
  if (!text) return;
  let addition;
  if (entry.stream === 'system') {
    const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    addition = `${time}  SYS  ${text.replace(/\n+$/, '')}\n`;
  } else {
    addition = text;
  }
  state.mavenLog = appendBoundedLog(
    state.mavenLog,
    addition,
    MAX_LOG_LINES,
    '[JLaunch] 已丢弃超过 2,000 行的较早 Maven 日志。'
  );
}

function renderMavenConsole() {
  const output = $('#maven-console-output');
  const filter = readLogFilter('maven');
  const filtered = filterLogLines(state.mavenLog, filter.query, filter);
  renderLogFilterState('maven', filter, filtered);
  if (state.mavenLog && filtered.text) output.textContent = filtered.text;
  else if (state.mavenLog) output.replaceChildren(element('span', 'console-placeholder', '没有匹配的日志。'));
  else output.replaceChildren(element('span', 'console-placeholder', '点击 Lifecycle 目标后，日志会显示在这里。'));
  output.scrollTop = output.scrollHeight;
}

function clearMavenConsole() {
  state.mavenLog = '';
  renderMavenConsole();
}

function openToolchainsDialog() {
  renderToolchains();
  const dialog = $('#toolchains-dialog');
  if (!dialog.open) dialog.showModal();
}

function renderToolchains() {
  const container = $('#tool-groups');
  if (!container) return;
  container.replaceChildren();
  for (const group of TOOL_GROUPS) {
    const tools = state.tools.filter((tool) => tool.kind === group.kind);
    const section = element('section', 'tool-group');
    const header = element('header', 'tool-group-header');
    const title = element('div', 'tool-group-title');
    title.append(element('span', 'tool-kind-icon', group.icon));
    const titleText = element('strong', '', group.label);
    titleText.append(element('span', 'tool-count', `${tools.length} 个版本`));
    title.append(titleText);
    const controls = element('div', 'tool-header-controls');
    const defaultSelect = document.createElement('select');
    defaultSelect.className = 'tool-default-select';
    defaultSelect.setAttribute('aria-label', `默认 ${group.label}`);
    defaultSelect.add(new Option(`默认 ${group.label}：自动`, ''));
    for (const tool of tools) defaultSelect.add(new Option(tool.version, tool.path));
    defaultSelect.value = state.settings[group.setting] ?? '';
    defaultSelect.addEventListener('change', () => setDefaultTool(group.setting, defaultSelect.value));
    const addButton = element('button', 'tool-add', '＋ 手动添加');
    addButton.type = 'button';
    addButton.addEventListener('click', () => addTool(group.kind));
    controls.append(defaultSelect, addButton);
    header.append(title, controls);
    section.append(header);

    const list = element('div', 'tool-list');
    if (tools.length === 0) {
      list.append(element('div', 'tool-empty', `没有发现 ${group.label}，请重新扫描或手动添加`));
    } else {
      for (const tool of tools) {
        const row = element('div', 'tool-row');
        const info = element('div', 'tool-info');
        const version = element('div', 'tool-version', tool.version);
        version.append(element('span', 'tool-source', tool.source === 'manual' ? '手动' : '自动'));
        info.append(version, element('div', 'tool-path', tool.path));
        row.append(info, element('span', 'tool-row-kind', group.label));
        if (tool.source === 'manual') {
          const remove = element('button', 'tool-remove', '×');
          remove.type = 'button';
          remove.title = '移除手动记录';
          remove.addEventListener('click', () => removeTool(tool));
          row.append(remove);
        } else {
          row.append(element('span', 'tool-remove-placeholder'));
        }
        list.append(row);
      }
    }
    section.append(list);
    container.append(section);
  }
  const counts = TOOL_GROUPS.map((group) => `${group.label} ${state.tools.filter((tool) => tool.kind === group.kind).length}`).join(' · ');
  $('#tool-scan-summary').textContent = state.scanning ? '正在搜索本机安装目录并读取版本…' : counts;
  $('#scan-tools-button').disabled = state.scanning;
  $('#scan-tools-button').textContent = state.scanning ? '扫描中…' : '↻ 重新扫描';
}

async function scanTools(silent) {
  if (state.scanning) return;
  state.scanning = true;
  renderToolchains();
  try {
    state.tools = await api.toolchains.scan();
    await chooseInitialDefaults();
    refreshOpenProjectToolSelects();
    renderToolchains();
    if (!silent) toast(`扫描完成，找到 ${state.tools.length} 个工具链`, 'success');
  } catch (error) {
    toast(`工具链扫描失败：${error.message}`, 'error', 7000);
  } finally {
    state.scanning = false;
    renderToolchains();
  }
}

async function chooseInitialDefaults() {
  for (const group of TOOL_GROUPS) {
    if (state.settings[group.setting]) continue;
    const first = state.tools.find((tool) => tool.kind === group.kind);
    if (!first) continue;
    state.settings = await api.settings.set(group.setting, first.path);
  }
}

async function setDefaultTool(setting, value) {
  try {
    state.settings = await api.settings.set(setting, value);
    renderToolchains();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function addTool(kind) {
  try {
    const tool = await api.toolchains.add(kind);
    if (!tool) return;
    const index = state.tools.findIndex((item) => item.kind === tool.kind && item.path === tool.path);
    if (index >= 0) state.tools[index] = tool;
    else state.tools.push(tool);
    renderToolchains();
    toast(`${tool.version} 已添加`, 'success');
  } catch (error) {
    toast(error.message, 'error', 7000);
  }
}

async function removeTool(tool) {
  const accepted = await confirmAction('移除工具链记录？', `只会移除 JLaunch 中的记录，不会删除磁盘上的 ${tool.version}。`, '移除');
  if (!accepted) return;
  try {
    await api.toolchains.remove(tool.id);
    state.tools = state.tools.filter((item) => item.id !== tool.id);
    renderToolchains();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runSelected(action, mode) {
  const project = selectedProject();
  if (!project) return;
  const buttons = [
    $('#start-project-button'), $('#debug-project-button'), $('#stop-project-button'), $('#restart-project-button')
  ];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    if (action === 'start') await api.processes.start(project.id, mode);
    else await api.processes[action](project.id);
    if (mode === 'debug') {
      state.activePanel = 'source';
      renderWorkspace();
      await loadSourceList(false);
    }
  } catch (error) {
    toast(error.message, 'error', 7000);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    renderWorkspace();
  }
}

async function runProjectGroup(projectPath, action, button) {
  button.disabled = true;
  if (action === 'start') {
    state.sequenceRunning = true;
    renderProjectList();
  }
  try {
    if (action === 'start') await api.processes.startProject(projectPath);
    else await api.processes.stopProject(projectPath);
    if (action === 'stop') toast(`${directoryName(projectPath)} 的工程已停止`, 'success');
  } catch (error) {
    toast(error.message, 'error', 7000);
  } finally {
    if (action === 'start') state.sequenceRunning = false;
    renderProjectList();
  }
}

async function deleteSelectedProject() {
  const project = selectedProject();
  if (!project) return;
  const accepted = await confirmAction('删除项目配置？', `“${project.name}”的配置会从 JLaunch 中删除，不会删除项目文件。`, '删除');
  if (!accepted) return;
  try {
    await api.projects.delete(project.id);
    state.projects = state.projects.filter((item) => item.id !== project.id);
    state.processStates.delete(project.id);
    state.logs.delete(project.id);
    state.selectedProjectId = state.projects[0]?.id ?? null;
    if (state.selectedProjectId) localStorage.setItem('selectedProjectId', state.selectedProjectId);
    else localStorage.removeItem('selectedProjectId');
    renderAll();
    toast('项目配置已删除', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function revealSelectedProject() {
  const project = selectedProject();
  if (!project) return;
  try { await api.projects.reveal(project.id); } catch (error) { toast(error.message, 'error'); }
}

function clearSelectedConsole() {
  const project = selectedProject();
  if (!project) return;
  state.logs.set(project.id, '');
  renderConsole();
}

function clearLogFilter(prefix, render) {
  $(`#${prefix}-filter`).value = '';
  $(`#${prefix}-filter-regex`).checked = false;
  $(`#${prefix}-filter-case-sensitive`).checked = false;
  render();
  $(`#${prefix}-filter`).focus();
}

function confirmAction(title, message, acceptLabel) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-accept').textContent = acceptLabel;
  return new Promise((resolve) => {
    const finish = (value) => {
      dialog.close();
      resolve(value);
    };
    $('#confirm-accept').onclick = () => finish(true);
    $('#confirm-cancel').onclick = () => finish(false);
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    dialog.showModal();
  });
}

function toast(message, type = 'info', duration = 4200) {
  const item = element('div', `toast ${type}`, message);
  $('#toast-region').append(item);
  setTimeout(() => item.remove(), duration);
}

function selectedProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId) ?? null;
}

function projectGroups() {
  const groups = new Map();
  for (const project of state.projects) {
    if (!groups.has(project.projectPath)) {
      groups.set(project.projectPath, {
        name: directoryName(project.projectPath),
        projectPath: project.projectPath,
        projects: []
      });
    }
    groups.get(project.projectPath).projects.push(project);
  }
  return [...groups.values()].sort((left, right) => {
    const leftOrder = Math.min(...left.projects.map((project) => project.startupOrder));
    const rightOrder = Math.min(...right.projects.map((project) => project.startupOrder));
    return leftOrder - rightOrder || left.name.localeCompare(right.name);
  });
}

function mavenProjectGroups() {
  return projectGroups().map((group) => ({
    ...group,
    projects: group.projects.filter((project) => project.type === 'spring-boot-maven')
  })).filter((group) => group.projects.length > 0);
}

function projectState(projectId) {
  return state.processStates.get(projectId)
    ?? { projectId, status: 'stopped', pid: null, startedAt: null, exitCode: null, runMode: null };
}

function projectDebugState(projectId) {
  return state.debugStates.get(projectId)
    ?? { projectId, status: 'disconnected', message: '', paused: null };
}

function nextStartupOrder() {
  return state.projects.length ? Math.max(...state.projects.map((project) => project.startupOrder)) + 10 : 100;
}

function nextDebugPort() {
  const ports = new Set(state.projects.map((project) => project.debugPort));
  let port = 5005;
  while (ports.has(port) && port < 65535) port += 1;
  return port;
}

function directoryName(value) {
  const normalized = String(value).replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).pop() || normalized;
}

function projectInitials(name) {
  const characters = String(name ?? '').match(/[\p{L}\p{N}]/gu) ?? [];
  return characters.slice(0, 2).join('').toLocaleUpperCase() || 'PR';
}

function resolvedWorkingDirectory(project) {
  if (!project) return '';
  return project.workingDirectory === MODULE_WORKING_DIR_MACRO
    ? project.moduleWorkingDirectory || project.projectPath
    : project.workingDirectory || project.moduleWorkingDirectory || project.projectPath;
}

function refreshOpenProjectToolSelects() {
  if (!$('#project-dialog').open) return;
  populateToolSelect($('#project-jdk'), 'jdk', $('#project-jdk').value, state.settings.defaultJdk, true);
  populateToolSelect($('#project-maven'), 'maven', $('#project-maven').value, state.settings.defaultMaven, true);
  populateToolSelect($('#project-tomcat'), 'tomcat', $('#project-tomcat').value, state.settings.defaultTomcat, true);
  updateProjectFormVisibility();
}

function cacheSourceDocument(key, document) {
  if (state.sourceDocuments.has(key)) state.sourceDocuments.delete(key);
  state.sourceDocuments.set(key, document);
  while (state.sourceDocuments.size > MAX_CACHED_SOURCE_FILES) {
    state.sourceDocuments.delete(state.sourceDocuments.keys().next().value);
  }
}

function sortProjects() {
  state.projects.sort((left, right) => left.startupOrder - right.startupOrder || left.name.localeCompare(right.name));
}

function shortType(type) {
  return type === 'tomcat' ? 'Tomcat' : type === 'spring-boot-jar' ? 'JAR' : 'Java';
}

function formatDateTime(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function dialogClose(selector) {
  const dialog = $(selector);
  if (dialog.open) dialog.close();
}

function resetEditorPlaceholder() {
  $('#editor-file-name').textContent = '选择一个源码文件';
  $('#editor-language').textContent = '';
  $('#editor-empty').replaceChildren(element('div', '', '</>'), element('span', '', '从左侧选择文件查看源码'));
  $('#editor-empty').classList.remove('hidden');
  $('#code-scroll').classList.add('hidden');
  $('#line-numbers').replaceChildren();
  $('#code-content').replaceChildren();
  updateDebugToolbar();
}

function hideLoading() {
  const loading = $('#loading-screen');
  loading.style.opacity = '0';
  setTimeout(() => loading.classList.add('hidden'), 200);
}
