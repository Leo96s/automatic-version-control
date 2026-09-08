"use strict";

const assert = require("node:assert/strict");
const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");
const installerPath = path.join(repositoryRoot, "bin", "install.js");
const actionTemplatePath = path.join(
  repositoryRoot,
  ".github",
  "actions",
  "skip-duplicate-run",
  "action.yml",
);

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-skip-duplicate-run-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function runInstaller(root) {
  return spawnSync(process.execPath, [installerPath], { cwd: root, encoding: "utf8" });
}

test("the action wraps fkirc/skip-duplicate-actions and exposes should_skip", () => {
  const action = fs.readFileSync(actionTemplatePath, "utf8");

  assert.match(action, /uses: fkirc\/skip-duplicate-actions@v5/);
  assert.match(action, /skip_after_successful_duplicate:\s*'true'/);
  assert.match(action, /do_not_skip:.*pull_request/);
  assert.match(action, /should_skip:\s*\r?\n\s*description:.*\r?\n\s*value: \$\{\{ steps\.skip_check\.outputs\.should_skip \}\}/);
});

test("installs the skip-duplicate-run action unconditionally, even without package.json", (t) => {
  const root = createFixture(t);

  const result = runInstaller(root);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const installedPath = path.join(root, ".github", "actions", "skip-duplicate-run", "action.yml");
  assert.equal(fs.existsSync(installedPath), true);
  assert.equal(fs.readFileSync(installedPath, "utf8"), fs.readFileSync(actionTemplatePath, "utf8"));
});

test("re-running the installer replaces a customized copy, like versioning.yml", (t) => {
  const root = createFixture(t);
  const installedPath = path.join(root, ".github", "actions", "skip-duplicate-run", "action.yml");
  fs.mkdirSync(path.dirname(installedPath), { recursive: true });
  fs.writeFileSync(installedPath, "# customized copy\n");

  const result = runInstaller(root);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(installedPath, "utf8"), fs.readFileSync(actionTemplatePath, "utf8"));
  assert.match(result.stdout, /OK\s+\.github\/actions\/skip-duplicate-run\/action\.yml \(substituído pela versão mais recente\)/);
});
