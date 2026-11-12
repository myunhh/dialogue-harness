import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
if (manifest.name !== "omp-agent-dialogue" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("Unexpected extension package identity");
}
const omp = process.env.OMP_BIN || "omp";
const version = execFileSync(omp, ["--version"], { encoding: "utf8" }).trim();
const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
if (!match || Number(match[1]) < 18 || (Number(match[1]) === 18 && Number(match[2]) < 15)) {
  throw new Error(`OMP >=18.15.0 is required; found ${version}`);
}
const files = ["package.json", "index.js", "controller.js", "protocol.js", "waves.js", "transport.js", "flow.js", "flow-view.js", "aris-skills.js", "aris-runtime.js", "aris-provenance.json", "ARIS-LICENSE", "install.mjs", "README.md", "CHANGELOG.md"];
for (const directory of ["agents", "test"]) {
  for (const name of (await readdir(path.join(source, directory))).sort()) {
    if (name.endsWith(directory === "agents" ? ".md" : ".test.js")) files.push(`${directory}/${name}`);
  }
}
// Vendored ARIS pack (skills/<name>/SKILL.md, shared-references, tools, templates): shipped
// recursively and verbatim, executable helpers keep their mode bits.
async function walk(directory) {
  for (const entry of (await readdir(path.join(source, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await walk(relative);
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Refusing to ship non-regular file: ${relative}`);
  }
}
for (const directory of ["skills", "tools", "templates"]) await walk(directory);
const provenance = JSON.parse(await readFile(path.join(source, "aris-provenance.json"), "utf8"));
for (const entry of provenance.files) {
  if (!files.includes(entry.path)) throw new Error(`ARIS pack file listed in aris-provenance.json is missing from the checkout: ${entry.path}`);
}
// Normalized modes keep the fingerprint identical across checkouts with different umasks.
const modes = await Promise.all(files.map(async file => ((await stat(path.join(source, file))).mode & 0o100 ? 0o755 : 0o644)));
const contents = await Promise.all(files.map(file => readFile(path.join(source, file))));
const hash = createHash("sha256");
files.forEach((file, i) => { hash.update(`${file}:${modes[i].toString(8)}`); hash.update(contents[i]); });
const fingerprint = hash.digest("hex").slice(0, 12);
// Immutable, content-addressed installation. Removing the development worktree
// or updating OMP cannot remove the running extension. No dependency installation.
const destination = path.join(homedir(), ".local", "share", "omp-agent-dialogue", `${manifest.version}-${fingerprint}`);
const directories = new Set(files.map(file => path.dirname(file)).filter(directory => directory !== "."));
for (const directory of directories) await mkdir(path.join(destination, directory), { recursive: true });
for (let index = 0; index < files.length; index++) {
  const target = path.join(destination, files[index]);
  try {
    await writeFile(target, contents[index], { flag: "wx", mode: modes[index] });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await stat(target);
    if (!existing.isFile() || !(await readFile(target)).equals(contents[index])) {
      throw new Error(`Existing installed file differs; refusing to overwrite: ${target}`);
    }
    if ((existing.mode & 0o777) !== modes[index]) await chmod(target, modes[index]);
  }
}
console.log(`Shipped ${files.length} files including ${provenance.skills.length} ARIS skills from ${provenance.source.url}@${provenance.source.commit.slice(0, 12)}`);
execFileSync(omp, ["plugin", "link", destination], { stdio: "inherit" });
console.log(`Installed omp-agent-dialogue@${manifest.version} for ${version}\n${destination}\nIn OMP: /reload-plugins, /dialogue skills, then /dialogue on (Fable Brain + Opus Worker + Astra reviewer)`);
