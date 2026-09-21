#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

const OUT_OF_REACH_ITEMS = [
  { label: 'Row Level Security (RLS) ou isolamento equivalente ao nível dos dados', hintId: 'rls' },
  { label: 'Bloqueio de mass assignment' },
  { label: 'Rate limiting em endpoints sensíveis ou públicos', hintId: 'rate-limiting' },
  { label: 'Proteção contra bots e automação' },
  { label: 'Âmbito de restrição de acessos (autorização por role ou scope)' },
  { label: 'Trim de respostas de API (over-fetching ou over-posting)' },
  { label: 'Presença de security headers (CSP, HSTS, X-Frame-Options, etc.)', hintId: 'security-headers' },
  { label: 'HTTPS forçado (redirect + HSTS)' },
];

// Heurísticos best-effort e não-bloqueantes: só procuram um sinal conhecido de
// mitigação nos ficheiros rastreados pelo Git. A presença do sinal não prova
// que a mitigação está corretamente aplicada em todos os sítios relevantes, e
// a ausência não prova que falta — por isso nunca influenciam decideExitCode.
const HINT_DEFINITIONS = [
  { id: 'rls', pattern: 'ENABLE ROW LEVEL SECURITY' },
  { id: 'rate-limiting', pattern: '(express-rate-limit|rate-limiter-flexible|fastify-rate-limit|django-ratelimit|flask-limiter|AspNetCoreRateLimit)' },
  { id: 'security-headers', pattern: '(Strict-Transport-Security|Content-Security-Policy|X-Frame-Options|helmet\\()' },
];

function runTool(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  return {
    exitCode: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
    error: result.error || null,
  };
}

function interpretGitleaksResult(result) {
  if (result.error) {
    return { status: 'error', error: result.error.message || String(result.error), findings: [] };
  }

  let findings;
  try {
    findings = JSON.parse(result.stdout || '[]');
  } catch {
    return { status: 'error', error: 'gitleaks returned invalid JSON output', findings: [] };
  }
  if (!Array.isArray(findings)) {
    return { status: 'error', error: 'gitleaks returned invalid JSON output', findings: [] };
  }

  if (result.exitCode === 0 || findings.length > 0) {
    return findings.length > 0
      ? { status: 'leaked', error: null, findings }
      : { status: 'clean', error: null, findings: [] };
  }

  return {
    status: 'error',
    error: `gitleaks exited with status ${result.exitCode}: ${result.stderr}`.trim(),
    findings: [],
  };
}

function runGitleaksCommand(args, root, execute) {
  try {
    return interpretGitleaksResult(execute('gitleaks', args, root));
  } catch (error) {
    return { status: 'error', error: error.message, findings: [] };
  }
}

function runGitleaksFullHistory(root, execute = runTool) {
  return runGitleaksCommand(['detect', '--no-banner', '--redact', '-f', 'json', '-r', '-'], root, execute);
}

// Limita o gitleaks aos commits introduzidos pela PR (baseSha..headSha), em
// vez de re-escanear todo o histórico a cada execução — mais rápido, e
// suficiente porque o histórico anterior à base já foi coberto pelo job que
// corre em push para main.
function runGitleaksDiff(root, baseSha, headSha = 'HEAD', execute = runTool) {
  return runGitleaksCommand(
    ['detect', '--no-banner', '--redact', '-f', 'json', '-r', '-', '--log-opts', `--all ${baseSha}..${headSha}`],
    root,
    execute,
  );
}

function interpretSemgrepResult(result) {
  if (result.error) {
    return { status: 'error', error: result.error.message || String(result.error), findings: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch {
    return { status: 'error', error: 'semgrep returned invalid JSON output', findings: [] };
  }
  if (!parsed || !Array.isArray(parsed.results)) {
    return { status: 'error', error: 'semgrep returned invalid JSON output', findings: [] };
  }

  const findings = parsed.results.map((item) => ({
    checkId: item.check_id || 'semgrep finding',
    path: item.path || 'unknown file',
    line: item.start?.line ?? '?',
    message: item.extra?.message || '',
  }));

  return findings.length > 0
    ? { status: 'findings', error: null, findings }
    : { status: 'clean', error: null, findings: [] };
}

function runSemgrepCommand(args, root, execute) {
  try {
    return interpretSemgrepResult(execute('semgrep', args, root));
  } catch (error) {
    return { status: 'error', error: error.message, findings: [] };
  }
}

function runSemgrepFullRepo(root, execute = runTool) {
  return runSemgrepCommand(['--config', 'p/security-audit', '--json', '--quiet', '.'], root, execute);
}

// Só reporta findings introduzidos desde baseSha (idealmente o merge-base com
// a branch de destino) — mesma lógica de "só o que é novo na PR" do gitleaks
// acima, usando o suporte nativo do semgrep para isso.
function runSemgrepBaseline(root, baseSha, execute = runTool) {
  return runSemgrepCommand(
    ['--config', 'p/security-audit', '--baseline-commit', baseSha, '--json', '--quiet', '.'],
    root,
    execute,
  );
}

// Ruleset público do semgrep para problemas conhecidos de segurança em
// workflows do GitHub Actions (ex. pull_request_target a dar checkout de
// código não confiável com acesso a secrets). Corre sempre sobre .github/
// (workflows + actions compostas), independentemente do modo diff/full.
function runSemgrepGithubActions(root, execute = runTool) {
  return runSemgrepCommand(['--config', 'p/github-actions', '--json', '--quiet', '.github'], root, execute);
}

// git grep sai com 1 quando não há correspondências — não é um erro, ao
// contrário de gitleaks/semgrep, que sinalizam ausência de findings via JSON.
function runHeuristicHint(definition, root, execute = runTool) {
  let result;
  try {
    result = execute('git', ['grep', '-liE', definition.pattern], root);
  } catch (error) {
    return { id: definition.id, status: 'error', error: error.message, files: [] };
  }
  if (result.error) {
    return { id: definition.id, status: 'error', error: result.error.message || String(result.error), files: [] };
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return {
      id: definition.id,
      status: 'error',
      error: `git grep exited with status ${result.exitCode}: ${result.stderr}`.trim(),
      files: [],
    };
  }

  const files = String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return { id: definition.id, status: files.length > 0 ? 'found' : 'not-found', error: null, files };
}

function runHeuristicHints(root, execute = runTool) {
  return HINT_DEFINITIONS.map((definition) => runHeuristicHint(definition, root, execute));
}

function decideExitCode({ gitleaks, semgrep, actionsAudit = { status: 'clean' } }) {
  if (gitleaks.status === 'error' || semgrep.status === 'error' || actionsAudit.status === 'error') return 2;
  if (gitleaks.status === 'leaked' || semgrep.status === 'findings' || actionsAudit.status === 'findings') return 1;
  return 0;
}

function markdownInline(value) {
  return String(value).replaceAll('`', '\\`');
}

function formatHintSuffix(hint) {
  if (!hint) return '';
  if (hint.status === 'error') return ` (heuristic hint: could not check — ${markdownInline(hint.error)})`;
  if (hint.status === 'found') {
    return ` (heuristic hint: mitigation pattern found in ${hint.files.length} tracked file(s) — presence does not confirm it is correctly applied everywhere; review manually)`;
  }
  return ' (heuristic hint: no known mitigation pattern found in tracked files — this does not confirm the practice is missing)';
}

function buildReport({
  gitleaks,
  semgrep,
  actionsAudit = { status: 'clean', findings: [] },
  hints = [],
  generatedAt = new Date().toISOString(),
}) {
  const hasErrors = gitleaks.status === 'error' || semgrep.status === 'error' || actionsAudit.status === 'error';
  const hasFindings = gitleaks.status === 'leaked' || semgrep.status === 'findings' || actionsAudit.status === 'findings';
  const overallStatus = hasErrors ? 'ERROR' : (hasFindings ? 'ACTION REQUIRED' : 'CLEAN');

  const lines = [
    '# Security checklist report',
    '',
    `Generated: ${generatedAt}`,
    `Status: **${overallStatus}**`,
    '',
    'This report mechanically checks only what generic static tools can verify. See "Out of mechanical reach" below for the rest.',
    '',
    '## Summary',
    '',
    `- Secrets in Git history (gitleaks): ${gitleaks.status}${gitleaks.status === 'leaked' ? ` (${gitleaks.findings.length} finding(s))` : ''}`,
    `- Static analysis (semgrep p/security-audit): ${semgrep.status}${semgrep.status === 'findings' ? ` (${semgrep.findings.length} finding(s))` : ''}`,
    `- GitHub Actions workflow security (semgrep p/github-actions): ${actionsAudit.status}${actionsAudit.status === 'findings' ? ` (${actionsAudit.findings.length} finding(s))` : ''}`,
    '',
    '## Details',
    '',
    '### Secrets in Git history',
    '',
  ];

  if (gitleaks.status === 'error') {
    lines.push(`- Error: ${markdownInline(gitleaks.error)}`);
  } else if (gitleaks.status === 'leaked') {
    for (const finding of gitleaks.findings.slice(0, 25)) {
      lines.push(`- \`${markdownInline(finding.RuleID || 'unknown rule')}\` in \`${markdownInline(finding.File || 'unknown file')}\`:${finding.StartLine || '?'} (commit ${markdownInline(finding.Commit || '?')})`);
    }
  } else {
    lines.push('- No secrets found in the repository history.');
  }

  lines.push('', '### Static analysis (semgrep)', '');
  if (semgrep.status === 'error') {
    lines.push(`- Error: ${markdownInline(semgrep.error)}`);
  } else if (semgrep.status === 'findings') {
    for (const finding of semgrep.findings.slice(0, 25)) {
      const message = finding.message ? ` — ${markdownInline(finding.message)}` : '';
      lines.push(`- \`${markdownInline(finding.checkId)}\`: \`${markdownInline(finding.path)}\`:${finding.line}${message}`);
    }
  } else {
    lines.push('- No findings.');
  }

  lines.push('', '### GitHub Actions workflow security (semgrep p/github-actions)', '');
  if (actionsAudit.status === 'error') {
    lines.push(`- Error: ${markdownInline(actionsAudit.error)}`);
  } else if (actionsAudit.status === 'findings') {
    for (const finding of actionsAudit.findings.slice(0, 25)) {
      const message = finding.message ? ` — ${markdownInline(finding.message)}` : '';
      lines.push(`- \`${markdownInline(finding.checkId)}\`: \`${markdownInline(finding.path)}\`:${finding.line}${message}`);
    }
  } else {
    lines.push('- No findings.');
  }

  if (gitleaks.status === 'leaked') {
    lines.push(
      '',
      '## Remediation for leaked secrets',
      '',
      'Rewrite the affected history with `git filter-repo` (or BFG Repo-Cleaner) to remove the secret from every commit, force-push the rewritten history after coordinating with all collaborators, and rotate every exposed credential immediately — a history rewrite alone does not invalidate an already-leaked key.',
    );
  }

  const hintById = new Map(hints.map((hint) => [hint.id, hint]));

  lines.push(
    '',
    '## Out of mechanical reach',
    '',
    'The following practices cannot be verified generically by static tools and are not checked by this workflow. Review them with `/code-review --security` and the automatic reminders from the security-practices Stop hook:',
    '',
    ...OUT_OF_REACH_ITEMS.map((item) => `- ${item.label}${formatHintSuffix(item.hintId ? hintById.get(item.hintId) : null)}`),
    '',
    hasErrors || hasFindings ? 'Please resolve the findings above.' : 'No mechanically detectable issues were found.',
  );

  return `${lines.join('\n')}\n`;
}

function parseArguments(argv) {
  let reportFile = null;
  let diffBase = null;
  let diffHead = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--report-file') {
      index += 1;
      if (!argv[index]) throw new Error('--report-file requires a path');
      reportFile = argv[index];
    } else if (flag === '--diff-base') {
      index += 1;
      if (!argv[index]) throw new Error('--diff-base requires a commit SHA');
      diffBase = argv[index];
    } else if (flag === '--diff-head') {
      index += 1;
      if (!argv[index]) throw new Error('--diff-head requires a commit SHA');
      diffHead = argv[index];
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return { reportFile, diffBase, diffHead };
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`[security-checklist] ${error.message}`);
    return 2;
  }

  const root = process.cwd();
  const gitleaks = options.diffBase
    ? runGitleaksDiff(root, options.diffBase, options.diffHead || 'HEAD')
    : runGitleaksFullHistory(root);
  const semgrep = options.diffBase
    ? runSemgrepBaseline(root, options.diffBase)
    : runSemgrepFullRepo(root);
  const actionsAudit = runSemgrepGithubActions(root);
  const hints = runHeuristicHints(root);
  const report = buildReport({ gitleaks, semgrep, actionsAudit, hints });

  if (options.reportFile) {
    fs.mkdirSync(path.dirname(path.resolve(options.reportFile)), { recursive: true });
    fs.writeFileSync(options.reportFile, report);
  }

  process.stdout.write(report);
  return decideExitCode({ gitleaks, semgrep, actionsAudit });
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  buildReport,
  decideExitCode,
  runGitleaksDiff,
  runGitleaksFullHistory,
  runHeuristicHint,
  runHeuristicHints,
  runSemgrepBaseline,
  runSemgrepFullRepo,
  runSemgrepGithubActions,
  runTool,
};
