"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");
const installerPath = path.join(repositoryRoot, "bin", "install.js");
const synchronizerTemplatePath = path.join(repositoryRoot, "scripts", "sync-plugin-versions.js");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function trackFixture(root, relativePaths, { force = false } = {}) {
  const arguments_ = ["add"];
  if (force) arguments_.push("--force");
  arguments_.push("--", ...relativePaths);
  execFileSync("git", arguments_, { cwd: root });
}

function runInstaller(root) {
  const result = spawnSync(process.execPath, [installerPath], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runInstallerWithoutAssertion(root) {
  return spawnSync(process.execPath, [installerPath], {
    cwd: root,
    encoding: "utf8",
  });
}

test("copies the plugin version synchronizer when a plugin fixture is detected", (t) => {
  const root = createFixture(t);
  const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, '{ "name": "fictional-claude", "version": "0.1.0" }\n');
  trackFixture(root, [".claude-plugin/plugin.json"]);

  runInstaller(root);

  assert.equal(fs.existsSync(path.join(root, "scripts", "sync-plugin-versions.js")), true);
});

test("does not copy the plugin version synchronizer for a non-plugin fixture", (t) => {
  const root = createFixture(t);
  fs.writeFileSync(path.join(root, "README.md"), "Fictitious non-plugin repository\n");

  runInstaller(root);

  assert.equal(fs.existsSync(path.join(root, "scripts", "sync-plugin-versions.js")), false);
});

test("removes an unchanged managed synchronizer when tracked plugin metadata is absent", (t) => {
  const root = createFixture(t);
  const installedPath = path.join(root, "scripts", "sync-plugin-versions.js");
  fs.mkdirSync(path.dirname(installedPath), { recursive: true });
  fs.copyFileSync(synchronizerTemplatePath, installedPath);

  const result = runInstaller(root);

  assert.equal(fs.existsSync(installedPath), false);
  assert.match(result.stdout, /sync-plugin-versions\.js.*removido/i);
});

test("preserves and warns about a modified synchronizer when tracked plugin metadata is absent", (t) => {
  const root = createFixture(t);
  const installedPath = path.join(root, "scripts", "sync-plugin-versions.js");
  const customizedContent = "// Fictitious customized synchronizer\n";
  fs.mkdirSync(path.dirname(installedPath), { recursive: true });
  fs.writeFileSync(installedPath, customizedContent);

  const result = runInstaller(root);

  assert.equal(fs.readFileSync(installedPath, "utf8"), customizedContent);
  assert.match(result.stdout, /WARN.*sync-plugin-versions\.js.*modificado/i);
});

test("does not enable plugin-only installation for untracked or ignored manifests", (t) => {
  const root = createFixture(t);
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
  const untrackedManifest = path.join(root, ".claude-plugin", "plugin.json");
  const ignoredManifest = path.join(root, "ignored", ".codex-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(untrackedManifest), { recursive: true });
  fs.mkdirSync(path.dirname(ignoredManifest), { recursive: true });
  fs.writeFileSync(untrackedManifest, '{ "name": "fictional-untracked", "version": "0.1.0" }\n');
  fs.writeFileSync(ignoredManifest, '{ "name": "fictional-ignored", "version": "0.1.0" }\n');
  trackFixture(root, [".gitignore"]);

  runInstaller(root);

  assert.equal(fs.existsSync(path.join(root, "scripts", "sync-plugin-versions.js")), false);
});

test("detects plugin metadata in hidden directories while excluding .git and node_modules", (t) => {
  const root = createFixture(t);
  const hiddenManifest = path.join(root, ".hidden", ".claude-plugin", "plugin.json");
  const dependencyManifest = path.join(root, "node_modules", "fictional-package", ".claude-plugin", "plugin.json");
  const gitManifest = path.join(root, ".git", "fictional-plugin", ".claude-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(hiddenManifest), { recursive: true });
  fs.mkdirSync(path.dirname(dependencyManifest), { recursive: true });
  fs.mkdirSync(path.dirname(gitManifest), { recursive: true });
  fs.writeFileSync(hiddenManifest, '{ "name": "fictional-hidden", "version": "0.1.0" }\n');
  fs.writeFileSync(dependencyManifest, '{ "name": "fictional-dependency", "version": "0.1.0" }\n');
  fs.writeFileSync(gitManifest, '{ "name": "fictional-git", "version": "0.1.0" }\n');
  trackFixture(root, [".hidden/.claude-plugin/plugin.json"]);
  trackFixture(root, ["node_modules/fictional-package/.claude-plugin/plugin.json"], { force: true });

  runInstaller(root);

  assert.equal(fs.existsSync(path.join(root, "scripts", "sync-plugin-versions.js")), true);
});

test("does not detect plugin metadata located only in .git or node_modules", (t) => {
  const root = createFixture(t);
  const dependencyManifest = path.join(root, "node_modules", "fictional-package", ".claude-plugin", "plugin.json");
  const gitManifest = path.join(root, ".git", "fictional-plugin", ".claude-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(dependencyManifest), { recursive: true });
  fs.mkdirSync(path.dirname(gitManifest), { recursive: true });
  fs.writeFileSync(dependencyManifest, '{ "name": "fictional-dependency", "version": "0.1.0" }\n');
  fs.writeFileSync(gitManifest, '{ "name": "fictional-git", "version": "0.1.0" }\n');
  trackFixture(root, ["node_modules/fictional-package/.claude-plugin/plugin.json"], { force: true });

  runInstaller(root);

  assert.equal(fs.existsSync(path.join(root, "scripts", "sync-plugin-versions.js")), false);
});

test("rejects a symlinked scripts destination without writing outside the repository", (t) => {
  const root = createFixture(t);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-installer-outside-"));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, '{ "name": "fictional-claude", "version": "0.1.0" }\n');
  trackFixture(root, [".claude-plugin/plugin.json"]);

  try {
    fs.symlinkSync(outsideRoot, path.join(root, "scripts"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`Symbolic links are unavailable: ${error.code || error.message}`);
    return;
  }

  const result = runInstallerWithoutAssertion(root);

  assert.notEqual(result.status, 0, result.stdout || result.stderr);
  assert.equal(fs.existsSync(path.join(outsideRoot, "sync-plugin-versions.js")), false);
  assert.match(result.stderr, /symbolic link|symlink/i);
});
