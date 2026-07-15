'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const INCLUDED_EXTENSIONS = new Set([
  '.java', '.kt', '.kts', '.groovy', '.scala', '.xml', '.properties', '.yml', '.yaml', '.sql', '.jsp', '.html', '.css', '.js'
]);
const INCLUDED_NAMES = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']);
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.idea', '.gradle', '.mvn', 'node_modules', 'target', 'build', 'out', 'logs', 'temp', 'work'
]);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function listSourceFiles(project) {
  const root = path.resolve(project.projectPath);
  const files = [];
  const queue = [root];
  let queueIndex = 0;
  while (queueIndex < queue.length && files.length < MAX_FILES) {
    const directory = queue[queueIndex++];
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push(absolute);
        }
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        const relative = path.relative(root, absolute);
        files.push({
          path: relative,
          name: entry.name,
          language: languageFor(entry.name)
        });
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return { root, files, truncated: files.length >= MAX_FILES };
}

async function readSourceFile(project, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 4096) {
    throw new Error('源码路径无效');
  }
  const root = await fs.realpath(path.resolve(project.projectPath));
  const requested = path.resolve(root, relativePath);
  if (!isInside(root, requested)) {
    throw new Error('不能读取项目目录之外的文件');
  }
  const realFile = await fs.realpath(requested);
  if (!isInside(root, realFile)) {
    throw new Error('不能读取项目目录之外的符号链接');
  }
  if (!isSourceFile(path.basename(realFile))) {
    throw new Error('不支持读取此文件类型');
  }
  const stat = await fs.stat(realFile);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw new Error('源码文件不存在或超过 2 MB');
  }
  const content = await fs.readFile(realFile, 'utf8');
  const language = languageFor(realFile);
  return {
    path: path.relative(root, realFile),
    language,
    className: language === 'java' ? javaClassName(realFile, content) : null,
    content
  };
}

function javaClassName(filePath, content) {
  const simpleName = path.basename(filePath, '.java');
  if (!/^[A-Za-z_$][\w$]*$/.test(simpleName)) return null;
  const packageName = content.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m)?.[1];
  return packageName ? `${packageName}.${simpleName}` : simpleName;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isSourceFile(name) {
  return INCLUDED_NAMES.has(name) || INCLUDED_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function languageFor(name) {
  const extension = path.extname(name).toLowerCase();
  return {
    '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.groovy': 'groovy', '.scala': 'scala',
    '.xml': 'xml', '.properties': 'properties', '.yml': 'yaml', '.yaml': 'yaml', '.sql': 'sql',
    '.jsp': 'jsp', '.html': 'html', '.css': 'css', '.js': 'javascript'
  }[extension] ?? 'text';
}

module.exports = {
  listSourceFiles,
  readSourceFile,
  isInside,
  isSourceFile,
  javaClassName
};
