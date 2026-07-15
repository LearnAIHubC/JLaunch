'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isValidTool, parseVersion, stripAnsi } = require('../src/main/toolchain');

test('recognizes tool installation layouts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runs-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jdk = path.join(root, 'jdk');
  const maven = path.join(root, 'maven');
  const tomcat = path.join(root, 'tomcat');
  for (const directory of [path.join(jdk, 'bin'), path.join(maven, 'bin'), path.join(tomcat, 'bin'), path.join(tomcat, 'lib')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const file of [path.join(jdk, 'bin', 'java'), path.join(jdk, 'bin', 'javac'), path.join(maven, 'bin', 'mvn'), path.join(tomcat, 'bin', 'catalina.sh'), path.join(tomcat, 'lib', 'catalina.jar')]) {
    fs.writeFileSync(file, 'fixture');
  }
  assert.equal(isValidTool('jdk', jdk, 'darwin'), true);
  assert.equal(isValidTool('maven', maven, 'darwin'), true);
  assert.equal(isValidTool('tomcat', tomcat, 'darwin'), true);
});

test('extracts readable versions and strips terminal colors', () => {
  assert.equal(stripAnsi('\u001b[31mApache Maven 3.9.9\u001b[0m'), 'Apache Maven 3.9.9');
  assert.equal(parseVersion('maven', 'Apache Maven 3.9.9\nMaven home: /tmp/maven', '/tmp/maven'), 'Maven 3.9.9');
  assert.equal(parseVersion('tomcat', 'Server version: Apache Tomcat/10.1.40', '/tmp/tomcat'), 'Apache Tomcat/10.1.40');
  assert.match(parseVersion('jdk', 'openjdk version "21.0.7" 2025-04-15\nOpenJDK Runtime Environment', '/tmp/jdk'), /^JDK 21\.0\.7/);
});
