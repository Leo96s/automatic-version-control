#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

const SENSITIVE_NAME_PATTERNS = [
  /^\.env(\..+)?$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /^id_rsa$/,
  /^id_ed25519$/,
  /^id_dsa$/,
  /credentials\.json$/,
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf',
  '.zip', '.gz', '.tar', '.7z', '.mp4', '.mov', '.woff', '.woff2',
  '.ttf', '.eot', '.exe', '.dll', '.so', '.bin', '.jar',
]);

const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})(\s|$)/m;

// Padroes de alta confianca que o secretlint (preset-recommend) nao cobre por
// omissao - ex: AWS Access Key ID e o scan generico ficam desativados por
// defeito no secretlint para reduzir falsos positivos (enableIDScanRule: false).
const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  {
    name: 'AWS Access Key ID',
    re: /\b(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    name: 'Chave privada (PEM)',
    re: /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  },
];

function stagedFiles() {
  const out = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

let hasError = false;

function fail(message) {
  console.error(`[pre-commit] BLOQUEADO: ${message}`);
  hasError = true;
}

for (const file of stagedFiles()) {
  const name = path.basename(file);

  if (SENSITIVE_NAME_PATTERNS.some((re) => re.test(name))) {
    fail(`"${file}" parece um ficheiro sensível (credencial/chave privada). Remove-o do commit (git restore --staged "${file}") e usa variáveis de ambiente ou um gestor de segredos.`);
    continue;
  }

  if (!fs.existsSync(file)) continue; // ficheiro apagado neste commit

  const stat = fs.statSync(file);
  if (!stat.isFile()) continue;

  if (stat.size > MAX_FILE_SIZE_BYTES) {
    fail(`"${file}" tem ${(stat.size / 1024 / 1024).toFixed(1)}MB (limite: ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB). Confirma que não é um artefacto/binário acidental.`);
    continue;
  }

  if (BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;

  try {
    const content = fs.readFileSync(file, 'utf8');

    if (CONFLICT_MARKER_RE.test(content)) {
      fail(`"${file}" contém marcadores de conflito de merge (<<<<<<< / ======= / >>>>>>>) por resolver.`);
    }

    for (const { name, re } of HIGH_CONFIDENCE_SECRET_PATTERNS) {
      if (re.test(content)) {
        fail(`"${file}" parece conter um segredo (${name}). Remove-o do commit e roda a credencial imediatamente se já foi exposta.`);
      }
    }
  } catch {
    // ficheiro ilegível como texto (provavelmente binário) - ignora
  }
}

if (hasError) {
  process.exit(1);
}
