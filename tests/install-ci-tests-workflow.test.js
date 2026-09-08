"use strict";

const assert = require("node:assert/strict");
const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");
const installerPath = path.join(repositoryRoot, "bin", "install.js");
const workflowTemplatePath = path.join(repositoryRoot, ".github", "workflows", "ci.yml");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-ci-tests-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function createFakeNodeTools(t) {
  const binRoot = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-fake-node-"));
  t.after(() => fs.rmSync(binRoot, { recursive: true, force: true }));

  const commandNames = process.platform === "win32"
    ? ["npm.cmd", "npx.cmd"]
    : ["npm", "npx"];
  const content = process.platform === "win32"
    ? "@echo off\r\nexit /b 0\r\n"
    : "#!/bin/sh\nexit 0\n";

  for (const commandName of commandNames) {
    const commandPath = path.join(binRoot, commandName);
    fs.writeFileSync(commandPath, content, { mode: 0o755 });
  }

  return binRoot;
}

function runInstaller(root, binRoot) {
  return spawnSync(process.execPath, [installerPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binRoot}${path.delimiter}${process.env.PATH || ""}`,
    },
  });
}

test("installs ci.yml for a root Node project with a test script", (t) => {
  const root = createFixture(t);
  const binRoot = createFakeNodeTools(t);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fictional-project",
    version: "0.1.0",
    scripts: { test: "node --test" },
  }) + "\n");

  const result = runInstaller(root, binRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "ci.yml")), true);
  assert.match(result.stdout, /Detetados testes.*ci\.yml instalado/i);
});

test("installs ci.yml for a Node test project in a first-level subdirectory", (t) => {
  const root = createFixture(t);
  const binRoot = createFakeNodeTools(t);
  const subdir = path.join(root, "GameSphere_frontend");
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, "package.json"), JSON.stringify({
    name: "frontend",
    version: "0.1.0",
    scripts: { test: "vitest run" },
  }) + "\n");

  const result = runInstaller(root, binRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "ci.yml")), true);
});

test("does not install ci.yml for a Node project without a test script", (t) => {
  const root = createFixture(t);
  const binRoot = createFakeNodeTools(t);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fictional-project-without-tests",
    version: "0.1.0",
  }) + "\n");

  const result = runInstaller(root, binRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "ci.yml")), false);
  assert.match(result.stdout, /SKIP \.github\/workflows\/ci\.yml.*não detetei testes/i);
});

test("installs ci.yml for a Gradle/Kotlin project even without package.json", (t) => {
  const root = createFixture(t);
  fs.writeFileSync(path.join(root, "gradlew"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(root, "settings.gradle.kts"), "rootProject.name = \"fictional\"\n");

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "ci.yml")), true);
});

test("installs ci.yml for a Flutter project even without package.json", (t) => {
  const root = createFixture(t);
  fs.writeFileSync(path.join(root, "pubspec.yaml"), "name: fictional\nflutter:\n  uses-material-design: true\n");
  fs.mkdirSync(path.join(root, "android"));

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "ci.yml")), true);
});

test("overwrites a customized ci.yml when a testable project is detected", (t) => {
  const root = createFixture(t);
  const binRoot = createFakeNodeTools(t);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fictional-project",
    version: "0.1.0",
    scripts: { test: "node --test" },
  }) + "\n");
  const workflowPath = path.join(root, ".github", "workflows", "ci.yml");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, "# hand-written custom pipeline, unrelated to the template\n");

  const result = runInstaller(root, binRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(workflowPath, "utf8"), fs.readFileSync(workflowTemplatePath, "utf8"));
  assert.match(result.stdout, /OK\s+\.github\/workflows\/ci\.yml \(substituído pela versão mais recente\)/);
});

test("removes an unchanged ci.yml once no testable project is detected anymore", (t) => {
  const root = createFixture(t);
  const workflowPath = path.join(root, ".github", "workflows", "ci.yml");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.copyFileSync(workflowTemplatePath, workflowPath);

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(workflowPath), false);
});

test("references the skip-duplicate-run action and covers all three stacks", () => {
  const workflow = fs.readFileSync(workflowTemplatePath, "utf8");

  assert.match(workflow, /uses: \.\/\.github\/actions\/skip-duplicate-run/);
  assert.match(workflow, /needs\.detect\.outputs\.node_dir/);
  assert.match(workflow, /needs\.detect\.outputs\.gradle_dir/);
  assert.match(workflow, /needs\.detect\.outputs\.flutter_dir/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: \.\/gradlew test/);
  assert.match(workflow, /run: flutter test/);
});
