// Access to the vendored ARIS skill pack (wanshuiyin/auto-claude-code-research-in-sleep).
// The pack lives next to this module: skills/<name>/SKILL.md, skills/shared-references/,
// tools/, templates/. aris-provenance.json pins the upstream commit and the shipped file
// inventory; every export below is synchronous and reads the installed pack directly, so a
// missing or truncated install fails before the runtime enables ARIS mode.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const provenancePath = path.join(root, "aris-provenance.json");
const REQUIRED_DIRECTORIES = ["skills", "skills/shared-references", "tools", "templates"];

function readProvenance() {
  let text;
  try {
    text = readFileSync(provenancePath, "utf8");
  } catch (error) {
    throw new Error(`ARIS pack is not installed: ${provenancePath} is missing (${error.code}); reinstall omp-agent-dialogue`);
  }
  const provenance = JSON.parse(text);
  const { source, skills, files } = provenance;
  if (!source?.url || !/^[0-9a-f]{40}$/.test(source.commit ?? "") || !Array.isArray(skills) || !skills.length || !Array.isArray(files) || !files.length) {
    throw new Error(`ARIS pack provenance is malformed: ${provenancePath}`);
  }
  return provenance;
}

function skillFile(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Invalid ARIS skill name: ${JSON.stringify(name)}`);
  return path.join(root, "skills", name, "SKILL.md");
}

function parseFrontmatter(name, content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`ARIS skill ${name} has no frontmatter: ${skillFile(name)}`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!field) continue;
    let value = field[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    fields[field[1]] = value;
  }
  if (fields.name !== name) throw new Error(`ARIS skill ${name} frontmatter name is ${JSON.stringify(fields.name ?? null)}`);
  if (!fields.description) throw new Error(`ARIS skill ${name} has no description`);
  return fields;
}

/** Upstream source pin of the vendored pack. */
export function getArisSource() {
  const { source } = readProvenance();
  return { url: source.url, commit: source.commit };
}

/**
 * Verify the installed pack against the shipped inventory.
 * Returns { commit, count, root } (count = number of skills) or throws an error naming
 * the first missing or incomplete file so the caller can refuse to enable ARIS mode.
 */
export function validateArisInstall() {
  const provenance = readProvenance();
  for (const relative of REQUIRED_DIRECTORIES) {
    const directory = path.join(root, relative);
    let info;
    try {
      info = statSync(directory);
    } catch {
      throw new Error(`ARIS pack is incomplete: directory ${directory} is missing; reinstall omp-agent-dialogue`);
    }
    if (!info.isDirectory()) throw new Error(`ARIS pack is incomplete: ${directory} is not a directory`);
  }
  for (const entry of provenance.files) {
    const file = path.join(root, entry.path);
    let info;
    try {
      info = statSync(file);
    } catch {
      throw new Error(`ARIS pack is incomplete: ${entry.path} is missing from ${root}; reinstall omp-agent-dialogue`);
    }
    if (!info.isFile()) throw new Error(`ARIS pack is incomplete: ${entry.path} is not a regular file`);
    if (info.size !== entry.size) throw new Error(`ARIS pack is incomplete: ${entry.path} has ${info.size} bytes, expected ${entry.size}`);
    if (entry.executable && !(info.mode & 0o100)) throw new Error(`ARIS pack is incomplete: ${entry.path} lost its executable bit`);
  }
  const shipped = new Set(provenance.files.map(entry => entry.path));
  for (const name of provenance.skills) {
    if (!shipped.has(`skills/${name}/SKILL.md`)) throw new Error(`ARIS pack provenance lists skill ${name} without skills/${name}/SKILL.md`);
  }
  return { commit: provenance.source.commit, count: provenance.skills.length, root };
}

/** [{ name, description }] for every vendored base skill, in provenance order (sorted by name). */
export function getArisCatalog() {
  const { skills } = readProvenance();
  return skills.map(name => {
    const { description } = parseFrontmatter(name, readFileSync(skillFile(name), "utf8"));
    return { name, description };
  });
}

/** Full raw SKILL.md content (frontmatter included) and absolute path for each requested skill. */
export function loadArisSkills(names) {
  const { skills } = readProvenance();
  const known = new Set(skills);
  return names.map(name => {
    if (!known.has(name)) throw new Error(`Unknown ARIS skill: ${JSON.stringify(name)} (${skills.length} skills in the pack)`);
    const file = skillFile(name);
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`ARIS skill ${name} is missing: ${file} (${error.code}); reinstall omp-agent-dialogue`);
    }
    parseFrontmatter(name, content);
    return { name, path: file, content };
  });
}
