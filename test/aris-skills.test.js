import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadArisSkills } from "../aris-skills.js";

const checkout = path.resolve(import.meta.dirname, "..");

test("unknown skills and traversal names cannot be loaded", () => {
  assert.throws(() => loadArisSkills(["skills-codex"]), /Unknown ARIS skill: "skills-codex"/);
  assert.throws(() => loadArisSkills(["../etc"]), /Unknown ARIS skill/);
});

// A copy of the module next to a mutilated pack: the API must refuse before the runtime enables ARIS mode.
async function withPack(mutate, check) {
  const root = mkdtempSync(path.join(tmpdir(), "aris-pack-"));
  try {
    for (const relative of ["aris-skills.js", "aris-provenance.json"]) cpSync(path.join(checkout, relative), path.join(root, relative));
    for (const directory of ["skills", "tools", "templates"]) cpSync(path.join(checkout, directory), path.join(root, directory), { recursive: true });
    mutate(root);
    check(await import(pathToFileURL(path.join(root, "aris-skills.js")).href));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("missing provenance is reported as not installed", () =>
  withPack(root => rmSync(path.join(root, "aris-provenance.json")), api => {
    assert.throws(api.validateArisInstall, /ARIS pack is not installed/);
  }));

test("missing skill directory is reported by every entry point", () =>
  withPack(root => rmSync(path.join(root, "skills", "paper-write"), { recursive: true }), api => {
    assert.throws(api.validateArisInstall, /skills\/paper-write\/SKILL\.md is missing/);
    assert.throws(() => api.loadArisSkills(["paper-write"]), /ARIS skill paper-write is missing/);
    assert.throws(api.getArisCatalog, /ENOENT/);
  }));

test("truncated helper is reported with sizes", () =>
  withPack(root => truncateSync(path.join(root, "tools", "research_wiki.py"), 10), api => {
    assert.throws(api.validateArisInstall, /tools\/research_wiki\.py has 10 bytes/);
  }));

test("lost executable bit is reported", () =>
  withPack(root => chmodSync(path.join(root, "tools", "save_trace.sh"), 0o644), api => {
    assert.throws(api.validateArisInstall, /tools\/save_trace\.sh lost its executable bit/);
  }));

test("missing shared-references support directory is reported", () =>
  withPack(root => rmSync(path.join(root, "skills", "shared-references"), { recursive: true }), api => {
    assert.throws(api.validateArisInstall, /skills\/shared-references is missing/);
  }));

test("provenance skill without shipped SKILL.md or frontmatter is rejected", () =>
  withPack(root => {
    mkdirSync(path.join(root, "skills", "bogus"));
    writeFileSync(path.join(root, "skills", "bogus", "SKILL.md"), "# no frontmatter\n");
    const data = JSON.parse(readFileSync(path.join(root, "aris-provenance.json"), "utf8"));
    data.skills.push("bogus");
    writeFileSync(path.join(root, "aris-provenance.json"), JSON.stringify(data));
  }, api => {
    assert.throws(api.validateArisInstall, /lists skill bogus without skills\/bogus\/SKILL\.md/);
    assert.throws(api.getArisCatalog, /ARIS skill bogus has no frontmatter/);
  }));
