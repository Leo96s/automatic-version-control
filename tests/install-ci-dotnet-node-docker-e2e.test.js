"use strict";

const assert = require("node:assert/strict");
const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");
const installerPath = path.join(repositoryRoot, "bin", "install.js");
const genericWorkflowTemplatePath = path.join(repositoryRoot, ".github", "workflows", "ci.yml");
const specificTemplatePath = path.join(repositoryRoot, "templates", "ci", "dotnet-node-docker-e2e.yml");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-dotnet-e2e-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function createFakeNodeTools(t) {
  const binRoot = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-fake-node-"));
  t.after(() => fs.rmSync(binRoot, { recursive: true, force: true }));

  const commandNames = process.platform === "win32"
    ? ["npm.cmd", "npx.cmd"]
    : ["npm", "npx"];
  const content = process.platform === "win32"
    ? "@echo off\r\nexit /b 0\r\n"
    : "#!/bin/sh\nexit 0\n";

  for (const commandName of commandNames) {
    const commandPath = path.join(binRoot, commandName);
    fs.writeFileSync(commandPath, content, { mode: 0o755 });
  }

  return binRoot;
}

function runInstaller(root, binRoot) {
  return spawnSync(process.execPath, [installerPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binRoot}${path.delimiter}${process.env.PATH || ""}`,
    },
  });
}

function writeGameSphereLikeFixture(root, { withComposeOverride = true } = {}) {
  fs.mkdirSync(path.join(root, "GameSphere_backend"), { recursive: true });
  fs.writeFileSync(path.join(root, "GameSphere_backend", "GameSphere_backend.csproj"), "<Project />\n");

  fs.mkdirSync(path.join(root, "GameSphere_backend.Tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "GameSphere_backend.Tests", "GameSphere_backend.Tests.csproj"), "<Project />\n");

  fs.mkdirSync(path.join(root, "GameSphere_frontend"), { recursive: true });
  fs.writeFileSync(path.join(root, "GameSphere_frontend", "package.json"), JSON.stringify({
    name: "frontend",
    scripts: { test: "vitest run" },
  }) + "\n");

  fs.writeFileSync(path.join(root, "compose.yml"), "services: {}\n");
  if (withComposeOverride) {
    fs.writeFileSync(path.join(root, "compose.prod.yml"), "services: {}\n");
  }
}

test("generates the dotnet+node+docker-e2e workflow for a GameSphere-shaped project", (t) => {
  const root = createFixture(t);
  writeGameSphereLikeFixture(root);

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Detetada stack específica \(dotnet-node-docker-e2e\)/);

  const workflowPath = path.join(root, ".github", "workflows", "ci.yml");
  const workflow = fs.readFileSync(workflowPath, "utf8");

  assert.doesNotMatch(workflow, /\{\{\w+\}\}/, "no placeholder should remain unrendered");
  assert.match(workflow, /dotnet test GameSphere_backend\.Tests\/GameSphere_backend\.Tests\.csproj/);
  assert.match(workflow, /dotnet list GameSphere_backend\/GameSphere_backend\.csproj/);
  assert.match(workflow, /working-directory: "GameSphere_frontend"/);
  assert.match(workflow, /docker compose -f compose\.yml -f compose\.prod\.yml up -d --build/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/skip-duplicate-run/);
});

test("uses only the base compose file when no prod override exists", (t) => {
  const root = createFixture(t);
  writeGameSphereLikeFixture(root, { withComposeOverride: false });

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /docker compose -f compose\.yml up -d --build/);
});

test("falls back to the generic ci.yml when there is no docker-compose file", (t) => {
  const root = createFixture(t);
  writeGameSphereLikeFixture(root);
  fs.rmSync(path.join(root, "compose.yml"));
  fs.rmSync(path.join(root, "compose.prod.yml"));

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /Detetada stack específica/);
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.equal(workflow, fs.readFileSync(genericWorkflowTemplatePath, "utf8"));
});

test("falls back to the generic ci.yml when there is no .NET test project", (t) => {
  const root = createFixture(t);
  writeGameSphereLikeFixture(root);
  fs.rmSync(path.join(root, "GameSphere_backend.Tests"), { recursive: true, force: true });

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /Detetada stack específica/);
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.equal(workflow, fs.readFileSync(genericWorkflowTemplatePath, "utf8"));
});

test("generalizes to differently-named directories, not just GameSphere's own names", (t) => {
  const root = createFixture(t);
  fs.mkdirSync(path.join(root, "Api"), { recursive: true });
  fs.writeFileSync(path.join(root, "Api", "Api.csproj"), "<Project />\n");
  fs.mkdirSync(path.join(root, "Api.Tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "Api.Tests", "Api.Tests.csproj"), "<Project />\n");
  fs.mkdirSync(path.join(root, "web"), { recursive: true });
  fs.writeFileSync(path.join(root, "web", "package.json"), JSON.stringify({ scripts: { test: "jest" } }) + "\n");
  fs.writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n");

  const result = runInstaller(root, createFakeNodeTools(t));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /dotnet test Api\.Tests\/Api\.Tests\.csproj/);
  assert.match(workflow, /working-directory: "web"/);
  assert.match(workflow, /docker compose -f docker-compose\.yml up -d --build/);
});

test("the specific template file itself is valid YAML with citable placeholders", () => {
  const content = fs.readFileSync(specificTemplatePath, "utf8");
  assert.match(content, /\{\{BACKEND_TEST_PROJECT\}\}/);
  assert.match(content, /\{\{FRONTEND_DIR\}\}/);
  assert.match(content, /\{\{COMPOSE_ARGS\}\}/);
  assert.doesNotMatch(content, /^\s*(working-directory|cache-dependency-path):\s*\{\{/m, "placeholder-only scalar values must be quoted for YAML");
});

test("the docker-e2e job has no project-specific literal values", () => {
  const content = fs.readFileSync(specificTemplatePath, "utf8");

  assert.doesNotMatch(content, /gamesphere/i, "the template must not reference any specific project");

  const envBlockMatch = content.match(/docker-e2e:[\s\S]*?env:\n([\s\S]*?)\n\n {4}steps:/);
  assert.ok(envBlockMatch, "expected to find the docker-e2e env block");
  const envBlock = envBlockMatch[1];

  for (const varName of [
    "POSTGRES_DB", "POSTGRES_USER", "JWT_ISSUER", "JWT_AUDIENCE",
    "SMTP_SERVER", "SMTP_PORT", "SMTP_SENDER_EMAIL", "SMTP_SENDER_NAME",
    "SMTP_USERNAME", "SMTP_ENABLE_SSL", "FIREBASE_PROJECT_ID", "E2E_BASE_URL",
  ]) {
    assert.match(envBlock, new RegExp(`${varName}: \\$\\{\\{ vars\\.CI_E2E_\\w+ \\|\\| `), `${varName} should read from a repository Variable with a generic fallback`);
  }
  for (const secretName of ["POSTGRES_PASSWORD", "JWT_SECRET", "INITIAL_ADMIN_PASSWORD", "SMTP_PASSWORD"]) {
    assert.match(envBlock, new RegExp(`${secretName}: \\$\\{\\{ secrets\\.CI_E2E_\\w+ \\|\\| `), `${secretName} should read from a repository Secret with a generic fallback`);
  }

  assert.match(content, /MIGRATE_SERVICE: \$\{\{ vars\.CI_E2E_MIGRATE_SERVICE \|\| 'migrate' \}\}/);
  assert.match(content, /HEALTHCHECK_STATUS: \$\{\{ vars\.CI_E2E_HEALTHCHECK_STATUS \|\| '200' \}\}/);
});
