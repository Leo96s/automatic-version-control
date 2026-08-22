#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const LOCKFILE_PATTERNS = ['*package-lock.json', '*npm-shrinkwrap.json'];
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative));
}

function displayPath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}

function safeTrackedFile(root, relativePath) {
  if (typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.includes('\0')
    || path.isAbsolute(relativePath)
    || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error('the tracked path is not a safe relative path');
  }

  const realRoot = fs.realpathSync(root);
  const absolutePath = path.resolve(root, ...relativePath.split('/'));
  if (!isPathInside(realRoot, absolutePath)) {
    throw new Error('the tracked path escapes the repository');
  }

  const stats = fs.lstatSync(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('the tracked lockfile is not a regular file');
  }

  const realPath = fs.realpathSync(absolutePath);
  if (!isPathInside(realRoot, realPath)) {
    throw new Error('the tracked lockfile resolves outside the repository');
  }

  return absolutePath;
}

function listTrackedLockfiles(root) {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--', ...LOCKFILE_PATTERNS, ':!**/node_modules/**', ':!**/.git/**'],
    { cwd: root, encoding: 'buffer' },
  );

  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function discoverAuditTargets(root) {
  const errors = [];
  let trackedLockfiles;

  try {
    trackedLockfiles = listTrackedLockfiles(root);
  } catch (error) {
    return {
      targets: [],
      errors: [`could not list tracked npm lockfiles: ${error.message}`],
    };
  }

  const targetsByDirectory = new Map();
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch (error) {
    return {
      targets: [],
      errors: [`could not resolve the repository root: ${error.message}`],
    };
  }

  for (const relativePath of trackedLockfiles) {
    try {
      const absolutePath = safeTrackedFile(root, relativePath);
      const directory = path.dirname(absolutePath);
      const realDirectory = fs.realpathSync(directory);
      if (!isPathInside(realRoot, realDirectory)) {
        throw new Error('the lockfile directory resolves outside the repository');
      }

      const key = process.platform === 'win32' ? realDirectory.toLowerCase() : realDirectory;
      const target = targetsByDirectory.get(key) || {
        directory,
        relativeDirectory: displayPath(root, directory),
        lockfiles: [],
      };
      target.lockfiles.push(relativePath);
      targetsByDirectory.set(key, target);
    } catch (error) {
      errors.push(`${relativePath}: ${error.message}`);
    }
  }

  return {
    targets: [...targetsByDirectory.values()].sort((left, right) => (
      left.relativeDirectory.localeCompare(right.relativeDirectory)
    )),
    errors,
  };
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;

    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function summarizeVulnerabilities(auditJson) {
  const metadata = auditJson && typeof auditJson === 'object'
    ? auditJson.metadata?.vulnerabilities || {}
    : {};
  const entries = auditJson && typeof auditJson === 'object'
    && auditJson.vulnerabilities && typeof auditJson.vulnerabilities === 'object'
    ? Object.entries(auditJson.vulnerabilities)
    : [];

  const counts = {
    low: numberOrZero(metadata.low),
    moderate: numberOrZero(metadata.moderate),
    high: numberOrZero(metadata.high),
    critical: numberOrZero(metadata.critical),
  };

  for (const [, vulnerability] of entries) {
    const severity = String(vulnerability?.severity || '').toLowerCase();
    if (Object.hasOwn(counts, severity)) {
      counts[severity] = Math.max(counts[severity], 1);
    }
  }

  const findings = [];
  for (const [packageName, vulnerability] of entries) {
    const severity = String(vulnerability?.severity || '').toLowerCase();
    if (!BLOCKING_SEVERITIES.has(severity)) continue;

    const via = Array.isArray(vulnerability.via) ? vulnerability.via : [];
    const advisories = via
      .filter((advisory) => advisory && typeof advisory === 'object')
      .map((advisory) => ({
        title: advisory.title || advisory.source || 'Advisory',
        url: advisory.url || '',
      }))
      .filter((advisory, index, all) => all.findIndex((candidate) => (
        candidate.title === advisory.title && candidate.url === advisory.url
      )) === index);

    findings.push({
      packageName,
      severity,
      nodes: Array.isArray(vulnerability.nodes) ? vulnerability.nodes : [],
      fixAvailable: Boolean(vulnerability.fixAvailable),
      advisories,
    });
  }

  return {
    counts,
    findings: findings.sort((left, right) => (
      left.severity.localeCompare(right.severity) || left.packageName.localeCompare(right.packageName)
    )),
  };
}

function analyzeAuditOutput({ relativeDirectory, exitCode, stdout, stderr }) {
  const auditJson = parseJsonOutput(stdout);
  if (!auditJson) {
    const detail = String(stderr || stdout || 'npm audit returned no JSON output').trim();
    return {
      relativeDirectory,
      status: 'error',
      error: detail.slice(0, 2000),
      counts: { low: 0, moderate: 0, high: 0, critical: 0 },
      findings: [],
    };
  }

  const summary = summarizeVulnerabilities(auditJson);
  const hasBlockingVulnerabilities = summary.counts.high > 0 || summary.counts.critical > 0;

  if (hasBlockingVulnerabilities) {
    return { relativeDirectory, status: 'vulnerable', ...summary };
  }

  if (exitCode !== 0) {
    return {
      relativeDirectory,
      status: 'error',
      error: String(stderr || `npm audit exited with status ${exitCode}`).trim().slice(0, 2000),
      ...summary,
    };
  }

  return { relativeDirectory, status: 'clean', ...summary };
}

function runNpmAudit(directory) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npmCommand,
    ['audit', '--json', '--audit-level=high'],
    {
      cwd: directory,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      // Windows exposes npm as a .cmd shim, which requires cmd.exe to spawn.
      // The command and all arguments are constants, so this does not expose
      // user-controlled input to shell interpretation.
      shell: process.platform === 'win32',
      windowsHide: true,
    },
  );

  return {
    exitCode: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
  };
}

function auditProject({ root = process.cwd(), executeAudit = runNpmAudit } = {}) {
  const discovery = discoverAuditTargets(root);
  const results = discovery.targets.map((target) => analyzeAuditOutput({
    relativeDirectory: target.relativeDirectory,
    ...executeAudit(target.directory),
  }));

  for (const error of discovery.errors) {
    results.push({
      relativeDirectory: '.',
      status: 'error',
      error,
      counts: { low: 0, moderate: 0, high: 0, critical: 0 },
      findings: [],
    });
  }

  if (results.length === 0) {
    results.push({
      relativeDirectory: '.',
      status: 'error',
      error: 'No tracked package-lock.json or npm-shrinkwrap.json was found.',
      counts: { low: 0, moderate: 0, high: 0, critical: 0 },
      findings: [],
    });
  }

  const hasErrors = results.some((result) => result.status === 'error');
  const hasVulnerabilities = results.some((result) => result.status === 'vulnerable');

  return {
    results,
    exitCode: hasErrors ? 2 : (hasVulnerabilities ? 1 : 0),
  };
}

function markdownInline(value) {
  return String(value).replaceAll('`', '\\`');
}

function buildReport({ results, generatedAt = new Date().toISOString() }) {
  const hasErrors = results.some((result) => result.status === 'error');
  const hasVulnerabilities = results.some((result) => result.status === 'vulnerable');
  const overallStatus = hasErrors ? 'ERROR' : (hasVulnerabilities ? 'ACTION REQUIRED' : 'CLEAN');
  const lines = [
    '# npm audit report',
    '',
    `Generated: ${generatedAt}`,
    `Status: **${overallStatus}**`,
    '',
    'This report is generated automatically by `automatic-version-control`.',
    '',
    '## Summary',
    '',
  ];

  for (const result of results) {
    const { counts } = result;
    lines.push(`- \`${markdownInline(result.relativeDirectory)}\`: ${result.status}`
      + ` (high: ${counts.high}, critical: ${counts.critical})`);
  }

  lines.push('', '## Details', '');
  for (const result of results) {
    lines.push(`### \`${markdownInline(result.relativeDirectory)}\``, '');
    lines.push(`- Status: **${result.status}**`);
    lines.push(`- Vulnerabilities: low ${result.counts.low}, moderate ${result.counts.moderate}, high ${result.counts.high}, critical ${result.counts.critical}`);

    if (result.error) {
      lines.push(`- Error: ${result.error.replaceAll('\n', ' ')}`);
    }

    for (const finding of result.findings) {
      const fix = finding.fixAvailable ? 'fix available' : 'manual review may be required';
      lines.push(`- **${finding.severity}**: \`${markdownInline(finding.packageName)}\` (${fix})`);
      for (const advisory of finding.advisories) {
        const title = markdownInline(advisory.title);
        lines.push(advisory.url ? `  - [${title}](${advisory.url})` : `  - ${title}`);
      }
    }

    lines.push('');
  }

  if (hasVulnerabilities || hasErrors) {
    lines.push('Please resolve the findings above and push the fix to `main`.');
  } else {
    lines.push('No high or critical vulnerabilities were detected.');
  }

  return `${lines.join('\n')}\n`;
}

function parseArguments(argv) {
  let reportFile = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--report-file') {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
    index += 1;
    if (!argv[index]) throw new Error('--report-file requires a path');
    reportFile = argv[index];
  }
  return { reportFile };
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`[npm-audit] ${error.message}`);
    return 2;
  }

  const audit = auditProject();
  const report = buildReport({ results: audit.results });

  if (options.reportFile) {
    fs.mkdirSync(path.dirname(path.resolve(options.reportFile)), { recursive: true });
    fs.writeFileSync(options.reportFile, report);
  }

  process.stdout.write(report);
  return audit.exitCode;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  analyzeAuditOutput,
  auditProject,
  buildReport,
  discoverAuditTargets,
  listTrackedLockfiles,
  parseJsonOutput,
  summarizeVulnerabilities,
};
