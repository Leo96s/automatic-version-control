#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const templateRoot = path.join(__dirname, '..');
const targetRoot = process.cwd();

const DEV_DEPENDENCIES = {
  husky: '^9.1.7',
  '@commitlint/cli': '^19.0.0',
  '@commitlint/config-conventional': '^19.0.0',
};

function log(msg) {
  console.log(`[automatic-version-control] ${msg}`);
}

function run(cmd) {
  execSync(cmd, { cwd: targetRoot, stdio: 'inherit' });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyIfAbsent(relPath) {
  const dest = path.join(targetRoot, relPath);
  if (fs.existsSync(dest)) {
    log(`SKIP ${relPath} (já existe — revê manualmente se necessário)`);
    return;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(path.join(templateRoot, relPath), dest);
  log(`OK   ${relPath}`);
}

function ensureGitignoreHasNodeModules() {
  const gitignorePath = path.join(targetRoot, '.gitignore');
  const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  if (/(^|\n)node_modules\/?\s*(\n|$)/.test(current)) {
    log('SKIP .gitignore (node_modules/ já presente)');
    return;
  }
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(gitignorePath, `${current}${separator}node_modules/\n`);
  log('OK   .gitignore (adicionado node_modules/)');
}

function readPackageJson() {
  const pkgPath = path.join(targetRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error(
      '[automatic-version-control] Não encontrei package.json neste repositório.\n' +
        'Corre "npm init -y" primeiro e volta a correr este comando.'
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

function writePackageJson(pkg) {
  fs.writeFileSync(path.join(targetRoot, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

// Calcula o script "prepare" final, encadeando com o que já existia (se existir)
function computeDesiredPrepare(existingPrepare) {
  if (!existingPrepare) return 'husky';
  if (existingPrepare.includes('husky')) return existingPrepare;
  return `husky && ${existingPrepare}`;
}

function mergePackageJson() {
  const pkg = readPackageJson();
  let changed = false;

  pkg.devDependencies = pkg.devDependencies || {};
  for (const [name, version] of Object.entries(DEV_DEPENDENCIES)) {
    if (!pkg.devDependencies[name]) {
      pkg.devDependencies[name] = version;
      changed = true;
    }
  }

  pkg.scripts = pkg.scripts || {};
  const desiredPrepare = computeDesiredPrepare(pkg.scripts.prepare);
  if (pkg.scripts.prepare !== desiredPrepare) {
    pkg.scripts.prepare = desiredPrepare;
    changed = true;
  }

  if (changed) {
    writePackageJson(pkg);
    log('OK   package.json (devDependencies + script "prepare" atualizados)');
  } else {
    log('SKIP package.json (já tinha tudo)');
  }

  return desiredPrepare;
}

// husky init sobrescreve o script "prepare" para "husky" (perdendo o encadeamento
// feito acima); reaplica o valor correto depois de correr o husky init.
function restorePrepareScript(desiredPrepare) {
  const pkg = readPackageJson();
  if (pkg.scripts && pkg.scripts.prepare !== desiredPrepare) {
    pkg.scripts.prepare = desiredPrepare;
    writePackageJson(pkg);
    log('OK   package.json (script "prepare" reposto após husky init)');
  }
}

function setupHuskyCommitMsgHook() {
  ensureDir(path.join(targetRoot, '.husky'));
  run('npx husky init');

  const preCommitSample = path.join(targetRoot, '.husky/pre-commit');
  if (fs.existsSync(preCommitSample) && fs.readFileSync(preCommitSample, 'utf8').trim() === 'npm test') {
    fs.rmSync(preCommitSample);
  }

  fs.writeFileSync(path.join(targetRoot, '.husky/commit-msg'), 'npx --no -- commitlint --edit "$1"\n');
  log('OK   .husky/commit-msg');
}

function main() {
  if (!fs.existsSync(path.join(targetRoot, '.git'))) {
    console.error('[automatic-version-control] Este diretório não parece ser um repositório git (falta .git). A abortar.');
    process.exit(1);
  }

  copyIfAbsent('.github/workflows/versioning.yml');
  copyIfAbsent('commitlint.config.js');
  ensureGitignoreHasNodeModules();
  const desiredPrepare = mergePackageJson();

  log('A correr npm install...');
  run('npm install');

  setupHuskyCommitMsgHook();
  restorePrepareScript(desiredPrepare);

  log('');
  log('Tudo pronto. Falta só, nas definições do repositório no GitHub:');
  log('  Settings -> Actions -> General -> Workflow permissions -> "Read and write permissions"');
  log('  Settings -> Actions -> General -> Actions permissions  -> "Allow all actions and reusable workflows"');
}

main();
