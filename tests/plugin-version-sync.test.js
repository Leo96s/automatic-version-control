"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const synchronizerPath = path.resolve(__dirname, "..", "scripts", "sync-plugin-versions.js");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-plugin-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function writeJson(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function trackFixture(root) {
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "--all"], { cwd: root });
}

function commitFixture(root, message) {
  execFileSync("git", ["-c", "user.email=fixtures@example.invalid", "-c", "user.name=Test Fixture", "commit", "--quiet", "-m", message], { cwd: root });
}

function createReleaseTag(root, tag, message) {
  fs.writeFileSync(path.join(root, `${tag}.txt`), `${message}\n`);
  trackFixture(root);
  commitFixture(root, message);
  execFileSync("git", ["tag", tag], { cwd: root });
}

function synchronizeLatestRelease({ root, synchronize }) {
  const finalTag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: root, encoding: "utf8" }).trim();
  return synchronize({ root, version: finalTag.slice(1) });
}

function loadSynchronizer() {
  delete require.cache[synchronizerPath];
  const { syncPluginVersions } = require(synchronizerPath);
  assert.equal(typeof syncPluginVersions, "function");
  return syncPluginVersions;
}

function pluginManifest(name, version) {
  return { name, version, description: `Fictitious ${name} plugin` };
}

function claudeMarketplace(plugins, extra = {}) {
  return {
    name: "fictional-marketplace",
    owner: { name: "Fictional Team" },
    ...extra,
    plugins,
  };
}

function codexMarketplace(plugins, extra = {}) {
  return {
    name: "fictional-marketplace",
    ...extra,
    plugins,
  };
}

test("updates every tracked Claude and Codex plugin manifest to the final version", (t) => {
  const root = createFixture(t);
  const manifests = [
    [".claude-plugin/plugin.json", "fictional-claude-root"],
    ["plugins/claude-copy/.claude-plugin/plugin.json", "fictional-claude-copy"],
    [".codex-plugin/plugin.json", "fictional-codex-root"],
    ["plugins/codex-copy/.codex-plugin/plugin.json", "fictional-codex-copy"],
  ];

  for (const [relativePath, name] of manifests) {
    writeJson(root, relativePath, pluginManifest(name, "0.1.0"));
  }
  trackFixture(root);

  const changedFiles = loadSynchronizer()({ root, version: "4.8.0" });

  assert.deepEqual(changedFiles.sort(), manifests.map(([relativePath]) => relativePath).sort());
  for (const [relativePath] of manifests) {
    assert.equal(readJson(root, relativePath).version, "4.8.0");
  }
});

test("ignores tracked plugin metadata inside node_modules", (t) => {
  const root = createFixture(t);
  writeJson(root, ".claude-plugin/plugin.json", pluginManifest("fictional-root", "0.1.0"));
  writeJson(root, "node_modules/fictional-package/.claude-plugin/plugin.json", pluginManifest("fictional-dependency", "0.1.0"));
  trackFixture(root);

  const changedFiles = loadSynchronizer()({ root, version: "4.8.0" });

  assert.deepEqual(changedFiles, [".claude-plugin/plugin.json"]);
  assert.equal(readJson(root, ".claude-plugin/plugin.json").version, "4.8.0");
  assert.equal(readJson(root, "node_modules/fictional-package/.claude-plugin/plugin.json").version, "0.1.0");
});

test("handles tracked plugin paths with spaces and leading hyphens", (t) => {
  const root = createFixture(t);
  const manifests = [
    "plugins/with spaces/.claude-plugin/plugin.json",
    "-plugins/.claude-plugin/plugin.json",
  ];

  for (const relativePath of manifests) {
    writeJson(root, relativePath, pluginManifest(`fictional-${relativePath}`, "0.1.0"));
  }
  trackFixture(root);

  const changedFiles = loadSynchronizer()({ root, version: "4.8.0" });

  assert.deepEqual(changedFiles.sort(), manifests.sort());
  for (const relativePath of manifests) {
    assert.equal(readJson(root, relativePath).version, "4.8.0");
  }
});

test("handles tracked plugin paths with newlines when the filesystem supports them", {
  skip: process.platform === "win32",
}, (t) => {
  const root = createFixture(t);
  const manifestPath = "plugins/with\nnewline/.codex-plugin/plugin.json";
  writeJson(root, manifestPath, pluginManifest("fictional-newline", "0.1.0"));
  trackFixture(root);

  const changedFiles = loadSynchronizer()({ root, version: "4.8.0" });

  assert.deepEqual(changedFiles, [manifestPath]);
  assert.equal(readJson(root, manifestPath).version, "4.8.0");
});

test("updates Claude local marketplace entries without changing official external object entries or catalog version", (t) => {
  const root = createFixture(t);
  const externalPlugins = [
    { name: "fictional-github", source: { source: "github", repo: "fictional-org/github-plugin" }, version: "7.7.1" },
    { name: "fictional-url", source: { source: "url", url: "https://example.invalid/url-plugin" }, version: "7.7.2" },
    { name: "fictional-subdir", source: { source: "git-subdir", url: "https://example.invalid/repository.git", path: "plugins/subdir" }, version: "7.7.3" },
    { name: "fictional-npm", source: { source: "npm", package: "@fictional/plugin" }, version: "7.7.4" },
    { name: "fictional-archive", source: { source: "archive", url: "https://example.invalid/plugin.tgz" }, version: "7.7.5" },
    {
      name: "fictional-command",
      source: { source: "command", command: "install-fictional-plugin", timeout: 60, mode: "link" },
      version: "7.7.6",
    },
  ];
  writeJson(root, ".claude-plugin/plugin.json", pluginManifest("fictional-claude", "0.1.0"));
  writeJson(root, ".claude-plugin/marketplace.json", claudeMarketplace([
      { name: "fictional-claude", source: "./", version: "0.1.0" },
      ...externalPlugins,
  ], { version: "9.9.9" }));
  trackFixture(root);

  loadSynchronizer()({ root, version: "4.8.0" });

  const marketplace = readJson(root, ".claude-plugin/marketplace.json");
  assert.equal(marketplace.version, "9.9.9");
  assert.equal(marketplace.plugins[0].version, "4.8.0");
  assert.deepEqual(marketplace.plugins.slice(1), externalPlugins);
});

test("rejects Claude remote string sources atomically", (t) => {
  const root = createFixture(t);
  const manifestPath = ".claude-plugin/plugin.json";
  const marketplacePath = ".claude-plugin/marketplace.json";
  writeJson(root, manifestPath, pluginManifest("fictional-claude", "0.1.0"));
  writeJson(root, marketplacePath, claudeMarketplace([
      { name: "fictional-claude", source: "./", version: "0.1.0" },
      { name: "fictional-remote", source: "https://example.invalid/plugin.git", version: "7.7.7" },
  ]));
  trackFixture(root);
  const originalManifest = fs.readFileSync(path.join(root, manifestPath));
  const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

  assert.throws(
    () => loadSynchronizer()({ root, version: "4.8.0" }),
    /Malformed recognised marketplace/i,
  );

  assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
  assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
});

test("resolves Claude bare names through pluginRoot while keeping ./ paths at the marketplace root", (t) => {
  const root = createFixture(t);
  const bareManifestPath = "catalog/plugins/fictional-claude/.claude-plugin/plugin.json";
  const relativeManifestPath = "catalog/direct-plugin/.claude-plugin/plugin.json";
  const marketplacePath = "catalog/.claude-plugin/marketplace.json";
  writeJson(root, bareManifestPath, pluginManifest("fictional-claude", "0.1.0"));
  writeJson(root, relativeManifestPath, pluginManifest("fictional-direct", "0.1.0"));
  writeJson(root, marketplacePath, claudeMarketplace([
      { name: "fictional-claude", source: "fictional-claude", version: "0.1.0" },
      { name: "fictional-direct", source: "./direct-plugin", version: "0.1.0" },
  ], { metadata: { pluginRoot: "./plugins" } }));
  trackFixture(root);

  const changedFiles = loadSynchronizer()({ root, version: "4.8.0" });

  assert.deepEqual(changedFiles.sort(), [bareManifestPath, relativeManifestPath, marketplacePath].sort());
  assert.equal(readJson(root, bareManifestPath).version, "4.8.0");
  assert.equal(readJson(root, relativeManifestPath).version, "4.8.0");
  assert.deepEqual(readJson(root, marketplacePath).plugins.map((plugin) => plugin.version), ["4.8.0", "4.8.0"]);
});

test("rejects duplicate marketplace plugin names before changing files", (t) => {
  const root = createFixture(t);
  const manifestPath = ".claude-plugin/plugin.json";
  const marketplacePath = ".claude-plugin/marketplace.json";
  writeJson(root, manifestPath, pluginManifest("fictional-claude", "0.1.0"));
  writeJson(root, marketplacePath, claudeMarketplace([
      { name: "fictional-claude", source: "./", version: "0.1.0" },
      { name: "fictional-claude", source: { source: "github", repo: "fictional-org/plugin" } },
  ]));
  trackFixture(root);
  const originalManifest = fs.readFileSync(path.join(root, manifestPath));
  const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

  assert.throws(
    () => loadSynchronizer()({ root, version: "4.8.0" }),
    /duplicate plugin name/i,
  );

  assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
  assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
});

test("rejects a Claude bare local source without metadata.pluginRoot atomically", (t) => {
  const root = createFixture(t);
  const manifestPath = "plugins/fictional-claude/.claude-plugin/plugin.json";
  const marketplacePath = ".claude-plugin/marketplace.json";
  writeJson(root, manifestPath, pluginManifest("fictional-claude", "0.1.0"));
  writeJson(root, marketplacePath, claudeMarketplace([
    { name: "fictional-claude", source: "fictional-claude", version: "0.1.0" },
  ]));
  trackFixture(root);
  const originalManifest = fs.readFileSync(path.join(root, manifestPath));
  const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

  assert.throws(
    () => loadSynchronizer()({ root, version: "4.8.0" }),
    /metadata\.pluginRoot/i,
  );

  assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
  assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
});

test("rejects incomplete Claude external source descriptors atomically", (t) => {
  const invalidSources = [
    { source: "github" },
    { source: "github", repo: 42 },
    { source: "url" },
    { source: "git-subdir", url: "https://example.invalid/repository.git" },
    { source: "git-subdir", path: "plugins/fictional" },
    { source: "npm" },
    { source: "npm", package: "@fictional/plugin", version: 42 },
    { source: "archive" },
    { source: "command" },
    { source: "unknown", value: "fictional" },
  ];

  for (const source of invalidSources) {
    const root = createFixture(t);
    const manifestPath = ".claude-plugin/plugin.json";
    const marketplacePath = ".claude-plugin/marketplace.json";
    writeJson(root, manifestPath, pluginManifest("fictional-claude", "0.1.0"));
    writeJson(root, marketplacePath, claudeMarketplace([
      { name: `fictional-${source.source}`, source, version: "0.1.0" },
    ]));
    trackFixture(root);
    const originalManifest = fs.readFileSync(path.join(root, manifestPath));
    const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

    assert.throws(
      () => loadSynchronizer()({ root, version: "4.8.0" }),
      /Malformed recognised marketplace/i,
      source.source,
    );

    assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
    assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
  }
});

test("rejects semantically invalid Claude external source descriptors atomically", (t) => {
  const invalidSources = [
    { source: "github", repo: "fictional-org" },
    { source: "github", repo: "fictional-org/plugin/extra" },
    { source: "github", repo: "fictional-org/plugin", sha: "deadbeef" },
    { source: "url", url: "not-a-git-url" },
    { source: "url", url: "https://example.invalid/plugin.git", ref: " " },
    { source: "url", url: "git@example.invalid:fictional/plugin.git", sha: "not-a-full-sha" },
    { source: "git-subdir", url: "fictional-org/repository", path: "plugins/../outside" },
    { source: "git-subdir", url: "invalid-shorthand/with/extra", path: "plugins/fictional" },
    { source: "archive", url: "http://127.0.0.1/plugin.zip" },
    { source: "archive", url: "https://example.invalid/plugin.zip", sha256: "deadbeef" },
    { source: "npm", package: "../malicious" },
    { source: "npm", package: "@fictional" },
    { source: "npm", package: "@fictional/plugin", version: "../malicious" },
    { source: "npm", package: "@fictional/plugin", version: " .. " },
    { source: "npm", package: "@fictional/plugin", registry: "https://user:pass@registry.example.invalid" },
    { source: "npm", package: "@fictional/plugin", registry: "https://registry.example.invalid/?token=fake" },
  ];

  for (const source of invalidSources) {
    const root = createFixture(t);
    const manifestPath = ".claude-plugin/plugin.json";
    const marketplacePath = ".claude-plugin/marketplace.json";
    writeJson(root, manifestPath, pluginManifest("fictional-claude", "0.1.0"));
    writeJson(root, marketplacePath, claudeMarketplace([
      { name: "fictional-claude", source: "./", version: "0.1.0" },
      { name: `fictional-${source.source}`, source, version: "7.7.7" },
    ]));
    trackFixture(root);
    const originalManifest = fs.readFileSync(path.join(root, manifestPath));
    const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

    assert.throws(
      () => loadSynchronizer()({ root, version: "4.8.0" }),
      /Malformed recognised marketplace/i,
      JSON.stringify(source),
    );

    assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
    assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
  }
});

test("preserves semantically valid Claude external source descriptors", (t) => {
  const root = createFixture(t);
  const fullSha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  const archiveSha = "6bfa50e3d2e00c052b46abe51fff89346ac803e45771f76dcf6df1ab74cca5e1";
  const externalPlugins = [
    { name: "github", source: { source: "github", repo: "fictional-org/plugin", ref: "main", sha: fullSha } },
    { name: "https", source: { source: "url", url: "https://example.invalid/plugin.git", sha: fullSha } },
    { name: "ssh", source: { source: "url", url: "git@example.invalid:fictional/plugin.git", ref: "main" } },
    { name: "subdir", source: { source: "git-subdir", url: "fictional-org/repository", path: "./plugins/fictional", sha: fullSha } },
    { name: "archive", source: { source: "archive", url: "https://example.invalid/plugin.zip", sha256: archiveSha } },
    { name: "npm", source: { source: "npm", package: "@fictional/plugin", version: "^2.0.0", registry: "https://registry.example.invalid/plugins" } },
  ];
  writeJson(root, ".claude-plugin/plugin.json", pluginManifest("fictional-claude", "0.1.0"));
  writeJson(root, ".claude-plugin/marketplace.json", claudeMarketplace([
    { name: "fictional-claude", source: "./", version: "0.1.0" },
    ...externalPlugins,
  ]));
  trackFixture(root);

  loadSynchronizer()({ root, version: "4.8.0" });

  assert.deepEqual(readJson(root, ".claude-plugin/marketplace.json").plugins.slice(1), externalPlugins);
});

test("rejects marketplaces with missing required top-level fields atomically", (t) => {
  const cases = [
    {
      marketplacePath: ".claude-plugin/marketplace.json",
      manifestPath: ".claude-plugin/plugin.json",
      manifestName: "fictional-claude",
      marketplace: { owner: { name: "Fictional Team" }, plugins: [] },
    },
    {
      marketplacePath: ".claude-plugin/marketplace.json",
      manifestPath: ".claude-plugin/plugin.json",
      manifestName: "fictional-claude",
      marketplace: { name: "fictional-marketplace", plugins: [] },
    },
    {
      marketplacePath: ".claude-plugin/marketplace.json",
      manifestPath: ".claude-plugin/plugin.json",
      manifestName: "fictional-claude",
      marketplace: { name: "fictional-marketplace", owner: "Fictional Team", plugins: [] },
    },
    {
      marketplacePath: ".claude-plugin/marketplace.json",
      manifestPath: ".claude-plugin/plugin.json",
      manifestName: "fictional-claude",
      marketplace: { name: "fictional-marketplace", owner: {}, plugins: [] },
    },
    {
      marketplacePath: ".agents/plugins/marketplace.json",
      manifestPath: ".codex-plugin/plugin.json",
      manifestName: "fictional-codex",
      marketplace: { plugins: [] },
    },
  ];

  for (const fixture of cases) {
    const root = createFixture(t);
    writeJson(root, fixture.manifestPath, pluginManifest(fixture.manifestName, "0.1.0"));
    writeJson(root, fixture.marketplacePath, fixture.marketplace);
    trackFixture(root);
    const originalManifest = fs.readFileSync(path.join(root, fixture.manifestPath));
    const originalMarketplace = fs.readFileSync(path.join(root, fixture.marketplacePath));

    assert.throws(
      () => loadSynchronizer()({ root, version: "4.8.0" }),
      /Malformed recognised marketplace/i,
      fixture.marketplacePath,
    );

    assert.deepEqual(fs.readFileSync(path.join(root, fixture.manifestPath)), originalManifest);
    assert.deepEqual(fs.readFileSync(path.join(root, fixture.marketplacePath)), originalMarketplace);
  }
});

test("rejects invalid Claude command source descriptors atomically", (t) => {
  const invalidSources = [
    { source: "command", command: "" },
    { source: "command", command: "install\u0007plugin" },
    { source: "command", command: "x".repeat(501) },
    { source: "command", command: "install    plugin" },
    { source: "command", command: "install-plugin", timeout: 0 },
    { source: "command", command: "install-plugin", timeout: 601 },
    { source: "command", command: "install-plugin", timeout: 1.5 },
    { source: "command", command: "install-plugin", timeout: "60" },
    { source: "command", command: "install-plugin", mode: "unsafe" },
    { source: "command", command: "install-plugin", mode: 42 },
    { source: "command", command: "install-plugin", unexpected: true },
  ];

  for (const source of invalidSources) {
    const root = createFixture(t);
    const manifestPath = ".claude-plugin/plugin.json";
    const marketplacePath = ".claude-plugin/marketplace.json";
    writeJson(root, manifestPath, pluginManifest("fictional-claude", "0.1.0"));
    writeJson(root, marketplacePath, claudeMarketplace([
      { name: "fictional-claude", source: "./", version: "0.1.0" },
      { name: "fictional-command", source, version: "7.7.7" },
    ]));
    trackFixture(root);
    const originalManifest = fs.readFileSync(path.join(root, manifestPath));
    const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

    assert.throws(
      () => loadSynchronizer()({ root, version: "4.8.0" }),
      /Malformed recognised marketplace/i,
      JSON.stringify(source),
    );

    assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
    assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
  }
});

test("rejects unsafe Claude metadata.pluginRoot values before changing files", (t) => {
  const unsafePluginRoots = [
    "/outside",
    "C:\\outside",
    "\\\\fictional-server\\plugins",
    "../plugins",
    "plugins/../outside",
  ];

  for (const pluginRoot of unsafePluginRoots) {
    const root = createFixture(t);
    const manifestPath = "catalog/plugins/fictional-claude/.claude-plugin/plugin.json";
    const marketplacePath = "catalog/.claude-plugin/marketplace.json";
    writeJson(root, manifestPath, pluginManifest("fictional-claude", "0.1.0"));
    writeJson(root, marketplacePath, claudeMarketplace([
      { name: "fictional-claude", source: "fictional-claude", version: "0.1.0" },
    ], { metadata: { pluginRoot } }));
    trackFixture(root);
    const originalManifest = fs.readFileSync(path.join(root, manifestPath));
    const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

    assert.throws(
      () => loadSynchronizer()({ root, version: "4.8.0" }),
      /escapes the marketplace root/i,
      pluginRoot,
    );

    assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
    assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
  }
});

test("rejects a nested Claude marketplace source that escapes its root atomically", (t) => {
  const root = createFixture(t);
  const manifestPath = "outside/.claude-plugin/plugin.json";
  const marketplacePath = "catalog/.claude-plugin/marketplace.json";
  writeJson(root, manifestPath, pluginManifest("fictional-claude", "0.1.0"));
  writeJson(root, marketplacePath, claudeMarketplace([
    { name: "fictional-claude", source: "../outside", version: "0.1.0" },
  ]));
  trackFixture(root);
  const originalManifest = fs.readFileSync(path.join(root, manifestPath));
  const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

  assert.throws(
    () => loadSynchronizer()({ root, version: "4.8.0" }),
    /escapes the marketplace root/i,
  );

  assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
  assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
});

test("rejects a nested Codex marketplace source that escapes its root atomically", (t) => {
  const root = createFixture(t);
  const manifestPath = "outside/.codex-plugin/plugin.json";
  const marketplacePath = "catalog/.agents/plugins/marketplace.json";
  writeJson(root, manifestPath, pluginManifest("fictional-codex", "0.1.0"));
  writeJson(root, marketplacePath, codexMarketplace([
      {
        name: "fictional-codex",
        source: { source: "local", path: "../outside" },
        version: "0.1.0",
      },
  ]));
  trackFixture(root);
  const originalManifest = fs.readFileSync(path.join(root, manifestPath));
  const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

  assert.throws(
    () => loadSynchronizer()({ root, version: "4.8.0" }),
    /escapes the marketplace root/i,
  );

  assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
  assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
});

test("rejects unsafe Codex string local sources atomically", (t) => {
  const unsafeSources = [
    "plugins/local",
    "../outside",
    "/outside",
    "C:\\outside",
    "\\\\fictional-server\\plugins",
    "https://example.invalid/plugin.git",
  ];

  for (const source of unsafeSources) {
    const root = createFixture(t);
    const manifestPath = ".codex-plugin/plugin.json";
    const marketplacePath = ".agents/plugins/marketplace.json";
    writeJson(root, manifestPath, pluginManifest("fictional-codex", "0.1.0"));
    writeJson(root, marketplacePath, codexMarketplace([
      { name: "fictional-codex", source, version: "0.1.0" },
    ]));
    trackFixture(root);
    const originalManifest = fs.readFileSync(path.join(root, manifestPath));
    const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

    assert.throws(() => loadSynchronizer()({ root, version: "4.8.0" }), undefined, source);

    assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
    assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
  }
});

test("resolves an official Codex local marketplace entry and synchronizes its existing version", (t) => {
  const root = createFixture(t);
  writeJson(root, ".codex-plugin/plugin.json", pluginManifest("fictional-codex", "0.1.0"));
  writeJson(root, ".agents/plugins/marketplace.json", codexMarketplace([
      {
        name: "fictional-codex",
        source: { source: "local", path: "." },
        version: "0.1.0",
      },
  ]));
  trackFixture(root);

  loadSynchronizer()({ root, version: "4.8.0" });

  const marketplace = readJson(root, ".agents/plugins/marketplace.json");
  assert.equal(marketplace.plugins[0].version, "4.8.0");
  assert.equal(readJson(root, ".codex-plugin/plugin.json").version, "4.8.0");
});

test("keeps an official resolved Codex marketplace entry without a version unchanged", (t) => {
  const root = createFixture(t);
  writeJson(root, ".codex-plugin/plugin.json", pluginManifest("fictional-codex", "0.1.0"));
  writeJson(root, ".agents/plugins/marketplace.json", codexMarketplace([
    { name: "fictional-codex", source: { source: "local", path: "." } },
  ]));
  trackFixture(root);

  loadSynchronizer()({ root, version: "4.8.0" });

  const marketplace = readJson(root, ".agents/plugins/marketplace.json");
  assert.equal("version" in marketplace.plugins[0], false);
  assert.equal(readJson(root, ".codex-plugin/plugin.json").version, "4.8.0");
});

test("preserves official external Codex marketplace entries", (t) => {
  const root = createFixture(t);
  const externalPlugins = [
    {
      name: "fictional-url-codex",
      source: {
        source: "url",
        url: "https://example.invalid/external-codex-plugin.git",
        path: "plugins/fictional",
        ref: "main",
        sha: "fictional-sha",
      },
      version: "7.7.6",
    },
    {
      name: "fictional-git-subdir-codex",
      source: {
        source: "git-subdir",
        url: "fictional-org/external-codex-plugin",
        path: "plugins/fictional",
        ref: "main",
      },
      version: "7.7.7",
    },
    {
      name: "fictional-npm-codex",
      source: {
        source: "npm",
        package: "@fictional/codex-plugin",
        version: "^7.7.0",
        registry: "https://registry.example.invalid",
      },
      version: "7.7.8",
    },
  ];
  writeJson(root, ".codex-plugin/plugin.json", pluginManifest("fictional-codex", "0.1.0"));
  writeJson(root, ".agents/plugins/marketplace.json", codexMarketplace([
      { name: "fictional-codex", source: { source: "local", path: "." }, version: "0.1.0" },
      ...externalPlugins,
  ]));
  trackFixture(root);

  loadSynchronizer()({ root, version: "4.8.0" });

  const marketplace = readJson(root, ".agents/plugins/marketplace.json");
  assert.equal(marketplace.plugins[0].version, "4.8.0");
  assert.deepEqual(marketplace.plugins.slice(1), externalPlugins);
});

test("resolves official Codex string local sources", (t) => {
  const root = createFixture(t);
  const relativeManifestPath = "plugins/relative/.codex-plugin/plugin.json";
  const marketplacePath = ".agents/plugins/marketplace.json";
  writeJson(root, relativeManifestPath, pluginManifest("fictional-relative", "0.1.0"));
  writeJson(root, marketplacePath, codexMarketplace([
      { name: "fictional-relative", source: "./plugins/relative", version: "0.1.0" },
  ]));
  trackFixture(root);

  loadSynchronizer()({ root, version: "4.8.0" });

  assert.equal(readJson(root, relativeManifestPath).version, "4.8.0");
  assert.equal(readJson(root, marketplacePath).plugins[0].version, "4.8.0");
});

test("rejects invalid Codex source descriptors atomically", (t) => {
  const invalidSources = [
    { source: "local" },
    { source: "local", path: "plugins/fictional" },
    { source: "url" },
    { source: "url", url: "https://example.invalid/plugin.git", path: "../outside" },
    { source: "url", url: "https://example.invalid/plugin.git", ref: 42 },
    { source: "git-subdir", url: "fictional-org/repository" },
    { source: "git-subdir", path: "plugins/fictional" },
    { source: "npm" },
    { source: "npm", package: "@fictional/codex-plugin", version: 42 },
    { source: "npm", package: "@fictional/codex-plugin", registry: {} },
    { source: "github", repo: "fictional-org/plugin" },
    { source: "unknown", value: "fictional" },
  ];

  for (const source of invalidSources) {
    const root = createFixture(t);
    const manifestPath = ".codex-plugin/plugin.json";
    const marketplacePath = ".agents/plugins/marketplace.json";
    writeJson(root, manifestPath, pluginManifest("fictional-codex", "0.1.0"));
    writeJson(root, marketplacePath, codexMarketplace([
        { name: "fictional-codex", source: { source: "local", path: "." }, version: "0.1.0" },
        { name: `fictional-${source.source}`, source, version: "7.7.7" },
    ]));
    trackFixture(root);
    const originalManifest = fs.readFileSync(path.join(root, manifestPath));
    const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

    assert.throws(
      () => loadSynchronizer()({ root, version: "4.8.0" }),
      /Malformed recognised marketplace/i,
      source.source,
    );

    assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
    assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
  }
});

test("rejects semantically invalid Codex external source descriptors atomically", (t) => {
  const invalidSources = [
    { source: "url", url: "not-a-valid-git-source" },
    { source: "url", url: "file://relative/plugin.git" },
    { source: "url", url: "file:///fictional/../outside.git" },
    { source: "url", url: "../outside/plugin.git" },
    { source: "url", url: "https://example.invalid/plugin.git", path: "plugins/../outside" },
    { source: "git-subdir", url: "https://example.invalid/plugin.git", path: "/absolute" },
    { source: "npm", package: "../malicious" },
    { source: "npm", package: "@fictional" },
    { source: "npm", package: "@fictional/plugin", version: "git:https://example.invalid/plugin" },
    { source: "npm", package: "@fictional/plugin", version: "../outside" },
    { source: "npm", package: "@fictional/plugin", version: " .. " },
    { source: "npm", package: "@fictional/plugin", registry: "http://registry.example.invalid" },
    { source: "npm", package: "@fictional/plugin", registry: "https://user:pass@registry.example.invalid" },
    { source: "npm", package: "@fictional/plugin", registry: "https://registry.example.invalid/?token=fake" },
  ];

  for (const source of invalidSources) {
    const root = createFixture(t);
    const manifestPath = ".codex-plugin/plugin.json";
    const marketplacePath = ".agents/plugins/marketplace.json";
    writeJson(root, manifestPath, pluginManifest("fictional-codex", "0.1.0"));
    writeJson(root, marketplacePath, codexMarketplace([
      { name: "fictional-codex", source: { source: "local", path: "." }, version: "0.1.0" },
      { name: `fictional-${source.source}`, source, version: "7.7.7" },
    ]));
    trackFixture(root);
    const originalManifest = fs.readFileSync(path.join(root, manifestPath));
    const originalMarketplace = fs.readFileSync(path.join(root, marketplacePath));

    assert.throws(
      () => loadSynchronizer()({ root, version: "4.8.0" }),
      /Malformed recognised marketplace/i,
      JSON.stringify(source),
    );

    assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
    assert.deepEqual(fs.readFileSync(path.join(root, marketplacePath)), originalMarketplace);
  }
});

test("preserves semantically valid Codex git source forms", (t) => {
  const root = createFixture(t);
  const externalPlugins = [
    { name: "https", source: { source: "url", url: "https://example.invalid/plugin.git" } },
    { name: "ssh", source: { source: "url", url: "ssh://git@example.invalid/fictional/plugin.git" } },
    { name: "scp", source: { source: "url", url: "git@example.invalid:fictional/plugin.git" } },
    { name: "file", source: { source: "url", url: "file:///fictional/plugin.git" } },
    { name: "relative", source: { source: "url", url: "./repositories/plugin.git" } },
    { name: "shorthand", source: { source: "url", url: "fictional-org/plugin" } },
    { name: "subdir", source: { source: "git-subdir", url: "fictional-org/repository", path: "./plugins/fictional" } },
  ];
  writeJson(root, ".codex-plugin/plugin.json", pluginManifest("fictional-codex", "0.1.0"));
  writeJson(root, ".agents/plugins/marketplace.json", codexMarketplace([
    { name: "fictional-codex", source: { source: "local", path: "." }, version: "0.1.0" },
    ...externalPlugins,
  ]));
  trackFixture(root);

  loadSynchronizer()({ root, version: "4.8.0" });

  assert.deepEqual(readJson(root, ".agents/plugins/marketplace.json").plugins.slice(1), externalPlugins);
});

test("rejects unresolved local marketplace entries before changing manifests", (t) => {
  const root = createFixture(t);
  const manifestPath = ".claude-plugin/plugin.json";
  writeJson(root, manifestPath, pluginManifest("fictional-claude", "0.1.0"));
  writeJson(root, ".claude-plugin/marketplace.json", claudeMarketplace([
    { name: "fictional-missing", source: "./plugins/missing", version: "0.1.0" },
  ]));
  trackFixture(root);
  const originalManifest = fs.readFileSync(path.join(root, manifestPath));

  assert.throws(() => loadSynchronizer()({ root, version: "4.8.0" }), /local marketplace entry/i);

  assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
});

test("rejects local marketplace entries whose names differ from their manifests", (t) => {
  const root = createFixture(t);
  const manifestPath = ".codex-plugin/plugin.json";
  writeJson(root, manifestPath, pluginManifest("fictional-codex", "0.1.0"));
  writeJson(root, ".agents/plugins/marketplace.json", codexMarketplace([
    { name: "fictional-other", source: { source: "local", path: "." }, version: "0.1.0" },
  ]));
  trackFixture(root);
  const originalManifest = fs.readFileSync(path.join(root, manifestPath));

  assert.throws(() => loadSynchronizer()({ root, version: "4.8.0" }), /local marketplace entry/i);

  assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
});

test("rejects unresolved official Codex local marketplace entries before changing manifests", (t) => {
  const root = createFixture(t);
  const manifestPath = ".codex-plugin/plugin.json";
  writeJson(root, manifestPath, pluginManifest("fictional-codex", "0.1.0"));
  writeJson(root, ".agents/plugins/marketplace.json", codexMarketplace([
    { name: "fictional-missing", source: { source: "local", path: "./plugins/missing" }, version: "0.1.0" },
  ]));
  trackFixture(root);
  const originalManifest = fs.readFileSync(path.join(root, manifestPath));

  assert.throws(() => loadSynchronizer()({ root, version: "4.8.0" }), /local marketplace entry/i);

  assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
});

test("rejects Windows absolute and UNC paths in Claude local marketplace entries", (t) => {
  for (const unsafeSource of ["C:\\outside", "C:/outside", "\\\\fictional-server\\plugins", "//fictional-server/plugins"]) {
    const root = createFixture(t);
    writeJson(root, ".claude-plugin/plugin.json", pluginManifest("fictional-claude", "0.1.0"));
    writeJson(root, ".claude-plugin/marketplace.json", claudeMarketplace([
      { name: "fictional-claude", source: unsafeSource, version: "0.1.0" },
    ]));
    trackFixture(root);
    const originalManifest = fs.readFileSync(path.join(root, ".claude-plugin/plugin.json"));

    assert.throws(() => loadSynchronizer()({ root, version: "4.8.0" }), /escapes the marketplace root/i, unsafeSource);

    assert.deepEqual(fs.readFileSync(path.join(root, ".claude-plugin/plugin.json")), originalManifest);
  }
});

test("rejects invalid Semantic Versions without changing plugin manifests", (t) => {
  const root = createFixture(t);
  const manifestPath = ".claude-plugin/plugin.json";
  writeJson(root, manifestPath, pluginManifest("fictional-claude", "0.1.0"));
  trackFixture(root);
  const originalManifest = fs.readFileSync(path.join(root, manifestPath));

  assert.throws(() => loadSynchronizer()({ root, version: "01.2.3" }), /strict Semantic Version/i);

  assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
});

test("rejects malformed recognized marketplace structures before changing manifests", (t) => {
  const root = createFixture(t);
  const manifestPath = ".claude-plugin/plugin.json";
  writeJson(root, manifestPath, pluginManifest("fictional-claude", "0.1.0"));
  writeJson(root, ".claude-plugin/marketplace.json", { plugins: { name: "not-an-array" } });
  trackFixture(root);
  const originalManifest = fs.readFileSync(path.join(root, manifestPath));

  assert.throws(() => loadSynchronizer()({ root, version: "4.8.0" }), /Malformed recognised marketplace/i);

  assert.deepEqual(fs.readFileSync(path.join(root, manifestPath)), originalManifest);
});

test("uses one synchronization call to apply the final version after multiple release tags", (t) => {
  const root = createFixture(t);
  writeJson(root, ".claude-plugin/plugin.json", pluginManifest("fictional-claude", "0.1.0"));
  writeJson(root, "plugins/codex-copy/.codex-plugin/plugin.json", pluginManifest("fictional-codex", "0.1.0"));
  trackFixture(root);
  commitFixture(root, "chore: create fictional plugin fixture");
  createReleaseTag(root, "v3.0.0", "feat: first fictional release");
  createReleaseTag(root, "v3.1.0", "feat: second fictional release");
  createReleaseTag(root, "v3.1.1", "fix: final fictional release");

  const synchronizationCalls = [];
  const changedFiles = synchronizeLatestRelease({
    root,
    synchronize: (options) => {
      synchronizationCalls.push(options);
      return loadSynchronizer()(options);
    },
  });

  assert.deepEqual(synchronizationCalls, [{ root, version: "3.1.1" }]);
  assert.deepEqual(changedFiles.sort(), [".claude-plugin/plugin.json", "plugins/codex-copy/.codex-plugin/plugin.json"]);
  assert.equal(readJson(root, ".claude-plugin/plugin.json").version, "3.1.1");
  assert.equal(readJson(root, "plugins/codex-copy/.codex-plugin/plugin.json").version, "3.1.1");
});

test("rejects malformed recognized JSON before changing previously valid plugin files", (t) => {
  const root = createFixture(t);
  const validManifest = ".claude-plugin/plugin.json";
  writeJson(root, validManifest, pluginManifest("fictional-claude", "0.1.0"));
  const malformedManifest = path.join(root, "plugins", "broken", ".codex-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(malformedManifest), { recursive: true });
  fs.writeFileSync(malformedManifest, '{ "name": "fictional-broken", ');
  trackFixture(root);
  const originalBytes = fs.readFileSync(path.join(root, validManifest));

  const synchronizer = loadSynchronizer();
  assert.throws(() => synchronizer({ root, version: "4.8.0" }));

  assert.deepEqual(fs.readFileSync(path.join(root, validManifest)), originalBytes);
});

test("rejects symlinked recognized plugin files before changing their targets", (t) => {
  const cases = [
    {
      recognizedPath: ".claude-plugin/plugin.json",
      targetPath: "manifest-target.json",
      targetValue: pluginManifest("fictional-claude", "0.1.0"),
    },
    {
      recognizedPath: ".claude-plugin/marketplace.json",
      targetPath: "marketplace-target.json",
      targetValue: claudeMarketplace([]),
    },
  ];

  for (const fixture of cases) {
    const root = createFixture(t);
    writeJson(root, fixture.targetPath, fixture.targetValue);
    const recognizedAbsolutePath = path.join(root, fixture.recognizedPath);
    fs.mkdirSync(path.dirname(recognizedAbsolutePath), { recursive: true });
    const relativeTarget = path.relative(path.dirname(recognizedAbsolutePath), path.join(root, fixture.targetPath));
    try {
      fs.symlinkSync(relativeTarget, recognizedAbsolutePath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symbolic links are unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    trackFixture(root);
    const originalTarget = fs.readFileSync(path.join(root, fixture.targetPath));

    assert.throws(
      () => loadSynchronizer()({ root, version: "4.8.0" }),
      /symbolic link/i,
      fixture.recognizedPath,
    );

    assert.deepEqual(fs.readFileSync(path.join(root, fixture.targetPath)), originalTarget);
  }
});

test("does nothing for a repository without recognized plugin files", (t) => {
  const root = createFixture(t);
  fs.writeFileSync(path.join(root, "README.md"), "Fictitious non-plugin repository\n");
  trackFixture(root);

  const changedFiles = loadSynchronizer()({ root, version: "4.8.0" });

  assert.deepEqual(changedFiles, []);
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "Fictitious non-plugin repository\n");
});
