"use strict";

const assert = require("node:assert/strict");
const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");
const installerPath = path.join(repositoryRoot, "bin", "install.js");
const workflowTemplatePath = path.join(repositoryRoot, ".github", "workflows", "npm-audit.yml");
const scriptTemplatePath = path.join(repositoryRoot, "scripts", "npm-audit.js");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-npm-audit-installer-"));
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

function track(root, relativePaths) {
  execFileSync("git", ["add", "--", ...relativePaths], { cwd: root });
}

test("installs the npm audit workflow and helper for package projects", (t) => {
  const root = createFixture(t);
  const binRoot = createFakeNodeTools(t);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fictional-project",
    version: "0.1.0",
    private: true,
  }) + "\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {},
  }) + "\n");
  track(root, ["package-lock.json"]);

  const result = runInstaller(root, binRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "npm-audit.yml")), true);
  assert.equal(fs.existsSync(path.join(root, "scripts", "npm-audit.js")), true);
  assert.match(result.stdout, /lockfiles npm rastreados.*workflow de auditoria de dependências instalado/i);
});

test("does not install the npm audit workflow for an un-locked package project", (t) => {
  const root = createFixture(t);
  const binRoot = createFakeNodeTools(t);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fictional-package-without-lock",
    version: "0.1.0",
  }) + "\n");

  const result = runInstaller(root, binRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "npm-audit.yml")), false);
  assert.equal(fs.existsSync(path.join(root, "scripts", "npm-audit.js")), false);
  assert.match(result.stdout, /SKIP workflow de auditoria npm.*lockfiles npm rastreados/i);
});

test("installs the npm audit workflow for a monorepo lockfile in a subdirectory", (t) => {
  const root = createFixture(t);
  const lockfilePath = path.join(root, "packages", "app", "package-lock.json");
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(lockfilePath, JSON.stringify({ lockfileVersion: 3, packages: {} }) + "\n");
  track(root, ["packages/app/package-lock.json"]);

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "npm-audit.yml")), true);
  assert.equal(fs.existsSync(path.join(root, "scripts", "npm-audit.js")), true);
});

test("ignores lockfiles tracked only inside node_modules", (t) => {
  const root = createFixture(t);
  const lockfilePath = path.join(root, "node_modules", "fictional-package", "package-lock.json");
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(lockfilePath, JSON.stringify({ lockfileVersion: 3, packages: {} }) + "\n");
  execFileSync("git", ["add", "--force", "--", "node_modules/fictional-package/package-lock.json"], { cwd: root });

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "npm-audit.yml")), false);
  assert.equal(fs.existsSync(path.join(root, "scripts", "npm-audit.js")), false);
});

test("removes unchanged npm audit files when package.json is absent", (t) => {
  const root = createFixture(t);
  const workflowPath = path.join(root, ".github", "workflows", "npm-audit.yml");
  const scriptPath = path.join(root, "scripts", "npm-audit.js");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.copyFileSync(workflowTemplatePath, workflowPath);
  fs.copyFileSync(scriptTemplatePath, scriptPath);

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(workflowPath), false);
  assert.equal(fs.existsSync(scriptPath), false);
});

test("preserves customized npm audit files when package.json is absent", (t) => {
  const root = createFixture(t);
  const workflowPath = path.join(root, ".github", "workflows", "npm-audit.yml");
  const scriptPath = path.join(root, "scripts", "npm-audit.js");
  const customWorkflow = "# Fictitious customized workflow\n";
  const customScript = "// Fictitious customized audit helper\n";
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(workflowPath, customWorkflow);
  fs.writeFileSync(scriptPath, customScript);

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(workflowPath, "utf8"), customWorkflow);
  assert.equal(fs.readFileSync(scriptPath, "utf8"), customScript);
  assert.match(result.stdout, /WARN.*npm-audit\.yml.*modificado/i);
  assert.match(result.stdout, /WARN.*npm-audit\.js.*modificado/i);
});
