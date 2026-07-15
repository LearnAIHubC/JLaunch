'use strict';

const MODULE_WORKING_DIR_MACRO = '$MODULE_WORKING_DIR$';

function resolveWorkingDirectory(project) {
  const configured = String(project?.workingDirectory ?? '').trim();
  if (configured === MODULE_WORKING_DIR_MACRO) {
    return project.moduleWorkingDirectory || project.projectPath;
  }
  return configured || project?.moduleWorkingDirectory || project?.projectPath || '';
}

module.exports = { MODULE_WORKING_DIR_MACRO, resolveWorkingDirectory };
