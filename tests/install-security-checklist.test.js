"use strict";

const assert = require("node:assert/strict");
const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");
const installerPath = path.join(repositoryRoot, "bin", "install.js");
const workflowTemplatePath = path.join(repositoryRoot, ".github", "workflows", "security-checklist.yml");
const scriptTemplatePath = path.join(repositoryRoot, "scripts", "security-checklist.js");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-security-checklist-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function runInstaller(root) {
  return spawnSync(process.execPath, [installerPath], { cwd: root, encoding: "utf8" });
}

test("installs the security checklist workflow and script unconditionally, even without package.json", (t) => {
  const root = createFixture(t);

  const result = runInstaller(root);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const workflowPath = path.join(root, ".github", "workflows", "security-checklist.yml");
  const scriptPath = path.join(root, "scripts", "security-checklist.js");
  assert.equal(fs.existsSync(workflowPath), true);
  assert.equal(fs.existsSync(scriptPath), true);
  assert.equal(fs.readFileSync(workflowPath, "utf8"), fs.readFileSync(workflowTemplatePath, "utf8"));
  assert.equal(fs.readFileSync(scriptPath, "utf8"), fs.readFileSync(scriptTemplatePath, "utf8"));
});

test("re-running the installer replaces a customized copy of the workflow and script", (t) => {
  const root = createFixture(t);
  const workflowPath = path.join(root, ".github", "workflows", "security-checklist.yml");
  const scriptPath = path.join(root, "scripts", "security-checklist.js");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(workflowPath, "# customized workflow\n");
  fs.writeFileSync(scriptPath, "// customized script\n");

  const result = runInstaller(root);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(workflowPath, "utf8"), fs.readFileSync(workflowTemplatePath, "utf8"));
  assert.equal(fs.readFileSync(scriptPath, "utf8"), fs.readFileSync(scriptTemplatePath, "utf8"));
  assert.match(result.stdout, /OK\s+\.github\/workflows\/security-checklist\.yml \(substituído pela versão mais recente\)/);
  assert.match(result.stdout, /OK\s+scripts\/security-checklist\.js \(substituído pela versão mais recente\)/);
});

test("installs the security checklist for a plugin project too", (t) => {
  const root = createFixture(t);
  const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, '{ "name": "fictional-claude", "version": "0.1.0" }\n');
  execFileSync("git", ["add", "--", ".claude-plugin/plugin.json"], { cwd: root });

  const result = runInstaller(root);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "security-checklist.yml")), true);
  assert.equal(fs.existsSync(path.join(root, "scripts", "security-checklist.js")), true);
});

test("the workflow template has a diff-scoped pull_request job and audits GitHub Actions workflows", () => {
  const workflow = fs.readFileSync(workflowTemplatePath, "utf8").replace(/\r\n/g, "\n");

  assert.match(workflow, /pull_request:\n\s+branches:\n\s+- main/);
  assert.match(workflow, /checklist-pr:/);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /--diff-base "\$\{\{ steps\.merge_base\.outputs\.sha \}\}"/);
  assert.match(workflow, /git merge-base "origin\/\$\{\{ github\.event\.pull_request\.base\.ref \}\}" HEAD/);
  assert.match(workflow, /group: security-checklist-\$\{\{ github\.ref \}\}/);
});
