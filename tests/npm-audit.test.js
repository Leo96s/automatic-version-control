"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const audit = require(path.resolve(__dirname, "..", "scripts", "npm-audit.js"));
const workflowPath = path.resolve(__dirname, "..", ".github", "workflows", "npm-audit.yml");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-npm-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function writeLockfile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ lockfileVersion: 3, packages: {} }) + "\n");
}

function track(root, relativePaths) {
  execFileSync("git", ["add", "--", ...relativePaths], { cwd: root });
}

function auditJson({ high = 0, critical = 0, vulnerabilities = {} } = {}) {
  return JSON.stringify({
    metadata: { vulnerabilities: { low: 0, moderate: 0, high, critical } },
    vulnerabilities,
  });
}

test("discovers one audit target per tracked npm lockfile directory", (t) => {
  const root = createFixture(t);
  writeLockfile(root, "package-lock.json");
  writeLockfile(root, "packages/app/package-lock.json");
  writeLockfile(root, "node_modules/ignored/package-lock.json");
  track(root, ["package-lock.json", "packages/app/package-lock.json"]);

  const result = audit.discoverAuditTargets(root);

  assert.deepEqual(
    result.targets.map((target) => target.relativeDirectory),
    [".", "packages/app"],
  );
  assert.deepEqual(result.errors, []);
});

test("classifies high and critical findings as blocking and includes advisory details", () => {
  const result = audit.analyzeAuditOutput({
    relativeDirectory: ".",
    exitCode: 1,
    stdout: auditJson({
      high: 1,
      vulnerabilities: {
        "fictional-package": {
          severity: "high",
          nodes: ["node_modules/fictional-package"],
          fixAvailable: true,
          via: [{ title: "Fictional advisory", url: "https://example.invalid/advisory" }],
        },
      },
    }),
    stderr: "",
  });

  assert.equal(result.status, "vulnerable");
  assert.equal(result.counts.high, 1);
  assert.equal(result.findings[0].packageName, "fictional-package");

  const report = audit.buildReport({ results: [result], generatedAt: "2026-08-22T00:00:00.000Z" });
  assert.match(report, /ACTION REQUIRED/);
  assert.match(report, /Fictional advisory/);
  assert.match(report, /fictional-package/);
});

test("keeps a clean audit green when npm returns valid JSON", () => {
  const result = audit.analyzeAuditOutput({
    relativeDirectory: "packages/app",
    exitCode: 0,
    stdout: auditJson(),
    stderr: "",
  });

  assert.equal(result.status, "clean");
  assert.equal(result.counts.high, 0);
  assert.equal(result.counts.critical, 0);
});

test("reports npm execution errors instead of hiding them as a clean audit", () => {
  const result = audit.analyzeAuditOutput({
    relativeDirectory: ".",
    exitCode: 1,
    stdout: "",
    stderr: "registry unavailable",
  });

  assert.equal(result.status, "error");
  assert.match(result.error, /registry unavailable/);
});

test("returns a configuration error when no lockfile is tracked", (t) => {
  const root = createFixture(t);
  const result = audit.auditProject({ root, executeAudit: () => {
    throw new Error("must not run npm without a lockfile");
  } });

  assert.equal(result.exitCode, 2);
  assert.match(result.results[0].error, /No tracked package-lock\.json/);
});

test("keeps the audit workflow on main and gives it only issue-write access", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const script = fs.readFileSync(path.resolve(__dirname, "..", "scripts", "npm-audit.js"), "utf8");

  assert.match(workflow, /branches:\s*\r?\n\s*- main/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /issues:\s*write/);
  assert.match(script, /\['audit', '--json', '--audit-level=high'\]/);
  assert.match(workflow, /gh issue list/);
  assert.match(workflow, /gh issue edit/);
  assert.match(workflow, /gh issue create/);
  assert.match(workflow, /Fail the security gate/);
});
