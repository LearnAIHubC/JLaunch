'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_MODULES = 100;
const MAX_SOURCE_FILES = 3000;
const MAX_SOURCE_BYTES = 512 * 1024;

async function inspectSpringBootProject(projectPath) {
  const root = await fs.realpath(path.resolve(projectPath));
  const rootPom = path.join(root, 'pom.xml');
  if (!await isFile(rootPom)) {
    throw new Error('项目根目录中没有 pom.xml');
  }

  const modules = await collectMavenModules(root);
  const applications = [];
  for (const module of modules) {
    if (!module.hasSpringBootPlugin) continue;
    const mainClasses = await findSpringBootMainClasses(module.path);
    for (const mainClass of mainClasses) {
      applications.push({
        name: mainClass.split('.').pop(),
        mainClass,
        moduleName: module.artifactId || path.basename(module.path),
        workingDirectory: module.path,
        relativePath: path.relative(root, module.path) || '.'
      });
    }
  }

  return {
    name: path.basename(root),
    projectPath: root,
    applications,
    modules: modules.map((module) => ({
      name: module.artifactId || path.basename(module.path),
      workingDirectory: module.path,
      relativePath: path.relative(root, module.path) || '.',
      profiles: module.profiles
    }))
  };
}

async function collectMavenModules(root) {
  const realRoot = await fs.realpath(path.resolve(root));
  const modules = [];
  const queue = [realRoot];
  const visited = new Set();
  for (let index = 0; index < queue.length && modules.length < MAX_MODULES; index++) {
    const directory = queue[index];
    let realDirectory;
    try {
      realDirectory = await fs.realpath(directory);
    } catch {
      continue;
    }
    if (!isInside(realRoot, realDirectory) || visited.has(realDirectory)) continue;
    visited.add(realDirectory);
    const pomPath = path.join(realDirectory, 'pom.xml');
    let pom;
    try {
      pom = await fs.readFile(pomPath, 'utf8');
    } catch {
      continue;
    }
    const cleanPom = stripXmlComments(pom);
    modules.push({
      path: realDirectory,
      artifactId: projectArtifactId(cleanPom),
      dependencyArtifactIds: dependencyArtifactIds(cleanPom),
      hasSpringBootPlugin: /<artifactId>\s*spring-boot-maven-plugin\s*<\/artifactId>/.test(cleanPom),
      profiles: profileIds(cleanPom)
    });
    const modulesBlock = cleanPom.match(/<modules\b[^>]*>([\s\S]*?)<\/modules>/)?.[1] ?? '';
    for (const match of modulesBlock.matchAll(/<module\b[^>]*>\s*([^<]+?)\s*<\/module>/g)) {
      const child = path.resolve(realDirectory, decodeXml(match[1].trim()));
      if (isInside(realRoot, child)) queue.push(child);
    }
  }
  return modules;
}

function projectArtifactId(value) {
  return firstTag(value.replace(/<parent\b[^>]*>[\s\S]*?<\/parent>/, ''), 'artifactId');
}

function dependencyArtifactIds(value) {
  const withoutManagement = value.replace(/<dependencyManagement\b[^>]*>[\s\S]*?<\/dependencyManagement>/g, '');
  return [...withoutManagement.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g)]
    .map((match) => firstTag(match[1], 'artifactId'))
    .filter(Boolean);
}

async function findSpringBootMainClasses(modulePath) {
  const sourceRoot = path.join(modulePath, 'src', 'main');
  const queue = [sourceRoot];
  const mainClasses = [];
  let visitedFiles = 0;
  for (let index = 0; index < queue.length && visitedFiles < MAX_SOURCE_FILES; index++) {
    let entries;
    try {
      entries = await fs.readdir(queue[index], { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(queue[index], entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile() || !/\.(?:java|kt)$/.test(entry.name)) continue;
      visitedFiles += 1;
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      if (stat.size > MAX_SOURCE_BYTES) continue;
      const source = await fs.readFile(absolute, 'utf8');
      if (!/@SpringBootApplication\b/.test(source) || !/SpringApplication\.run\s*\(/.test(source)) continue;
      const packageName = source.match(/^\s*package\s+([\w.]+)\s*[;\n]/m)?.[1] ?? '';
      const className = source.match(/\b(?:public\s+)?(?:final\s+)?class\s+([A-Za-z_$][\w$]*)/)?.[1];
      if (className) mainClasses.push(packageName ? `${packageName}.${className}` : className);
    }
  }
  return [...new Set(mainClasses)].sort();
}

function stripXmlComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, '');
}

function firstTag(value, tagName) {
  return decodeXml(value.match(new RegExp(`<${tagName}\\b[^>]*>\\s*([^<]+?)\\s*</${tagName}>`))?.[1] ?? '');
}

function profileIds(value) {
  const profilesBlock = value.match(/<profiles\b[^>]*>([\s\S]*?)<\/profiles>/)?.[1] ?? '';
  return [...profilesBlock.matchAll(/<profile\b[^>]*>[\s\S]*?<id\b[^>]*>\s*([^<]+?)\s*<\/id>/g)]
    .map((match) => decodeXml(match[1].trim()));
}

function decodeXml(value) {
  return value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

module.exports = {
  inspectSpringBootProject,
  collectMavenModules,
  findSpringBootMainClasses
};
