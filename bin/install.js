#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

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

const PLUGIN_VERSION_SYNC_FILES = [
  '.github/actions/plugin-version-sync/action.yml',
  'scripts/sync-plugin-versions.js',
];

const NPM_AUDIT_FILES = [
  '.github/workflows/npm-audit.yml',
  'scripts/npm-audit.js',
];

const CI_TESTS_FILES = [
  '.github/workflows/ci.yml',
];

function log(msg) {
  console.log(`[automatic-version-control] ${msg}`);
}

function run(cmd) {
  execSync(cmd, { cwd: targetRoot, stdio: 'inherit' });
}

// Grava a versão deste próprio pacote (lida do seu package.json, já
// commitado — nunca requer .git no clone temporário do npx, que nem
// sempre está presente consoante como o npm resolveu a dependência
// GitHub) no repositório de destino, para uma ferramenta externa (ex. um
// hook) conseguir saber se o que está instalado é a versão mais recente.
function writeVersionMarker() {
  const templatePkg = JSON.parse(fs.readFileSync(path.join(templateRoot, 'package.json'), 'utf8'));
  const version = templatePkg.version;
  const dest = path.join(targetRoot, '.github', 'automatic-version-control.version');
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, `${version}\n`);
  log(`OK   .github/automatic-version-control.version (${version})`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative));
}

function validateTemplateDestination(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0
    || path.isAbsolute(relPath)
    || relPath.startsWith('/')
    || relPath.startsWith('\\')
    || /^[A-Za-z]:/.test(relPath)) {
    throw new Error(`Refusing template destination "${relPath}": path must be strictly relative.`);
  }

  const segments = relPath.split(/[\\/]/);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Refusing template destination "${relPath}": path contains an unsafe segment.`);
  }

  let realTargetRoot;
  try {
    realTargetRoot = fs.realpathSync(targetRoot);
  } catch {
    throw new Error('Refusing template destination: target root is not accessible.');
  }

  const projectedDestination = path.join(realTargetRoot, ...segments);
  if (!isPathInside(realTargetRoot, projectedDestination)) {
    throw new Error(`Refusing template destination "${relPath}": path escapes the target root.`);
  }

  let currentPath = targetRoot;
  let deepestExistingPath = targetRoot;
  let rootStats;
  try {
    rootStats = fs.lstatSync(targetRoot);
  } catch {
    throw new Error('Refusing template destination: target root cannot be inspected.');
  }
  if (rootStats.isSymbolicLink()) {
    throw new Error(`Refusing template destination "${relPath}": target root is a symbolic link.`);
  }

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    let stats;
    try {
      stats = fs.lstatSync(currentPath);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw new Error(`Refusing template destination "${relPath}": path cannot be inspected.`);
    }
    deepestExistingPath = currentPath;
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing template destination "${relPath}": path contains a symbolic link.`);
    }
  }

  let deepestRealPath;
  try {
    deepestRealPath = fs.realpathSync(deepestExistingPath);
  } catch {
    throw new Error(`Refusing template destination "${relPath}": existing path is not accessible.`);
  }
  if (!isPathInside(realTargetRoot, deepestRealPath)) {
    throw new Error(`Refusing template destination "${relPath}": existing path escapes the target root.`);
  }

  return path.join(targetRoot, ...segments);
}

// Estes ficheiros sao inteiramente geridos por este pacote (o utilizador nao
// costuma personaliza-los), por isso sao sempre substituidos pela versao mais
// recente - isto e o que garante que um projeto com um versioning.yml antigo
// fica atualizado ao correr o instalador de novo.
function copyTemplateFile(relPath) {
  const dest = validateTemplateDestination(relPath);
  const existedBefore = fs.existsSync(dest);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(path.join(templateRoot, relPath), dest);
  log(existedBefore ? `OK   ${relPath} (substituído pela versão mais recente)` : `OK   ${relPath}`);
}

// Remove apenas a cópia que ainda é byte-a-byte igual ao template atual.
// Qualquer personalização ou tipo de ficheiro inesperado é preservado.
function removeUnchangedTemplateFile(relPath, missingReason = 'não detetei os metadados necessários') {
  let destinationPath;
  try {
    destinationPath = validateTemplateDestination(relPath);
  } catch (error) {
    log(`WARN ${relPath} foi preservado porque o destino não é seguro (${error.message}).`);
    return;
  }
  if (!fs.existsSync(destinationPath)) {
    log(`SKIP ${relPath} (${missingReason}).`);
    return;
  }

  let destinationStats;
  let destinationContent;
  try {
    destinationStats = fs.lstatSync(destinationPath);
    destinationContent = fs.readFileSync(destinationPath);
  } catch {
    log(`WARN ${relPath} foi preservado porque não foi possível confirmar que continua gerido pelo instalador.`);
    return;
  }

  const templateContent = fs.readFileSync(path.join(templateRoot, relPath));
  if (destinationStats.isFile()
    && !destinationStats.isSymbolicLink()
    && destinationContent.equals(templateContent)) {
    try {
      validateTemplateDestination(relPath);
    } catch (error) {
      log(`WARN ${relPath} foi preservado porque o destino deixou de ser seguro (${error.message}).`);
      return;
    }
    fs.rmSync(destinationPath);
    log(`OK   ${relPath} (removido porque o repositório já não tem metadados de plugin rastreados).`);
    return;
  }

  log(`WARN ${relPath} foi preservado porque parece ter sido modificado.`);
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

// Mesma convenção de deteção (raiz + subpastas de primeiro nível) usada por
// detectMobileProject — decide se há um script "test" para correr em
// ci.yml, sem exigir lockfile (ao contrário de detectNpmProject, que serve
// para decidir a auditoria de dependências, não os testes).
function detectNodeTestProject() {
  const entries = fs.readdirSync(targetRoot, { withFileTypes: true });
  const dirs = ['.', ...entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name)];

  for (const d of dirs) {
    const pkgPath = path.join(targetRoot, d, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      continue;
    }
    if (pkg.scripts && typeof pkg.scripts.test === 'string' && pkg.scripts.test.trim()) {
      return d;
    }
  }

  return null;
}

function isRecognizedPluginPath(relativePath) {
  const normalizedPath = relativePath.split(path.sep).join('/');
  return normalizedPath === '.claude-plugin/plugin.json'
    || normalizedPath.endsWith('/.claude-plugin/plugin.json')
    || normalizedPath === '.codex-plugin/plugin.json'
    || normalizedPath.endsWith('/.codex-plugin/plugin.json')
    || normalizedPath === '.claude-plugin/marketplace.json'
    || normalizedPath.endsWith('/.claude-plugin/marketplace.json')
    || normalizedPath === '.agents/plugins/marketplace.json'
    || normalizedPath.endsWith('/.agents/plugins/marketplace.json');
}

function detectPluginProject() {
  let trackedPaths;
  try {
    trackedPaths = execFileSync('git', ['ls-files', '-z'], {
      cwd: targetRoot,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('Não foi possível ler os ficheiros rastreados pelo Git.');
  }

  return trackedPaths
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .some((relativePath) => {
      const segments = relativePath.split('/');
      return !segments.includes('.git')
        && !segments.includes('node_modules')
        && isRecognizedPluginPath(relativePath);
    });
}

function isRecognizedNpmLockfilePath(relativePath) {
  const segments = relativePath.split(/[\\/]/);
  const fileName = segments[segments.length - 1];
  return !segments.includes('.git')
    && !segments.includes('node_modules')
    && (fileName === 'package-lock.json' || fileName === 'npm-shrinkwrap.json');
}

function detectNpmProject() {
  let trackedPaths;
  try {
    trackedPaths = execFileSync('git', [
      'ls-files',
      '-z',
      '--',
      '*package-lock.json',
      '*npm-shrinkwrap.json',
      ':!**/.git/**',
      ':!**/node_modules/**',
    ], {
      cwd: targetRoot,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('Não foi possível ler os lockfiles npm rastreados pelo Git.');
  }

  return trackedPaths
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .some(isRecognizedNpmLockfilePath);
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
  copyTemplateFile('.github/actions/skip-duplicate-run/action.yml');
  writeVersionMarker();

  if (detectPluginProject()) {
    for (const relPath of PLUGIN_VERSION_SYNC_FILES) {
      copyTemplateFile(relPath);
    }
    log('Detetado projeto com plugin Claude Code ou Codex — extensao de sincronizacao instalada.');
  } else {
    for (const relPath of PLUGIN_VERSION_SYNC_FILES) {
      removeUnchangedTemplateFile(relPath);
    }
  }

  const mobileType = detectMobileProject();
  if (mobileType !== 'none') {
    copyTemplateFile('.github/workflows/mobile-release.yml');
    log(`Detetado projeto ${mobileType === 'gradle' ? 'Kotlin/Android' : 'Flutter'} — mobile-release.yml instalado.`);
  } else {
    log('SKIP .github/workflows/mobile-release.yml (não detetei projeto Kotlin/Android nem Flutter).');
  }

  const nodeTestDir = detectNodeTestProject();
  if (nodeTestDir !== null || mobileType !== 'none') {
    for (const relPath of CI_TESTS_FILES) {
      copyTemplateFile(relPath);
    }
    log('Detetados testes (Node, Gradle/Kotlin ou Flutter) — ci.yml instalado/atualizado.');
  } else {
    for (const relPath of CI_TESTS_FILES) {
      removeUnchangedTemplateFile(relPath, 'não detetei testes Node, Gradle/Kotlin ou Flutter');
    }
    log('SKIP .github/workflows/ci.yml (não detetei testes Node, Gradle/Kotlin ou Flutter).');
  }

  const hasPackageJson = readPackageJson() !== null;
  const hasNpmProject = detectNpmProject();

  if (hasNpmProject) {
    for (const relPath of NPM_AUDIT_FILES) {
      copyTemplateFile(relPath);
    }
    log('Detetados lockfiles npm rastreados — workflow de auditoria de dependências instalado.');
  } else {
    for (const relPath of NPM_AUDIT_FILES) {
      removeUnchangedTemplateFile(relPath, 'não detetei package-lock.json ou npm-shrinkwrap.json rastreado');
    }
    log('SKIP workflow de auditoria npm (não detetei lockfiles npm rastreados).');
  }

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
