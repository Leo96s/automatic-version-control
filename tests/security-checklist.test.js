"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const securityChecklist = require(path.resolve(__dirname, "..", "scripts", "security-checklist.js"));

const {
  buildReport,
  decideExitCode,
  runGitleaksDiff,
  runGitleaksFullHistory,
  runHeuristicHint,
  runHeuristicHints,
  runSemgrepBaseline,
  runSemgrepFullRepo,
  runSemgrepGithubActions,
} = securityChecklist;

function capturingExecute(result) {
  const calls = [];
  const execute = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    return result;
  };
  return { execute, calls };
}

function jsonResult(payload, exitCode = 0) {
  return { exitCode, stdout: JSON.stringify(payload), stderr: "", error: null };
}

function grepResult(matchedPaths, exitCode = matchedPaths.length > 0 ? 0 : 1) {
  return { exitCode, stdout: matchedPaths.join("\n"), stderr: "", error: null };
}

test("runGitleaksFullHistory reports clean when gitleaks finds nothing", () => {
  const execute = () => jsonResult([], 0);
  const result = runGitleaksFullHistory("/repo", execute);
  assert.deepEqual(result, { status: "clean", error: null, findings: [] });
});

test("runGitleaksFullHistory reports leaked findings", () => {
  const finding = { RuleID: "generic-api-key", File: "src/config.js", StartLine: 5, Commit: "abc123" };
  const execute = () => jsonResult([finding], 1);
  const result = runGitleaksFullHistory("/repo", execute);
  assert.equal(result.status, "leaked");
  assert.deepEqual(result.findings, [finding]);
});

test("runSemgrepFullRepo reports clean when there are no results", () => {
  const execute = () => jsonResult({ results: [] }, 0);
  const result = runSemgrepFullRepo("/repo", execute);
  assert.deepEqual(result, { status: "clean", error: null, findings: [] });
});

test("runSemgrepFullRepo reports findings when results are present", () => {
  const execute = () => jsonResult({ results: [{ check_id: "sql-injection", path: "src/db.js", start: { line: 12 }, extra: { message: "possible SQL injection" } }] }, 0);
  const result = runSemgrepFullRepo("/repo", execute);
  assert.equal(result.status, "findings");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].checkId, "sql-injection");
});

test("runSemgrepFullRepo reports an error when the tool is unavailable", () => {
  const execute = () => ({ exitCode: null, stdout: "", stderr: "", error: { message: "spawn semgrep ENOENT" } });
  const result = runSemgrepFullRepo("/repo", execute);
  assert.equal(result.status, "error");
});

test("decideExitCode: clean everything exits 0", () => {
  const status = decideExitCode({
    gitleaks: { status: "clean" },
    semgrep: { status: "clean" },
  });
  assert.equal(status, 0);
});

test("decideExitCode: findings without errors exit 1", () => {
  const status = decideExitCode({
    gitleaks: { status: "leaked" },
    semgrep: { status: "clean" },
  });
  assert.equal(status, 1);
});

test("decideExitCode: any tool error exits 2", () => {
  const status = decideExitCode({
    gitleaks: { status: "clean" },
    semgrep: { status: "error" },
  });
  assert.equal(status, 2);
});

test("buildReport includes remediation guidance only when secrets leaked", () => {
  const clean = buildReport({
    gitleaks: { status: "clean", findings: [] },
    semgrep: { status: "clean", findings: [] },
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.doesNotMatch(clean, /Remediation for leaked secrets/);
  assert.match(clean, /Out of mechanical reach/);

  const leaked = buildReport({
    gitleaks: { status: "leaked", findings: [{ RuleID: "generic-api-key", File: "src/config.js", StartLine: 5, Commit: "abc123" }] },
    semgrep: { status: "clean", findings: [] },
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(leaked, /Remediation for leaked secrets/);
  assert.match(leaked, /git filter-repo/);
  assert.match(leaked, /Out of mechanical reach/);
});

test("buildReport always names the practices out of mechanical reach", () => {
  const report = buildReport({
    gitleaks: { status: "error", error: "gitleaks not found", findings: [] },
    semgrep: { status: "error", error: "semgrep not found", findings: [] },
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(report, /Row Level Security/);
  assert.match(report, /mass assignment/);
  assert.match(report, /Rate limiting/);
});

test("runHeuristicHint reports found with the matched files when git grep finds a match", () => {
  const execute = () => grepResult(["db/migrations/0001_init.sql"]);
  const result = runHeuristicHint({ id: "rls", pattern: "ENABLE ROW LEVEL SECURITY" }, "/repo", execute);
  assert.deepEqual(result, {
    id: "rls",
    status: "found",
    error: null,
    files: ["db/migrations/0001_init.sql"],
  });
});

test("runHeuristicHint reports not-found when git grep exits 1 (no matches)", () => {
  const execute = () => grepResult([]);
  const result = runHeuristicHint({ id: "rls", pattern: "ENABLE ROW LEVEL SECURITY" }, "/repo", execute);
  assert.deepEqual(result, { id: "rls", status: "not-found", error: null, files: [] });
});

test("runHeuristicHint reports an error when git is unavailable", () => {
  const execute = () => ({ exitCode: null, stdout: "", stderr: "", error: { message: "spawn git ENOENT" } });
  const result = runHeuristicHint({ id: "rls", pattern: "ENABLE ROW LEVEL SECURITY" }, "/repo", execute);
  assert.equal(result.status, "error");
});

test("runHeuristicHint reports an error for an unexpected git grep exit code", () => {
  const execute = () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository", error: null });
  const result = runHeuristicHint({ id: "rls", pattern: "ENABLE ROW LEVEL SECURITY" }, "/repo", execute);
  assert.equal(result.status, "error");
});

test("runHeuristicHints runs one hint per definition", () => {
  const execute = () => grepResult([]);
  const results = runHeuristicHints("/repo", execute);
  assert.deepEqual(results.map((result) => result.id).sort(), ["rate-limiting", "rls", "security-headers"]);
});

test("buildReport annotates only the covered items with the heuristic hint result", () => {
  const found = buildReport({
    gitleaks: { status: "clean", findings: [] },
    semgrep: { status: "clean", findings: [] },
    hints: [{ id: "rls", status: "found", error: null, files: ["db/schema.sql"] }],
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(found, /Row Level Security.*heuristic hint: mitigation pattern found in 1 tracked file/);
  assert.doesNotMatch(found, /mass assignment.*heuristic hint/);

  const notFound = buildReport({
    gitleaks: { status: "clean", findings: [] },
    semgrep: { status: "clean", findings: [] },
    hints: [{ id: "security-headers", status: "not-found", error: null, files: [] }],
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(notFound, /security headers.*heuristic hint: no known mitigation pattern found/);

  const erroredHint = buildReport({
    gitleaks: { status: "clean", findings: [] },
    semgrep: { status: "clean", findings: [] },
    hints: [{ id: "rate-limiting", status: "error", error: "spawn git ENOENT", files: [] }],
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(erroredHint, /Rate limiting.*heuristic hint: could not check/);
});

test("heuristic hints never affect the exit code or the overall report status", () => {
  const gitleaks = { status: "clean", findings: [] };
  const semgrep = { status: "clean", findings: [] };
  const hints = [
    { id: "rls", status: "found", error: null, files: ["db/schema.sql"] },
    { id: "rate-limiting", status: "error", error: "boom", files: [] },
  ];

  assert.equal(decideExitCode({ gitleaks, semgrep }), 0);

  const report = buildReport({ gitleaks, semgrep, hints, generatedAt: "2026-01-01T00:00:00.000Z" });
  assert.match(report, /Status: \*\*CLEAN\*\*/);
});

test("runGitleaksDiff scopes gitleaks to the base..head commit range", () => {
  const { execute, calls } = capturingExecute(jsonResult([], 0));
  const result = runGitleaksDiff("/repo", "abc123", "def456", execute);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "gitleaks");
  assert.deepEqual(result, { status: "clean", error: null, findings: [] });

  const logOptsIndex = calls[0].args.indexOf("--log-opts");
  assert.notEqual(logOptsIndex, -1);
  assert.equal(calls[0].args[logOptsIndex + 1], "--all abc123..def456");
});

test("runGitleaksDiff defaults the head of the range to HEAD", () => {
  const { execute, calls } = capturingExecute(jsonResult([], 0));
  runGitleaksDiff("/repo", "abc123", undefined, execute);

  const logOptsIndex = calls[0].args.indexOf("--log-opts");
  assert.equal(calls[0].args[logOptsIndex + 1], "--all abc123..HEAD");
});

test("runGitleaksDiff still reports leaked findings and errors like the full-history scan", () => {
  const finding = { RuleID: "generic-api-key", File: "src/config.js", StartLine: 5, Commit: "abc123" };
  const leaked = runGitleaksDiff("/repo", "abc123", "HEAD", () => jsonResult([finding], 1));
  assert.equal(leaked.status, "leaked");

  const errored = runGitleaksDiff("/repo", "abc123", "HEAD", () => ({ exitCode: null, stdout: "", stderr: "", error: { message: "spawn gitleaks ENOENT" } }));
  assert.equal(errored.status, "error");
});

test("runSemgrepBaseline scopes semgrep to findings introduced since baseSha", () => {
  const { execute, calls } = capturingExecute(jsonResult({ results: [] }, 0));
  const result = runSemgrepBaseline("/repo", "abc123", execute);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "semgrep");
  assert.deepEqual(result, { status: "clean", error: null, findings: [] });

  const baselineIndex = calls[0].args.indexOf("--baseline-commit");
  assert.notEqual(baselineIndex, -1);
  assert.equal(calls[0].args[baselineIndex + 1], "abc123");
  assert.ok(calls[0].args.includes("p/security-audit"));
});

test("runSemgrepBaseline still reports findings and errors like the full-repo scan", () => {
  const findings = runSemgrepBaseline("/repo", "abc123", () => jsonResult({ results: [{ check_id: "sql-injection", path: "src/db.js", start: { line: 12 }, extra: {} }] }, 0));
  assert.equal(findings.status, "findings");

  const errored = runSemgrepBaseline("/repo", "abc123", () => ({ exitCode: null, stdout: "", stderr: "", error: { message: "spawn semgrep ENOENT" } }));
  assert.equal(errored.status, "error");
});

test("runSemgrepGithubActions targets .github with the p/github-actions ruleset", () => {
  const { execute, calls } = capturingExecute(jsonResult({ results: [] }, 0));
  const result = runSemgrepGithubActions("/repo", execute);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "semgrep");
  assert.ok(calls[0].args.includes("p/github-actions"));
  assert.ok(calls[0].args.includes(".github"));
  assert.deepEqual(result, { status: "clean", error: null, findings: [] });
});

test("runSemgrepGithubActions reports findings and errors like the other semgrep scans", () => {
  const findings = runSemgrepGithubActions("/repo", () => jsonResult({
    results: [{ check_id: "github-actions-pull-request-target", path: ".github/workflows/ci.yml", start: { line: 3 }, extra: { message: "unsafe pull_request_target usage" } }],
  }, 0));
  assert.equal(findings.status, "findings");
  assert.equal(findings.findings[0].checkId, "github-actions-pull-request-target");

  const errored = runSemgrepGithubActions("/repo", () => ({ exitCode: null, stdout: "", stderr: "", error: { message: "spawn semgrep ENOENT" } }));
  assert.equal(errored.status, "error");
});

test("decideExitCode: an actionsAudit finding or error gates the exit code too", () => {
  const gitleaks = { status: "clean" };
  const semgrep = { status: "clean" };

  assert.equal(decideExitCode({ gitleaks, semgrep, actionsAudit: { status: "findings" } }), 1);
  assert.equal(decideExitCode({ gitleaks, semgrep, actionsAudit: { status: "error" } }), 2);
  assert.equal(decideExitCode({ gitleaks, semgrep }), 0, "omitting actionsAudit keeps the previous clean behavior");
});

test("buildReport includes the GitHub Actions audit section with its own findings", () => {
  const report = buildReport({
    gitleaks: { status: "clean", findings: [] },
    semgrep: { status: "clean", findings: [] },
    actionsAudit: {
      status: "findings",
      findings: [{ checkId: "github-actions-pull-request-target", path: ".github/workflows/ci.yml", line: 3, message: "unsafe pull_request_target usage" }],
    },
    generatedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.match(report, /GitHub Actions workflow security \(semgrep p\/github-actions\): findings \(1 finding\(s\)\)/);
  assert.match(report, /github-actions-pull-request-target.*\.github\/workflows\/ci\.yml.*unsafe pull_request_target usage/);
  assert.match(report, /Status: \*\*ACTION REQUIRED\*\*/);

  const clean = buildReport({
    gitleaks: { status: "clean", findings: [] },
    semgrep: { status: "clean", findings: [] },
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(clean, /GitHub Actions workflow security \(semgrep p\/github-actions\): clean/);
});
