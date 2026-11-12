import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../protocol.js";
import { REVIEWER_AGENT, WORKER_AGENT, arisSpawnPolicy, createArisRun, hydrateReview, isLegacyAgent, prepareArisCall, recordReview, reviewOutput, reviewReference, reviewRequired } from "../aris-runtime.js";

const install = { root: "/opt/aris/", commit: "2927b40b" };
const reviewSkill = { name: "research-review", path: "/opt/aris/skills/research-review/SKILL.md",
  content: "---\nname: research-review\nallowed-tools: Bash(*), mcp__codex__codex, mcp__codex__codex-reply\n---\n\nBODY mentions mcp__codex__codex-reply" };
const searchSkill = { name: "arxiv", path: "/opt/aris/skills/arxiv/SKILL.md",
  content: "---\nname: arxiv\nallowed-tools: Bash(*)\n---\n\nBody text that merely says mcp__codex__codex in prose" };
const decision = { route: "dialogue", reason: "review", skills: ["research-review"] };
const config = { fable: "anthropic/claude-fable-5-2", opus: "anthropic/claude-opus-5-5", astra: "openai-codex/gpt-6-astra" };
const run = () => createArisRun("run-1", decision, config, [reviewSkill], install);

test("review requirement comes from the skill frontmatter transports, not prose", () => {
  assert.equal(reviewRequired([reviewSkill]), true);
  assert.equal(reviewRequired([searchSkill]), false);
  assert.equal(reviewRequired([searchSkill, reviewSkill]), true);
  assert.equal(run().reviewRequired, true);
  assert.equal(run().install.root, "/opt/aris");
  assert.deepEqual(run().config, config);
  assert.throws(() => createArisRun("r", decision, DEFAULTS, [], install), /not loaded/);
  assert.throws(() => createArisRun("r", decision, DEFAULTS, [{ name: "x", path: "p" }], install), /not loaded/);
  assert.throws(() => createArisRun("r", decision, DEFAULTS, [reviewSkill], {}), /install root/);
});

test("task calls: legacy helpers refused, owned-agent overrides stripped, reviewer continuity never reaches the worker, others untouched", () => {
  const aris = run();
  const plain = { agent: "scout", task: "map the repo" };
  assert.equal(prepareArisCall(aris, plain), plain);
  const batch = { context: "c", tasks: [{ task: "no agent" }, { agent: "reviewer", task: "x" }] };
  assert.equal(prepareArisCall(aris, batch), batch);
  for (const name of ["rh-critic-method", "dialogue-review", "dialogue-agreement"]) {
    assert.equal(isLegacyAgent(name), true);
    assert.throws(() => prepareArisCall(aris, { agent: name, task: "x" }), /retired helper agent/);
    assert.throws(() => prepareArisCall(aris, { context: "c", tasks: [plain, { agent: name, task: "x" }] }), /retired helper agent/);
  }
  assert.throws(() => prepareArisCall(aris, { agent: REVIEWER_AGENT }), /review task text/);
  assert.throws(() => prepareArisCall(aris, { agent: WORKER_AGENT }), /work packet text/);
  assert.throws(() => prepareArisCall(aris, "nope"), /must be an object/);
  const first = prepareArisCall(aris, { name: "R1", agent: REVIEWER_AGENT, task: "Review /w/brief.md", model: "anthropic/claude-opus-4-6", tools: ["bash"], outputSchema: {}, schemaMode: "strict" });
  assert.deepEqual(first, { name: "R1", agent: REVIEWER_AGENT, task: "Review /w/brief.md" });
  const packet = prepareArisCall(aris, { name: "W1", agent: WORKER_AGENT, task: "Implement /w/tool.py", model: "x/y", tools: ["task"], outputSchema: {}, schemaMode: "strict", isolated: true });
  assert.deepEqual(Object.keys(packet).sort(), ["agent", "isolated", "name", "task"]);

  assert.equal(recordReview(aris, { id: "R1", output: "  " }, DEFAULTS.astra), false);
  assert.equal(recordReview(aris, { id: "R1", output: "Round one findings" }, DEFAULTS.astra), true);
  assert.equal(recordReview(aris, { id: "R1", output: "duplicate" }, DEFAULTS.astra), false);
  assert.equal(recordReview(aris, { id: "R2", structured: { status: "valid", data: { summary: "structured round" } } }, DEFAULTS.astra), true);
  assert.equal(recordReview(aris, { id: "R3", structured: { status: "invalid", data: { summary: "x" } } }, DEFAULTS.astra), false);
  const next = prepareArisCall(aris, { context: "shared", tasks: [plain, { name: "R3", agent: REVIEWER_AGENT, task: "Re-review" }, { name: "W2", agent: WORKER_AGENT, task: "Collect numbers", model: "x/y" }] });
  assert.equal(next.tasks[0], plain);
  assert.equal(next.context, "shared");
  assert.match(next.tasks[1].task, /^Re-review\n\n## 이전 검토 라운드/);
  assert.match(next.tasks[1].task, /### 라운드 1 \(job R1, 모델 openai-codex\/gpt-6-astra\)\nRound one findings/);
  assert.match(next.tasks[1].task, /### 라운드 2 \(job R2[\s\S]*"summary": "structured round"/);
  assert.doesNotMatch(next.tasks[1].task, /작업 패킷 실행 조건/);
  assert.equal(next.tasks[2].model, undefined);
  assert.doesNotMatch(next.tasks[2].task, /이전 검토 라운드|Round one findings|structured round/);
});

test("spawn policy pins worker to Opus medium and reviewer to Astra max, blocks retired helpers and leaves other spawns to the host", () => {
  const aris = createArisRun("run-2", decision, { ...config, astra: "openai/gpt-6-astra" }, [reviewSkill], install);
  assert.deepEqual(arisSpawnPolicy(aris, { invocationKind: "task", agent: REVIEWER_AGENT, spawnKey: "R1" }), { model: "openai/gpt-6-astra:max" });
  assert.deepEqual(arisSpawnPolicy(aris, { invocationKind: "task", agent: WORKER_AGENT, spawnKey: "W1" }), { model: "anthropic/claude-opus-5-5:medium" });
  assert.equal(arisSpawnPolicy(aris, { invocationKind: "task", agent: "rh-thinker" }).block, true);
  assert.equal(arisSpawnPolicy(aris, { invocationKind: "task", agent: "scout" }), undefined);
  assert.equal(arisSpawnPolicy(aris, { invocationKind: "eval", agent: REVIEWER_AGENT }), undefined);
  assert.equal(arisSpawnPolicy(aris, { invocationKind: "eval", agent: WORKER_AGENT }), undefined);
  assert.equal(arisSpawnPolicy(aris, undefined), undefined);
});


const FULL = `## 검토 범위\n\n<irc from="parent">는 본문 일부\n${"- 항목\n".repeat(400)}END`;
const previewOf = text => text.slice(0, 80).replace(/<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi, "&lt;");
const envelope = (id, body, agent = REVIEWER_AGENT, status = "completed") =>
  `<task-result id="${id}" agent="${agent}" status="${status}" duration="9m">\n<meta lines="404" size="3.2KB" />\n${body}\n</task-result>\n\n${id} is now idle`;
const preview = (id, pointer = id, text = FULL) => envelope(id, `<preview full-output="agent://${pointer}">\n${previewOf(text)}\n</preview>`);

test("preview envelopes are references to the job's own agent:// output and never inline evidence", () => {
  const item = { id: "R1", resultText: preview("R1") };
  assert.equal(reviewOutput(item), "");
  assert.deepEqual(reviewReference(item), { id: "R1", preview: previewOf(FULL) });
  assert.equal(reviewReference({ id: "R1", resultText: preview("R1", "Other") }), undefined, "foreign pointer");
  assert.equal(reviewReference({ id: "R1", resultText: preview("R2") }), undefined, "envelope for another job");
  assert.equal(reviewReference({ id: "R1", resultText: envelope("R1", `<preview full-output="agent://R1">\nx\n</preview>`, "scout") }), undefined, "other agent");
  assert.equal(reviewReference({ id: "R1", resultText: envelope("R1", `<preview full-output="agent://R1">\nx\n</preview>`, REVIEWER_AGENT, "failed (exit 1)") }), undefined);
  assert.equal(reviewReference({ id: "R1", output: "inline", resultText: preview("R1") }), undefined, "inline output wins");
  assert.equal(reviewReference({ id: "R1", structured: { status: "valid", data: {} }, resultText: preview("R1") }), undefined);
  assert.equal(reviewOutput({ id: "R1", resultText: envelope("R1", "<output>\nshort body\n</output>") }), "short body");
});

test("hydration reads only the referenced id, keeps the whole output and fails on error, emptiness or a different document", async () => {
  const item = { id: "R1", status: "completed", resolvedModelIdentity: DEFAULTS.astra, resultText: preview("R1") };
  const reads = [];
  const hydrated = await hydrateReview(item, async id => { reads.push(id); return FULL; });
  assert.deepEqual(reads, ["R1"]);
  assert.equal(hydrated.output, FULL);
  assert.equal(hydrated.resultText, item.resultText);
  assert.equal(hydrated.status, "completed");
  assert.equal(reviewOutput(hydrated), FULL);
  const aris = run();
  assert.equal(recordReview(aris, hydrated, DEFAULTS.astra), true);
  assert.ok(prepareArisCall(aris, { name: "R2", agent: REVIEWER_AGENT, task: "next" }).task.endsWith("END"));

  const plain = { id: "R1", output: "inline" };
  assert.equal(await hydrateReview(plain, async () => { throw new Error("never"); }), plain, "inline items pass through untouched");
  const foreign = { id: "R1", resultText: preview("R1", "Other") };
  assert.equal(await hydrateReview(foreign, async () => { throw new Error("never"); }), foreign);

  const failing = await hydrateReview(item, async () => { throw new Error("Not found: R1"); });
  assert.equal(failing.status, "failed");
  assert.equal(failing.resultText, undefined);
  assert.match(failing.error, /agent:\/\/R1\)을 확인하지 못함: Not found: R1/);
  assert.equal(reviewOutput(failing), "");
  assert.match((await hydrateReview(item, async () => "\n  ")).error, /본문이 비어 있음/);
  assert.match((await hydrateReview(item, async () => "## 다른 문서\n\n내용")).error, /미리보기와 일치하지 않음/);
  assert.equal(recordReview(run(), failing, DEFAULTS.astra), false);
});
