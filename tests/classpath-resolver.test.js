'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { MavenClasspathResolver } = require('../src/main/classpath-resolver');

test('builds an IDEA-style classpath with reactor classes before Maven dependencies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-classpath-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const application = path.join(root, 'application');
  const core = path.join(root, 'core');
  const maven = path.join(root, 'maven');
  const jdk = path.join(root, 'jdk');
  for (const directory of [
    path.join(application, 'target', 'classes'), path.join(core, 'target', 'classes'),
    path.join(maven, 'bin'), path.join(jdk, 'bin')
  ]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(maven, 'bin', 'mvn'), 'fixture');
  fs.writeFileSync(path.join(root, 'pom.xml'), `
    <project><artifactId>demo</artifactId><modules><module>core</module><module>application</module></modules></project>
  `);
  fs.writeFileSync(path.join(core, 'pom.xml'), '<project><artifactId>core</artifactId></project>');
  fs.writeFileSync(path.join(application, 'pom.xml'), `
    <project><artifactId>application</artifactId><dependencies>
      <dependency><artifactId>core</artifactId></dependency>
    </dependencies></project>
  `);
  const dependencyOne = path.join(root, 'repository', 'spring.jar');
  const dependencyTwo = path.join(root, 'repository', 'logging.jar');
  const providedDependency = path.join(root, 'repository', 'tomcat-embed-jasper.jar');
  let spawnCount = 0;
  const resolver = new MavenClasspathResolver({
    platform: 'darwin',
    spawnProcess: (_command, args) => {
      spawnCount += 1;
      const outputFile = args.find((argument) => argument.startsWith('-Dmdep.outputFile=')).slice('-Dmdep.outputFile='.length);
      const scope = args.find((argument) => argument.startsWith('-DincludeScope=')).slice('-DincludeScope='.length);
      const dependencies = scope === 'runtime'
        ? [dependencyOne, dependencyTwo]
        : [dependencyOne, providedDependency];
      fs.writeFileSync(outputFile, dependencies.join(path.delimiter));
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => child.emit('close', 0));
      return child;
    }
  });
  const project = {
    type: 'spring-boot-maven',
    projectPath: root,
    workingDirectory: '$MODULE_WORKING_DIR$',
    moduleWorkingDirectory: application,
    mainClass: 'dev.example.Application',
    profiles: 'local',
    mavenHome: maven,
    jdkHome: jdk
  };

  const prepared = await resolver.prepare(project);
  assert.deepEqual(prepared.runtimeClasspath, [
    path.join(await fs.promises.realpath(application), 'target', 'classes'),
    path.join(await fs.promises.realpath(core), 'target', 'classes'),
    dependencyOne,
    dependencyTwo,
    providedDependency
  ]);
  await resolver.prepare(project);
  assert.equal(spawnCount, 2);
});
