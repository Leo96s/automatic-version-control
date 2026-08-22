"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const workflowPath = path.resolve(__dirname, "..", ".github", "workflows", "versioning.yml");
const pluginActionPath = path.resolve(__dirname, "..", ".github", "actions", "plugin-version-sync", "action.yml");
const synchronizerPath = path.resolve(__dirname, "..", "scripts", "sync-plugin-versions.js");

function git(root, args, options = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", ...options }).trim();
}

function commit(root, message) {
  git(root, ["-c", "user.email=fixtures@example.invalid", "-c", "user.name=Test Fixture", "commit", "--quiet", "-m", message]);
}

test("keeps the main-only release gate and invokes the optional plugin action after version calculation", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");

  assert.match(workflow, /branches:\s*\r?\n\s*- main/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);

  const versionCalculation = workflow.indexOf('echo "new_version=$FINAL_VERSION"');
  const synchronizer = workflow.indexOf("uses: ./.github/actions/plugin-version-sync");
  assert.ok(versionCalculation >= 0, "the workflow must calculate a final version");
  assert.ok(synchronizer > versionCalculation, "the plugin action must run after version calculation");
  assert.match(workflow, /if: env\.created_tags == '1' && hashFiles\('\.github\/actions\/plugin-version-sync\/action\.yml'\) != ''/);
  assert.match(workflow, /version: \$\{\{ env\.new_version \}\}/);
  assert.doesNotMatch(workflow, /\.claude-plugin\/plugin\.json|\.codex-plugin\/plugin\.json|\.agents\/plugins\/marketplace\.json/);
});

test("plugin action updates and stages all recognized plugin metadata", () => {
  const action = fs.readFileSync(pluginActionPath, "utf8");

  assert.match(action, /node scripts\/sync-plugin-versions\.js \"\$VERSION\"/);
  const stagingLoop = action.match(
    /git ls-files -z --(?<pathspecs>[\s\S]*?)\|\s*while IFS= read -r -d '' (?<fileVariable>[A-Za-z_][A-Za-z0-9_]*); do(?<body>[\s\S]*?)\bdone/,
  );
  assert.ok(stagingLoop?.groups, "the plugin action must pipe recognized files into a staging loop");

  const { pathspecs, fileVariable, body } = stagingLoop.groups;
  for (const recognizedPath of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
  ]) {
    assert.match(pathspecs, new RegExp(recognizedPath.replaceAll(".", "\\.")));
  }
  for (const excludedDirectory of [".git", "node_modules"]) {
    assert.match(pathspecs, new RegExp(`:\\(exclude,glob\\)\\*\\*/${excludedDirectory.replaceAll(".", "\\.")}\\/\\*\\*`));
  }
  assert.match(body, new RegExp(`git add\\s+--\\s+["']?\\$${fileVariable}["']?`));
});

test("retargets only the final release tag after the synchronized release commit", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const commitStep = workflow.match(
    /- name: Commit and Push everything[\s\S]*?run: \|(?<body>[\s\S]*?)(?=\n\s*- name: Create GitHub Release)/,
  );
  assert.ok(commitStep?.groups, "the workflow must contain the release commit and push step");

  const body = commitStep.groups.body;
  const commit = body.indexOf("git commit -m");
  const finalTagVariable = body.indexOf("FINAL_TAG=${{ env.new_version }}");
  const retargetFinalTag = body.indexOf('git tag -f "$FINAL_TAG" HEAD');
  const pushBranch = body.indexOf("git push origin HEAD");
  const pushFinalTag = body.indexOf('git push origin "refs/tags/$FINAL_TAG"');
  const pushIntermediateTags = body.indexOf("git push origin --tags");

  assert.ok(commit >= 0, "the synchronized files must be committed");
  assert.ok(finalTagVariable > commit, "the final tag must be selected after the release commit");
  assert.ok(retargetFinalTag > finalTagVariable, "the final tag must be retargeted to the release commit");
  assert.ok(pushBranch > retargetFinalTag, "the release commit must be pushed after retagging");
  assert.ok(pushFinalTag > pushBranch, "the corrected final tag must be pushed explicitly");
  assert.ok(pushIntermediateTags > pushFinalTag, "intermediate replay tags must be pushed without being moved");

  assert.equal((body.match(/git tag -f/g) || []).length, 1, "only the final tag may be moved");
  assert.match(workflow, /gh release create "\$\{\{ env\.new_version \}\}"/);
});

test("final tag contains synchronized plugin metadata while an intermediate tag keeps its original commit", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-version-control-tag-retarget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "core.autocrlf", "false"]);

  const manifestPath = ".claude-plugin/plugin.json";
  const absoluteManifestPath = path.join(root, manifestPath);
  fs.mkdirSync(path.dirname(absoluteManifestPath), { recursive: true });
  fs.writeFileSync(absoluteManifestPath, '{"name":"fictional-plugin","version":"0.1.0"}\n');
  git(root, ["add", "--", manifestPath]);
  commit(root, "chore: initial plugin");

  fs.writeFileSync(path.join(root, "intermediate.txt"), "intermediate\n");
  git(root, ["add", "--", "intermediate.txt"]);
  commit(root, "fix: intermediate release");
  const intermediateCommit = git(root, ["rev-parse", "HEAD"]);
  git(root, ["tag", "v0.1.1", intermediateCommit]);

  fs.writeFileSync(path.join(root, "final.txt"), "final\n");
  git(root, ["add", "--", "final.txt"]);
  commit(root, "fix: final release");
  git(root, ["tag", "v0.1.2", "HEAD"]);

  delete require.cache[synchronizerPath];
  require(synchronizerPath).syncPluginVersions({ root, version: "0.1.2" });
  git(root, ["add", "--", manifestPath]);
  commit(root, "chore(release): v0.1.2 [skip ci]");
  git(root, ["tag", "-f", "v0.1.2", "HEAD"]);

  const finalManifest = JSON.parse(git(root, ["show", `v0.1.2:${manifestPath}`]));
  const intermediateManifest = JSON.parse(git(root, ["show", `v0.1.1:${manifestPath}`]));
  assert.equal(finalManifest.version, "0.1.2");
  assert.equal(intermediateManifest.version, "0.1.0");
  assert.equal(git(root, ["rev-parse", "v0.1.1"]), intermediateCommit);
});
