'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectSpringBootProject } = require('../src/main/project-inspector');

test('finds runnable Spring Boot applications but excludes library modules', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-inspect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'pom.xml'), `
    <project><artifactId>demo-root</artifactId><packaging>pom</packaging><modules>
      <module>core</module><module>orders-service</module><module>admin-service</module>
    </modules></project>
  `);
  createModule(root, 'core', 'CoreApplication', false);
  createModule(root, 'orders-service', 'OrdersApplication', true);
  createModule(root, 'admin-service', 'AdminApplication', true);

  const inspected = await inspectSpringBootProject(root);
  assert.equal(inspected.name, path.basename(root));
  assert.deepEqual(inspected.applications.map((application) => application.name).sort(), [
    'AdminApplication', 'OrdersApplication'
  ]);
  assert.ok(inspected.applications.every((application) => application.moduleName.endsWith('-service')));
  assert.ok(inspected.applications.every((application) => !application.mainClass.includes('CoreApplication')));
  assert.deepEqual(inspected.modules.map((module) => module.name), [
    'demo-root', 'core', 'orders-service', 'admin-service'
  ]);
});

function createModule(root, moduleName, className, runnable) {
  const modulePath = path.join(root, moduleName);
  const sourcePath = path.join(modulePath, 'src/main/java/dev/example');
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.writeFileSync(path.join(modulePath, 'pom.xml'), `
    <project><parent><groupId>dev.example</groupId><artifactId>demo-root</artifactId></parent>
    <artifactId>${moduleName}</artifactId><build><plugins>
      ${runnable ? '<plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin>' : ''}
    </plugins></build></project>
  `);
  fs.writeFileSync(path.join(sourcePath, `${className}.java`), `
    package dev.example;
    @SpringBootApplication
    public class ${className} {
      public static void main(String[] args) { SpringApplication.run(${className}.class, args); }
    }
  `);
}
