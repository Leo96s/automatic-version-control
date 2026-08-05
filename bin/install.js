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
  'lint-staged': '^16.4.0',
  secretlint: '^13.0.2',
  '@secretlint/secretlint-rule-preset-recommend': '^13.0.2',
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

// Estes ficheiros sao inteiramente geridos por este pacote (o utilizador nao
// costuma personaliza-los), por isso sao sempre substituidos pela versao mais
// recente - isto e o que garante que um projeto com um versioning.yml antigo
// fica atualizado ao correr o instalador de novo.
function copyTemplateFile(relPath) {
  const dest = path.join(targetRoot, relPath);
  const existedBefore = fs.existsSync(dest);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(path.join(templateRoot, relPath), dest);
  log(existedBefore ? `OK   ${relPath} (substituído pela versão mais recente)` : `OK   ${relPath}`);
}

// Mesma convenção do mobile-release.yml/versioning.yml (raiz + subpastas
// de primeiro nível): só instala mobile-release.yml em repositórios que
// realmente sejam Kotlin/Android ou Flutter, para não deixar um workflow
// morto a disparar (sem fazer nada) em todos os outros repositórios.
function detectMobileProject() {
  const entries = fs.readdirSync(targetRoot, { withFileTypes: true });
  const dirs = ['.', ...entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)];

  for (const d of dirs) {
    const base = path.join(targetRoot, d);
    const hasGradlew = fs.existsSync(path.join(base, 'gradlew'));
    const hasSettings =
      fs.existsSync(path.join(base, 'settings.gradle.kts')) || fs.existsSync(path.join(base, 'settings.gradle'));
    if (hasGradlew && hasSettings) return 'gradle';
  }

  for (const d of dirs) {
    const base = path.join(targetRoot, d);
    const pubspecPath = path.join(base, 'pubspec.yaml');
    if (!fs.existsSync(pubspecPath) || !fs.existsSync(path.join(base, 'android'))) continue;
    const isFlutter = fs.readFileSync(pubspecPath, 'utf8').split('\n').some((line) => line.startsWith('flutter:'));
    if (isFlutter) return 'flutter';
  }

  return 'none';
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

// Devolve null quando não há package.json — usado por main() para saltar
// toda a parte de tooling local em Node (husky/commitlint/secretlint),
// que não faz sentido num repositório sem Node. O workflow de CI
// (versioning.yml/mobile-release.yml) não depende disto.
function readPackageJson() {
  const pkgPath = path.join(targetRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return null;
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

function setupHuskyHooks() {
  ensureDir(path.join(targetRoot, '.husky'));
  run('npx husky init');

  const preCommitPath = path.join(targetRoot, '.husky/pre-commit');
  const preCommitIsHuskySample = fs.existsSync(preCommitPath) && fs.readFileSync(preCommitPath, 'utf8').trim() === 'npm test';

  if (preCommitIsHuskySample) {
    fs.rmSync(preCommitPath);
  }

  fs.writeFileSync(path.join(targetRoot, '.husky/commit-msg'), 'npx --no -- commitlint --edit "$1"\n');
  log('OK   .husky/commit-msg');

  if (fs.existsSync(preCommitPath) && !preCommitIsHuskySample) {
    log('SKIP .husky/pre-commit (já existe e parece ter sido personalizado — adiciona manualmente:)');
    log('       node scripts/pre-commit-checks.js || exit 1');
    log('       npx lint-staged');
    return;
  }

  fs.writeFileSync(path.join(targetRoot, '.husky/pre-commit'), 'node scripts/pre-commit-checks.js || exit 1\nnpx lint-staged\n');
  log('OK   .husky/pre-commit');
}

function main() {
  if (!fs.existsSync(path.join(targetRoot, '.git'))) {
    console.error('[automatic-version-control] Este diretório não parece ser um repositório git (falta .git). A abortar.');
    process.exit(1);
  }

  copyTemplateFile('.github/workflows/versioning.yml');

  const mobileType = detectMobileProject();
  if (mobileType !== 'none') {
    copyTemplateFile('.github/workflows/mobile-release.yml');
    log(`Detetado projeto ${mobileType === 'gradle' ? 'Kotlin/Android' : 'Flutter'} — mobile-release.yml instalado.`);
  } else {
    log('SKIP .github/workflows/mobile-release.yml (não detetei projeto Kotlin/Android nem Flutter).');
  }

  const hasPackageJson = readPackageJson() !== null;

  if (hasPackageJson) {
    copyTemplateFile('commitlint.config.js');
    copyTemplateFile('.secretlintrc.json');
    copyTemplateFile('.lintstagedrc.json');
    copyTemplateFile('scripts/pre-commit-checks.js');
    ensureGitignoreHasNodeModules();
    const desiredPrepare = mergePackageJson();

    log('A correr npm install...');
    run('npm install');

    setupHuskyHooks();
    restorePrepareScript(desiredPrepare);
  } else {
    log('SKIP tooling local em Node (commitlint/secretlint/husky) — sem package.json neste repositório.');
    log('     O workflow de CI (versioning.yml) não precisa de Node local e foi instalado na mesma.');
  }

  log('');
  log('Tudo pronto. Falta só, nas definições do repositório no GitHub:');
  log('  Settings -> Actions -> General -> Workflow permissions -> "Read and write permissions"');
  log('  Settings -> Actions -> General -> Actions permissions  -> "Allow all actions and reusable workflows"');

  if (mobileType !== 'none') {
    log('');
    log('mobile-release.yml só consegue compilar e publicar um APK assinado depois de configurares:');
    log('  MOBILE_KEYSTORE_BASE64, MOBILE_KEYSTORE_STORE_PASSWORD, MOBILE_KEYSTORE_KEY_PASSWORD');
    log('  (e opcionalmente MOBILE_GOOGLE_SERVICES_JSON_BASE64) em Settings -> Secrets and variables -> Actions.');
    log('Ver o README deste pacote para o contrato de signingConfig que o projeto de destino tem de cumprir.');
  }
}

main();
