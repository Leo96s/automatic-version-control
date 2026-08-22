#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CLAUDE_EXTERNAL_SOURCE_REQUIRED_FIELDS = new Map([
  ["github", ["repo"]],
  ["url", ["url"]],
  ["git-subdir", ["url", "path"]],
  ["npm", ["package"]],
  ["archive", ["url"]],
  ["command", ["command"]],
]);
const CLAUDE_EXTERNAL_SOURCE_ALLOWED_FIELDS = new Map([
  ["github", ["source", "repo", "ref", "sha"]],
  ["url", ["source", "url", "ref", "sha"]],
  ["git-subdir", ["source", "url", "path", "ref", "sha"]],
  ["npm", ["source", "package", "version", "registry"]],
  ["archive", ["source", "url", "sha256"]],
]);
const CODEX_EXTERNAL_SOURCE_REQUIRED_FIELDS = new Map([
  ["url", ["url"]],
  ["git-subdir", ["url", "path"]],
  ["npm", ["package"]],
]);
const CODEX_EXTERNAL_SOURCE_ALLOWED_FIELDS = new Map([
  ["url", ["source", "url", "path", "ref", "sha"]],
  ["git-subdir", ["source", "url", "path", "ref", "sha"]],
  ["npm", ["source", "package", "version", "registry"]],
]);
const SOURCE_OPTIONAL_STRING_FIELDS = new Map([
  ["github", ["ref", "sha"]],
  ["url", ["path", "ref", "sha"]],
  ["git-subdir", ["ref", "sha"]],
  ["npm", ["version", "registry"]],
  ["archive", ["sha256"]],
]);

const GITHUB_REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUsableString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertSafeRelativePath(filePath) {
  if (!isUsableString(filePath) || filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)) {
    throw new Error("Git returned an unsafe tracked path.");
  }

  const segments = filePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Git returned an unsafe tracked path.");
  }
}

function isExcludedTrackedPath(filePath) {
  const segments = filePath.split("/");
  return segments.includes(".git") || segments.includes("node_modules");
}

function getTrackedPaths(root) {
  let output;
  try {
    output = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("Unable to read tracked files from Git.");
  }

  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((filePath) => {
      assertSafeRelativePath(filePath);
      return filePath;
    })
    .filter((filePath) => !isExcludedTrackedPath(filePath));
}

function recognizedType(filePath) {
  if (filePath === ".claude-plugin/plugin.json" || filePath.endsWith("/.claude-plugin/plugin.json")) {
    return "claude-manifest";
  }
  if (filePath === ".codex-plugin/plugin.json" || filePath.endsWith("/.codex-plugin/plugin.json")) {
    return "codex-manifest";
  }
  if (filePath === ".claude-plugin/marketplace.json" || filePath.endsWith("/.claude-plugin/marketplace.json")) {
    return "claude-marketplace";
  }
  if (filePath === ".agents/plugins/marketplace.json" || filePath.endsWith("/.agents/plugins/marketplace.json")) {
    return "codex-marketplace";
  }
  return null;
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveTrackedFile(root, realRoot, filePath) {
  const absolutePath = path.resolve(root, ...filePath.split("/"));
  if (!isPathInside(root, absolutePath)) {
    throw new Error("A recognised plugin path escapes the repository.");
  }

  let currentPath = root;
  for (const segment of filePath.split("/")) {
    currentPath = path.join(currentPath, segment);
    let stats;
    try {
      stats = fs.lstatSync(currentPath);
    } catch {
      throw new Error(`Unable to read recognised plugin file "${filePath}".`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Recognised plugin file "${filePath}" contains a symbolic link.`);
    }
  }

  let realPath;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch {
    throw new Error(`Unable to read recognised plugin file "${filePath}".`);
  }
  if (!isPathInside(realRoot, realPath)) {
    throw new Error("A recognised plugin file resolves outside the repository.");
  }

  return absolutePath;
}

function parseJsonFile(absolutePath, filePath) {
  let content;
  try {
    content = fs.readFileSync(absolutePath, "utf8");
  } catch {
    throw new Error(`Unable to read recognised plugin file "${filePath}".`);
  }

  try {
    return { content, value: JSON.parse(content) };
  } catch {
    throw new Error(`Invalid JSON in recognised plugin file "${filePath}".`);
  }
}

function pluginDirectory(filePath) {
  return path.posix.dirname(path.posix.dirname(filePath));
}

function marketplaceRoot(filePath, type) {
  const suffix = type === "claude-marketplace"
    ? ".claude-plugin/marketplace.json"
    : ".agents/plugins/marketplace.json";
  const prefix = filePath.slice(0, -suffix.length).replace(/\/$/, "");
  return prefix || ".";
}

function validateManifest(record) {
  if (!isObject(record.value) || !isUsableString(record.value.name)) {
    throw new Error(`Malformed recognised plugin manifest "${record.filePath}".`);
  }
}

function isValidExternalSourceObject(source, requiredFieldsByType, allowedFieldsByType) {
  if (!isObject(source) || !isUsableString(source.source)) return false;
  const requiredFields = requiredFieldsByType.get(source.source);
  const allowedFields = allowedFieldsByType.get(source.source);
  if (requiredFields === undefined || allowedFields === undefined) return false;
  if (Object.keys(source).some((field) => !allowedFields.includes(field))) return false;
  if (!requiredFields.every((field) => isUsableString(source[field]))) return false;

  const optionalStringFields = SOURCE_OPTIONAL_STRING_FIELDS.get(source.source) || [];
  return optionalStringFields.every((field) => !(field in source) || isUsableString(source[field]));
}

function isValidClaudeCommandSource(source) {
  if (!isObject(source) || source.source !== "command") return false;
  const allowedFields = new Set(["source", "command", "timeout", "mode"]);
  if (Object.keys(source).some((field) => !allowedFields.has(field))) return false;
  if (!isUsableString(source.command)
    || source.command.length > 500
    || !/^[\x20-\x7E]+$/.test(source.command)
    || / {4}/.test(source.command)) {
    return false;
  }
  if ("timeout" in source
    && (!Number.isInteger(source.timeout) || source.timeout <= 0 || source.timeout > 600)) {
    return false;
  }
  return !("mode" in source) || source.mode === "copy" || source.mode === "link";
}

function isValidGitHubRepository(value) {
  if (!isUsableString(value)) return false;
  const segments = value.split("/");
  return segments.length === 2
    && segments.every((segment) => segment !== "."
      && segment !== ".."
      && GITHUB_REPOSITORY_SEGMENT_PATTERN.test(segment));
}

function isValidGitSelectors(source, { strictSha }) {
  if ("ref" in source && !isUsableString(source.ref)) return false;
  if (!("sha" in source)) return true;
  if (!isUsableString(source.sha)) return false;
  return !strictSha || SHA1_PATTERN.test(source.sha);
}

function hasGitHostAndPath(parsed) {
  return isUsableString(parsed.hostname) && parsed.pathname.length > 1;
}

function isValidScpGitUrl(value) {
  return /^git@(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):[^\s]+$/.test(value);
}

function isValidSafeRelativeGitUrl(value) {
  if (!value.startsWith("./") && !value.startsWith(".\\")) return false;
  const relativePath = value.slice(2);
  if (!relativePath) return false;
  return relativePath.split(/[\\/]/).every((segment) => segment && segment !== "." && segment !== "..");
}

function isValidAbsoluteFileUrl(value) {
  if (value.split(/[\\/]/).includes("..")) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "file:"
    && !parsed.hostname
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash
    && parsed.pathname.length > 1
    && parsed.pathname.startsWith("/");
}

function isValidGitUrl(value, { allowGitProtocol, allowFile, allowRelative, allowShorthand }) {
  if (!isUsableString(value)) return false;
  if (allowShorthand && isValidGitHubRepository(value)) return true;
  if (allowFile && isValidAbsoluteFileUrl(value)) return true;
  if (allowRelative && isValidSafeRelativeGitUrl(value)) return true;
  if (isValidScpGitUrl(value)) return true;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if ((parsed.protocol === "http:" || parsed.protocol === "https:")
    && isUsableString(parsed.hostname)) {
    return true;
  }
  if (parsed.protocol === "ssh:" && hasGitHostAndPath(parsed)) return true;
  return allowGitProtocol && parsed.protocol === "git:" && hasGitHostAndPath(parsed);
}

function parseIpv4Address(value) {
  const segments = value.split(".");
  if (segments.length !== 4 || segments.some((segment) => !/^\d+$/.test(segment))) return null;
  const numbers = segments.map(Number);
  return numbers.every((segment) => segment >= 0 && segment <= 255) ? numbers : null;
}

function parseIpv6Address(value) {
  let normalized = value.toLowerCase();
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    const ipv4 = parseIpv4Address(normalized.slice(separator + 1));
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    normalized = `${normalized.slice(0, separator + 1)}${high}:${low}`;
  }

  const sections = normalized.split("::");
  if (sections.length > 2) return null;
  const left = sections[0] ? sections[0].split(":") : [];
  const right = sections.length === 2 && sections[1] ? sections[1].split(":") : [];
  const parseSection = (section) => section.every((part) => /^[0-9a-f]{1,4}$/.test(part));
  if (!parseSection(left) || !parseSection(right)) return null;

  if (sections.length === 1) {
    return left.length === 8 ? left.map((part) => parseInt(part, 16)) : null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [
    ...left.map((part) => parseInt(part, 16)),
    ...Array(missing).fill(0),
    ...right.map((part) => parseInt(part, 16)),
  ];
}

function isBlockedArchiveHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host === "metadata.google.internal") return true;

  const ipv4 = parseIpv4Address(host);
  if (ipv4 && (ipv4[0] === 127 || (ipv4[0] === 169 && ipv4[1] === 254))) return true;

  const ipv6 = parseIpv6Address(host);
  if (!ipv6) return false;
  const value = ipv6.reduce((result, segment) => (result << 16n) | BigInt(segment), 0n);
  const isLoopback = value === 1n;
  const firstSegment = ipv6[0];
  const isLinkLocal = firstSegment >= 0xfe80 && firstSegment <= 0xfebf;
  const isMappedLocal = (value >> 32n) === 0xffffn
    && ((value & 0xffffffffn) >> 24n) === 127n;
  const isMappedLinkLocal = (value >> 32n) === 0xffffn
    && ((value & 0xffffffffn) >> 16n) === 0xa9fen;
  return isLoopback || isLinkLocal || isMappedLocal || isMappedLinkLocal;
}

function isValidArchiveUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:"
    && isUsableString(parsed.hostname)
    && !parsed.username
    && !parsed.password
    && !isBlockedArchiveHost(parsed.hostname);
}

function isValidNpmPackageName(value) {
  if (!isUsableString(value)) return false;
  const isScoped = value.startsWith("@");
  const packageWithoutScope = isScoped ? value.slice(1) : value;
  const segments = packageWithoutScope.split("/");
  const expectedSegments = isScoped ? 2 : 1;
  if (segments.length !== expectedSegments) return false;
  return segments.every((segment) => segment
    && segment !== "."
    && segment !== ".."
    && (isScoped || ![".", "_"].includes(segment[0]))
    && [...segment].every((character) => /[A-Za-z0-9_.-]/.test(character)));
}

function isValidNpmVersion(value) {
  if (!isUsableString(value)) return false;
  const normalized = value.trim();
  return normalized !== "."
    && normalized !== ".."
    && !/[\\/:]/.test(normalized);
}

function isValidNpmRegistry(value) {
  if (!isUsableString(value)) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:"
    && isUsableString(parsed.hostname)
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash;
}

function isValidRemoteSubdirectory(value) {
  if (!isUsableString(value) || value.includes("\\")) return false;
  const normalized = value.trim().startsWith("./") ? value.trim().slice(2) : value.trim();
  if (!normalized || normalized.startsWith("/")) return false;
  return normalized.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function isClaudeExternalSourceObject(source) {
  if (isObject(source) && source.source === "command") {
    return isValidClaudeCommandSource(source);
  }
  if (!isValidExternalSourceObject(
    source,
    CLAUDE_EXTERNAL_SOURCE_REQUIRED_FIELDS,
    CLAUDE_EXTERNAL_SOURCE_ALLOWED_FIELDS,
  )) return false;

  switch (source.source) {
    case "github":
      return isValidGitHubRepository(source.repo) && isValidGitSelectors(source, { strictSha: true });
    case "url":
      return isValidGitUrl(source.url, {
        allowGitProtocol: true,
        allowFile: false,
        allowRelative: false,
        allowShorthand: false,
      }) && isValidGitSelectors(source, { strictSha: true });
    case "git-subdir":
      return isValidGitUrl(source.url, {
        allowGitProtocol: true,
        allowFile: false,
        allowRelative: false,
        allowShorthand: true,
      })
        && isValidRemoteSubdirectory(source.path)
        && isValidGitSelectors(source, { strictSha: true });
    case "archive":
      return isValidArchiveUrl(source.url)
        && (!("sha256" in source) || SHA256_PATTERN.test(source.sha256));
    case "npm":
      return isValidNpmPackageName(source.package)
        && (!("version" in source) || isValidNpmVersion(source.version))
        && (!("registry" in source) || isValidNpmRegistry(source.registry));
    default:
      return false;
  }
}

function isValidCodexLocalSource(source) {
  return isObject(source)
    && source.source === "local"
    && Object.keys(source).every((field) => ["source", "path"].includes(field))
    && isUsableString(source.path);
}

function isCodexExternalSourceObject(source) {
  if (isValidCodexLocalSource(source)) return true;
  if (!isValidExternalSourceObject(
    source,
    CODEX_EXTERNAL_SOURCE_REQUIRED_FIELDS,
    CODEX_EXTERNAL_SOURCE_ALLOWED_FIELDS,
  )) return false;

  switch (source.source) {
    case "url":
      return isValidGitUrl(source.url, {
        allowGitProtocol: false,
        allowFile: true,
        allowRelative: true,
        allowShorthand: true,
      })
        && (!("path" in source) || isValidRemoteSubdirectory(source.path))
        && isValidGitSelectors(source, { strictSha: false });
    case "git-subdir":
      return isValidGitUrl(source.url, {
        allowGitProtocol: false,
        allowFile: true,
        allowRelative: true,
        allowShorthand: true,
      })
        && isValidRemoteSubdirectory(source.path)
        && isValidGitSelectors(source, { strictSha: false });
    case "npm":
      return isValidNpmPackageName(source.package)
        && (!("version" in source) || isValidNpmVersion(source.version))
        && (!("registry" in source) || isValidNpmRegistry(source.registry));
    default:
      return false;
  }
}

function validateMarketplace(record) {
  if (!isObject(record.value)
    || !isUsableString(record.value.name)
    || !Array.isArray(record.value.plugins)) {
    throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
  }

  if (record.type === "claude-marketplace") {
    if (!isObject(record.value.owner)
      || !isUsableString(record.value.owner.name)
      || ("email" in record.value.owner && !isUsableString(record.value.owner.email))
      || ("url" in record.value.owner && !isUsableString(record.value.owner.url))) {
      throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
    }
    const pluginRoot = getClaudePluginRoot(record);
    if (pluginRoot !== null) {
      resolveLocalDirectory(marketplaceRoot(record.filePath, record.type), pluginRoot);
    }
  }

  const pluginNames = new Set();
  for (const entry of record.value.plugins) {
    if (!isObject(entry) || !isUsableString(entry.name) || !("source" in entry)) {
      throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
    }
    if (pluginNames.has(entry.name)) {
      throw new Error(`Duplicate plugin name "${entry.name}" in marketplace "${record.filePath}".`);
    }
    pluginNames.add(entry.name);

    if (record.type === "claude-marketplace") {
      if (isUsableString(entry.source)) {
        resolveClaudeLocalDirectory(record, marketplaceRoot(record.filePath, record.type), entry.source);
      } else if (!isClaudeExternalSourceObject(entry.source)) {
        throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
      }
      continue;
    }

    const root = marketplaceRoot(record.filePath, record.type);
    if (isUsableString(entry.source)) {
      resolveCodexLocalDirectory(record, root, entry.source);
      continue;
    }
    if (!isObject(entry.source) || !isUsableString(entry.source.source)) {
      throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
    }
    if (entry.source.source === "local") {
      if (!isValidCodexLocalSource(entry.source)) {
        throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
      }
      resolveCodexLocalDirectory(record, root, entry.source.path);
    } else if (!isCodexExternalSourceObject(entry.source)) {
      throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
    }
  }
}

function isRemoteSourceString(source) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source);
}

function assertMarketplaceSourceIsNotAbsolute(source) {
  if (source.startsWith("/") || source.startsWith("\\") || /^[A-Za-z]:/.test(source)) {
    throw new Error("A marketplace source escapes the marketplace root.");
  }
}

function assertSafeLocalMarketplaceSource(source) {
  assertMarketplaceSourceIsNotAbsolute(source);
  if (source.includes("\\") || source.split("/").includes("..")) {
    throw new Error("A marketplace source escapes the marketplace root.");
  }
}

function resolveLocalDirectory(baseDirectory, source) {
  assertSafeLocalMarketplaceSource(source);

  const resolved = baseDirectory === "." ? [] : baseDirectory.split("/");
  for (const segment of source.split("/")) {
    if (!segment || segment === ".") continue;
    resolved.push(segment);
  }

  return resolved.length === 0 ? "." : resolved.join("/");
}

function getClaudePluginRoot(record) {
  if (!("metadata" in record.value)) return null;
  if (!isObject(record.value.metadata)) {
    throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
  }
  if (!("pluginRoot" in record.value.metadata)) return null;
  if (!isUsableString(record.value.metadata.pluginRoot)) {
    throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
  }
  return record.value.metadata.pluginRoot;
}

function resolveClaudeLocalDirectory(record, marketplaceDirectory, source) {
  assertSafeLocalMarketplaceSource(source);
  if (isRemoteSourceString(source)) {
    throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
  }
  const pluginRoot = getClaudePluginRoot(record);
  const isBareName = !source.startsWith(".") && !source.includes("/");
  if (!source.startsWith("./") && !isBareName) {
    throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
  }
  if (isBareName && pluginRoot === null) {
    throw new Error(`Claude bare plugin source "${source}" requires metadata.pluginRoot.`);
  }

  const sourceRoot = isBareName
    ? resolveLocalDirectory(marketplaceDirectory, pluginRoot)
    : marketplaceDirectory;
  return resolveLocalDirectory(sourceRoot, source);
}

function resolveCodexLocalDirectory(record, marketplaceDirectory, source) {
  assertSafeLocalMarketplaceSource(source);
  if (source !== "." && source !== "./" && !source.startsWith("./")) {
    throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
  }
  if (source === "." || source === "./") {
    return marketplaceDirectory;
  }

  const relativeSource = source.slice(2);
  if (!isValidRemoteSubdirectory(relativeSource)) {
    throw new Error(`Malformed recognised marketplace "${record.filePath}".`);
  }
  return resolveLocalDirectory(marketplaceDirectory, relativeSource);
}

function planManifestUpdates(records, version) {
  for (const record of records) {
    if (record.value.version !== version) {
      record.value.version = version;
      record.changed = true;
    }
  }
}

function planMarketplaceUpdates(records, manifests, version) {
  for (const record of records) {
    const root = marketplaceRoot(record.filePath, record.type);
    const manifestByDirectory = manifests[record.type === "claude-marketplace" ? "claude" : "codex"];

    for (const entry of record.value.plugins) {
      let directory;
      if (record.type === "claude-marketplace") {
        if (isObject(entry.source)) continue;
        directory = resolveClaudeLocalDirectory(record, root, entry.source);
      } else {
        if (isUsableString(entry.source)) {
          directory = resolveCodexLocalDirectory(record, root, entry.source);
        } else {
          if (entry.source.source !== "local") continue;
          directory = resolveCodexLocalDirectory(record, root, entry.source.path);
        }
      }

      const manifest = manifestByDirectory.get(directory);
      if (!manifest) {
        throw new Error(`A local marketplace entry in "${record.filePath}" does not resolve to a recognised plugin manifest.`);
      }
      if (manifest.value.name !== entry.name) {
        throw new Error(`A local marketplace entry in "${record.filePath}" does not match its plugin manifest name.`);
      }
      if (record.type === "codex-marketplace" && !("version" in entry)) continue;
      if (entry.version !== version) {
        entry.version = version;
        record.changed = true;
      }
    }
  }
}

function syncPluginVersions({ root, version }) {
  if (!isUsableString(root)) {
    throw new Error("A repository root is required.");
  }
  if (!isUsableString(version) || !SEMVER_PATTERN.test(version)) {
    throw new Error("A strict Semantic Version is required.");
  }

  const repositoryRoot = path.resolve(root);
  let realRoot;
  try {
    realRoot = fs.realpathSync(repositoryRoot);
  } catch {
    throw new Error("The repository root is not accessible.");
  }

  const records = getTrackedPaths(repositoryRoot)
    .map((filePath) => ({ filePath, type: recognizedType(filePath) }))
    .filter((record) => record.type)
    .map((record) => {
      const absolutePath = resolveTrackedFile(repositoryRoot, realRoot, record.filePath);
      return { ...record, absolutePath, ...parseJsonFile(absolutePath, record.filePath), changed: false };
    });

  const manifests = { claude: new Map(), codex: new Map() };
  const marketplaces = [];
  for (const record of records) {
    if (record.type.endsWith("manifest")) {
      validateManifest(record);
      const group = record.type === "claude-manifest" ? "claude" : "codex";
      manifests[group].set(pluginDirectory(record.filePath), record);
    } else {
      validateMarketplace(record);
      marketplaces.push(record);
    }
  }

  planManifestUpdates(records.filter((record) => record.type.endsWith("manifest")), version);
  planMarketplaceUpdates(marketplaces, manifests, version);

  const writes = records
    .filter((record) => record.changed)
    .map((record) => ({
      absolutePath: record.absolutePath,
      filePath: record.filePath,
      content: `${JSON.stringify(record.value, null, 2)}\n`,
    }));

  for (const write of writes) {
    fs.writeFileSync(write.absolutePath, write.content, "utf8");
  }

  return writes.map((write) => write.filePath);
}

function runCli() {
  const [version, ...extraArguments] = process.argv.slice(2);
  if (extraArguments.length > 0) {
    throw new Error("Usage: node scripts/sync-plugin-versions.js <version>");
  }

  const changedFiles = syncPluginVersions({ root: process.cwd(), version });
  console.log(changedFiles.length === 0
    ? "No plugin version changes required."
    : `Synchronized ${changedFiles.length} plugin version file(s).`);
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(`Plugin version synchronization failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { syncPluginVersions };
