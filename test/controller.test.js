import test from "node:test";
import assert from "node:assert/strict";
import { registerDialogue } from "../controller.js";
import { FLOW } from "../flow.js";
import { REVIEWER_AGENT, WORKER_AGENT } from "../aris-runtime.js";

const ROOT = "/opt/aris";
const SKILLS = {
  "research-review": { description: "Get a deep critical review of research from a selected reviewer.",
    content: "---\nname: research-review\nallowed-tools: Bash(*), Read, mcp__codex__codex, mcp__codex__codex-reply\n---\n\n# Research Review\nUse `mcp__codex__codex` for new review threads. RAW-SKILL-BODY" },
  arxiv: { description: "Search arXiv for papers.", content: "---\nname: arxiv\nallowed-tools: Bash(*), Read\n---\n\n# arXiv search\nARXIV-BODY" },
  "auto-review-loop": { description: "Iterative review loop.", content: "---\nname: auto-review-loop\nallowed-tools: mcp__codex__codex\n---\n\nLOOP-BODY" },
};
function skillsModule(overrides = {}) {
  return {
    getArisCatalog: () => Object.entries(SKILLS).map(([name, skill]) => ({ name, description: skill.description })),
    validateArisInstall: () => ({ commit: "2927b40b2ea37774de53763338c5e8f91a7601e6", count: 3, root: ROOT }),
    loadArisSkills: names => names.map(name => {
      if (!SKILLS[name]) throw new Error(`Unknown ARIS skill: "${name}"`);
      return { name, path: `${ROOT}/skills/${name}/SKILL.md`, content: SKILLS[name].content };
    }),
    ...overrides,
  };
}

function harness(runTurn, entries = [], skills = skillsModule(), readAgentOutput = undefined,
  createFlowView = () => ({ render: () => [], invalidate() {} }), identity = { kind: "main", id: "Main" }) {
  const handlers = new Map();
  const bus = new Map();
  let liveFlow;
  const cards = [];
  const prompts = [];
  const pending = [];
  const notices = [];
  const calls = [];
  const promptModels = [];
  const promptEfforts = [];
  let effort = "low";
  let sessionId = "original";
  let idle = true;
  let key;
  let command;
  const models = [
    { provider: "anthropic", id: "claude-sonnet-4-6", family: "anthropic" },
    { provider: "openai-codex", id: "gpt-6-astra", family: "openai", reasoning: true, thinking: { efforts: ["low", "high", "xhigh", "max"] } },
    { provider: "anthropic", id: "claude-opus-5-5", family: "anthropic", reasoning: true, thinking: { efforts: ["low", "medium", "high"] } },
    { provider: "anthropic", id: "claude-fable-5-2", family: "anthropic", reasoning: true, thinking: { efforts: ["medium", "high", "xhigh"] } },
    { provider: "openai-codex", id: "gpt-6.1-terra", family: "openai", reasoning: true, thinking: { efforts: ["low", "xhigh"] } },
  ];
  let current = models[0];
  const ctx = {
    cwd: "/workspace", mode: "tui", hasUI: true, agent: identity,
    models: { list: () => models, family: model => model.family, current: () => current },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
    isIdle: () => idle,
    abort: async () => { idle = true; },
    setTimeout: callback => pending.push(callback),
    ui: {
      setStatus() {}, setWidget(_name, value) {
        if (_name === FLOW && value === undefined) liveFlow = undefined;
        if (typeof value === "function") value({ terminal: { rows: 40 }, requestRender() {} }, undefined);
      }, setEditorText() {},
      notify: (...args) => notices.push(args),
      select() { throw new Error("Unexpected model picker"); },
      custom: async factory => { factory({ terminal: { rows: 40 }, requestRender() {} }, undefined, {}, () => {}); },
      onTerminalInput: handler => { key = handler; return () => { key = undefined; }; },
    },
  };
  const pi = {
    events: { on(name, handler) {
      const listeners = bus.get(name) ?? new Set();
      bus.set(name, listeners);
      listeners.add(handler);
      return () => listeners.delete(handler);
    } },
    on(name, handler) { handlers.set(name, handler); },
    getActiveTools: () => ["task"],
    getAllTools: () => [{ name: "task", description: `- \`scout\`: read-only research\n- \`${WORKER_AGENT}\`: bounded worker\n- \`${REVIEWER_AGENT}\`: ARIS reviewer round` }],
    registerCommand(_name, options) { command = options.handler; },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    sendMessage(message) {
      cards.push(message);
      entries.push({ type: "custom_message", ...message });
    },
    async setModel(model) { current = model; return true; },
    setThinkingLevel(value) { effort = value; },
    sendUserMessage(content) {
      prompts.push(content);
      promptModels.push(`${current.provider}/${current.id}`);
      promptEfforts.push(effort);
      idle = false;
    },
  };
  registerDialogue(pi, (_ctx, args) => { calls.push(args); return runTurn(args); },
    (getFlow, ...args) => { liveFlow = getFlow; return createFlowView(getFlow, ...args); }, skills, readAgentOutput);
  handlers.get("session_start")({}, ctx);
  return {
    ctx, pi, entries, cards, prompts, promptModels, promptEfforts, notices, models, calls, skills,
    command: args => command(args, ctx),
    flow: () => liveFlow?.(),
    input: (text, extra = {}) => handlers.get("input")({ text, source: "interactive", ...extra }, ctx),
    flush: () => pending.shift()?.(),
    event: (name, data = {}) => handlers.get(name)?.(data, ctx),
    emit: (name, data) => { for (const handler of bus.get(name) ?? []) handler(data); },
    press: data => key?.(data),
    changeSession: id => { sessionId = id; },
    setIdle: value => { idle = value; },
    context: () => handlers.get("context")({ messages: cards.map(card => ({ role: "custom", ...card })) }).messages,
    handoff: () => cards.find(card => card.details.phase === "handoff"),
  };
}

const routed = decision => async () => ({ text: JSON.stringify({
  waves: decision.route === "dialogue" ? [{ id: "Review", title: "검토", goal: "요청된 근거를 독립 검토", parallel: 4 }] : [],
  ...decision,
}), stopReason: "stop" });
const review = routed({ route: "dialogue", skills: ["research-review"], reason: "Independent review is useful." });
const solo = routed({ route: "solo", reason: "Routine work." });
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

function heldTurn() {
  let release;
  let signal;
  return {
    run: args => { signal = args.signal; return new Promise(resolve => { release = resolve; }); },
    release: () => release({ text: '{"route":"solo","reason":"late"}', stopReason: "stop" }),
    get signal() { return signal; },
  };
}

const latestFlow = h => h.flow() ?? h.entries.filter(entry => entry.type === "custom" && entry.customType === FLOW).at(-1)?.data;
const reviewRows = h => latestFlow(h).rows.filter(row => row.review === true);
const ASTRA = "openai-codex/gpt-6-astra";

/** Drive one ARIS review run up to the executor prompt and return the harness. */
async function startedReview(runTurn = review, readAgentOutput = undefined) {
  const h = harness(runTurn, [], skillsModule(), readAgentOutput);
  await h.command("on");
  h.input("Review my FLOPs claim.");
  await h.flush();
  assert.deepEqual(h.promptModels, ["anthropic/claude-fable-5-2"]);
  return h;
}

/** A completed native reviewer result as the host reports it. */
const reviewerResult = (id, more = {}) => ({ id, agent: REVIEWER_AGENT, exitCode: 0, resolvedModelIdentity: ASTRA, resolvedThinkingLevel: "max",
  output: `ROUND-OUTPUT-${id}: the latency claim is unmeasured.`, ...more });

test("off preserves normal input; resumed branch restores mode without leaking into a new session", async () => {
  const first = harness(review);
  assert.equal(first.input("ordinary task"), undefined);
  await first.command("on");
  const resumed = harness(review, [...first.entries]);
  assert.deepEqual(resumed.input("resume task"), { handled: true });
  await resumed.command("stop");
  const fresh = harness(review);
  assert.equal(fresh.input("new task"), undefined);
});

test("Esc cancels the router and a late decision cannot execute or create a handoff", async () => {
  const hold = heldTurn();
  const h = harness(hold.run);
  await h.command("on");
  h.input("change production configuration");
  const running = h.flush();
  assert.deepEqual(h.press("\x1b"), { consume: true });
  assert.equal(hold.signal.aborted, true);
  hold.release();
  await running;
  assert.deepEqual(h.prompts, []);
  assert.equal(h.handoff(), undefined);
});

test("router failure prevents execution and leaves no execution advice in context", async () => {
  const h = harness(async () => { throw new Error("Provider unavailable"); });
  await h.command("on");
  h.input("update the deployment");
  await h.flush();
  assert.deepEqual(h.prompts, []);
  assert.equal(h.cards.at(-1).details.phase, "error");
  assert.deepEqual(h.context(), []);
});

test("session switch invalidates in-flight work even when transport finishes successfully", async () => {
  const hold = heldTurn();
  const h = harness(hold.run);
  await h.command("on");
  h.input("task in old session");
  const running = h.flush();
  await h.event("session_before_switch");
  h.changeSession("new");
  h.event("session_switch");
  hold.release();
  await running;
  assert.deepEqual(h.prompts, []);
  assert.equal(hold.signal.aborted, true);
});

test("ARIS starts Fable as Brain while retaining separate native worker and reviewer identities", async () => {
  const h = await startedReview();
  assert.deepEqual(h.promptEfforts, ["high"]);
  assert.equal(h.handoff().details.speaker, "fable");
  assert.deepEqual(h.handoff().details.worker, { agent: WORKER_AGENT, model: "anthropic/claude-opus-5-5" });
  assert.deepEqual(h.handoff().details.reviewer, { agent: REVIEWER_AGENT, model: ASTRA });
  assert.equal(latestFlow(h).rows.find(row => row.id === "final").state, "running");
  assert.deepEqual(h.context().map(card => card.details.phase), ["handoff"]);
  assert.equal(h.input("programmatic", { source: "extension" }), undefined);
});

test("solo uses Astra without loading skills or a Claude account", async () => {
  const loaded = [];
  const h = harness(solo, [], skillsModule({ loadArisSkills: names => { loaded.push(...names); return []; } }));
  h.models.splice(0, h.models.length, ...h.models.filter(model => model.family === "openai"));
  await h.command("on");
  h.input("ordinary implementation");
  await h.flush();
  assert.deepEqual(h.calls.map(call => call.speaker), ["router"]);
  assert.deepEqual(h.promptModels, [ASTRA]);
  assert.deepEqual(h.promptEfforts, ["max"]);
  assert.deepEqual(loaded, []);
});

test("Astra without max cannot enable Dialogue or start a paid request after capability disappears", async () => {
  for (const stage of ["enable", "input"]) {
    const h = harness(solo);
    if (stage === "input") await h.command("on");
    h.models.find(model => model.id === "gpt-6-astra").thinking.efforts = ["low", "high", "xhigh"];
    if (stage === "enable") {
      await h.command("on");
      assert.equal(h.input("ordinary task"), undefined, "Dialogue remains off");
    } else {
      assert.deepEqual(h.input("ordinary task"), { handled: true });
      await h.flush();
      assert.equal(h.cards.at(-1).details.phase, "error");
    }
    assert.deepEqual(h.calls, [], stage);
    assert.deepEqual(h.prompts, [], stage);
  }
});

test("invalid routing never selects an executor: bad JSON, unknown route, unknown skill, skills on solo", async () => {
  for (const text of ["not JSON", '{"route":"unknown","reason":"x"}',
    '{"route":"research","skills":["not-installed"],"reason":"x"}', '{"route":"solo","skills":["arxiv"],"reason":"x"}']) {
    const h = harness(async () => ({ text, stopReason: "stop" }));
    await h.command("on");
    h.input("task");
    await h.flush();
    assert.deepEqual(h.prompts, []);
    assert.equal(h.calls.length, 1);
    assert.equal(h.cards.at(-1).details.phase, "error");
  }
});

test("a missing or broken ARIS installation blocks enabling, routing and the skills listing", async () => {
  const broken = skillsModule({ validateArisInstall: () => { throw new Error("ARIS bundle incomplete: skills/ missing"); } });
  const h = harness(review, [], broken);
  await h.command("on");
  assert.match(h.notices.at(-1)[0], /ARIS bundle incomplete/);
  assert.equal(h.input("review this"), undefined, "mode stays off");
  await h.command("skills");
  assert.match(h.cards.at(-1).content, /실행 불가: ARIS bundle incomplete/);
  assert.equal(h.cards.at(-1).details.available, false);

  // Installation vanishing after enabling: the enabled route is re-checked before any paid call.
  const live = harness(review);
  await live.command("on");
  live.skills.validateArisInstall = () => { throw new Error("ARIS bundle removed"); };
  assert.deepEqual(live.input("review this"), { handled: true });
  assert.equal(live.flush(), undefined);
  assert.deepEqual(live.calls, []);
  assert.equal(live.cards.at(-1).details.phase, "error");
  assert.match(live.cards.at(-1).content, /ARIS bundle removed/);
});

test("ARIS capability failures stop execution instead of substituting another agent or model", async () => {
  for (const failure of ["disabled-task", "missing-reviewer-agent", "missing-worker-agent", "missing-opus", "missing-fable", "unsupported-effort", "missing-skill-file"]) {
    const h = harness(review);
    if (failure === "disabled-task") h.pi.getActiveTools = () => [];
    if (failure === "missing-reviewer-agent") h.pi.getAllTools = () => [{ name: "task", description: "- `scout`: only" }];
    if (failure === "missing-worker-agent") h.pi.getAllTools = () => [{ name: "task", description: `- \`${REVIEWER_AGENT}\`: reviewer` }];
    if (failure === "missing-opus") h.models.splice(h.models.findIndex(model => model.id === "claude-opus-5-5"), 1);
    if (failure === "missing-fable") h.models.splice(h.models.findIndex(model => model.id === "claude-fable-5-2"), 1);
    if (failure === "unsupported-effort") h.models.find(model => model.id === "claude-fable-5-2").thinking.efforts = ["low"];
    if (failure === "missing-skill-file") h.skills.loadArisSkills = () => { throw new Error("ARIS skill research-review is missing: /opt/aris/skills/research-review/SKILL.md"); };
    await h.command("on");
    h.input("Review this research.");
    await h.flush();
    assert.deepEqual(h.prompts, [], failure);
    assert.equal(h.handoff(), undefined, failure);
    assert.equal(h.cards.at(-1).details.phase, "error", failure);
    assert.deepEqual(h.calls.map(call => call.speaker), ["router"], failure);
  }
});

test("native steering is preserved and unavailable routing models cannot start a paid request", async () => {
  const h = harness(review);
  await h.command("on");
  h.setIdle(false);
  assert.equal(h.input("stop changing that file"), undefined);
  h.setIdle(true);
  h.models.splice(h.models.findIndex(model => model.id === "gpt-6.1-terra"), 1);
  assert.deepEqual(h.input("new task"), { handled: true });
  assert.equal(h.flush(), undefined);
  assert.deepEqual(h.calls, []);
});

test("router finishing after another extension starts execution does not steer that work", async () => {
  const h = harness(async args => {
    const result = await review(args);
    h.setIdle(false);
    return result;
  });
  await h.command("on");
  h.input("original task");
  await h.flush();
  assert.deepEqual(h.prompts, []);
  assert.equal(h.cards.at(-1).details.phase, "error");
});

test("session navigation drains a pending model change but cancellation prevents its prompt", async () => {
  const h = harness(solo);
  const started = deferred();
  const release = deferred();
  const setModel = h.pi.setModel;
  h.pi.setModel = async model => {
    started.resolve();
    await release.promise;
    return setModel(model);
  };
  await h.command("on");
  h.input("old-session task");
  const running = h.flush();
  await started.promise;
  let switched = false;
  const switching = h.event("session_before_switch").then(() => { switched = true; });
  await Promise.resolve();
  assert.equal(switched, false);
  release.resolve();
  await Promise.all([running, switching]);
  h.changeSession("new");
  h.event("session_switch");
  assert.deepEqual(h.prompts, []);
  assert.equal(h.handoff(), undefined);
});

test("replacement requests wait for an old model transition and only the new route executes", async () => {
  let routedCount = 0;
  const h = harness(args => ++routedCount > 1 ? solo(args) : review(args));
  const started = deferred();
  const release = deferred();
  const setModel = h.pi.setModel;
  h.pi.setModel = async model => {
    if (model.id.startsWith("claude-fable")) {
      started.resolve();
      await release.promise;
    }
    return setModel(model);
  };
  await h.command("on");
  h.input("old review");
  const first = h.flush();
  await started.promise;
  h.input("new ordinary task");
  const second = h.flush();
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(h.prompts, [[{ type: "text", text: "new ordinary task" }]]);
  assert.deepEqual(h.promptModels, [ASTRA]);
});

const selectedState = h => h.entries.filter(entry => entry.customType === "agent-dialogue-state").at(-1)?.data;
function addAlternativeModels(h) {
  h.models.push(
    { provider: "anthropic-api", id: "claude-opus-4-6", family: "anthropic", reasoning: true, thinking: { efforts: ["medium", "high"] } },
    { provider: "anthropic-api", id: "claude-fable-5-2", family: "anthropic", reasoning: true, thinking: { efforts: ["high"] } },
    { provider: "openai-codex", id: "gpt-6-luna", family: "openai" },
    { provider: "openai", id: "gpt-6-astra", family: "openai", reasoning: true, thinking: { efforts: ["high", "max"] } },
  );
}

test("role pickers atomically commit three models and restrict each lineage", async () => {
  const h = harness(review);
  addAlternativeModels(h);
  const choices = ["anthropic-api/claude-fable-5-2", "anthropic-api/claude-opus-4-6", "openai/gpt-6-astra"];
  let step = 0;
  h.ctx.ui.select = async (_title, options) => {
    const offered = options.map(option => option.label);
    if (step === 0) assert.deepEqual(new Set(offered), new Set(["anthropic/claude-fable-5-2", "anthropic-api/claude-fable-5-2"]));
    if (step === 1) assert.deepEqual(new Set(offered), new Set(["anthropic/claude-opus-5-5", "anthropic-api/claude-opus-4-6"]));
    if (step === 2) assert.deepEqual(new Set(offered), new Set([ASTRA, "openai/gpt-6-astra"]));
    assert.ok(offered.includes(choices[step]));
    return choices[step++];
  };
  await h.command("models");
  assert.deepEqual(selectedState(h), { version: 4, enabled: false, fable: choices[0], opus: choices[1], astra: choices[2] });
});

test("cancelling the last picker preserves every prior role and the enabled state", async () => {
  const h = harness(review);
  addAlternativeModels(h);
  await h.command("on");
  const before = [...h.entries];
  let step = 0;
  h.ctx.ui.select = async () => ["anthropic-api/claude-fable-5-2", "anthropic-api/claude-opus-4-6", undefined][step++];
  await h.command("models");
  assert.deepEqual(h.entries, before);
});

test("late picker answer cannot overwrite a different session or newer explicit selection", async () => {
  for (const change of ["session", "setting"]) {
    const h = harness(review);
    addAlternativeModels(h);
    await h.command("on");
    let answer;
    h.ctx.ui.select = () => new Promise(resolve => { answer = resolve; });
    const selection = h.command("astra");
    if (change === "session") {
      await h.event("session_before_switch");
      h.changeSession("new-session");
      h.event("session_switch");
    } else {
      await h.command(`astra ${ASTRA}`);
    }
    const before = [...h.entries];
    answer("openai/gpt-6-astra");
    await selection;
    assert.deepEqual(h.entries, before);
  }
});

test("unoffered replies or disappearance of a chosen model cannot partially commit roles", async () => {
  for (const failure of ["wrong-family", "removed"]) {
    const h = harness(review);
    addAlternativeModels(h);
    await h.command("on");
    const before = [...h.entries];
    let step = 0;
    h.ctx.ui.select = async () => {
      if (failure === "wrong-family") return "anthropic/claude-sonnet-4-6";
      if (step === 2) h.models.splice(h.models.findIndex(model => model.provider === "anthropic-api" && model.id.startsWith("claude-fable")), 1);
      return ["anthropic-api/claude-fable-5-2", "anthropic/claude-opus-5-5", ASTRA][step++];
    };
    await h.command("models");
    assert.deepEqual(h.entries, before);
  }
});

test("version-two sessions retain Astra/Opus choices while removing obsolete reviewer settings", async () => {
  const h = harness(review, [{
    type: "custom", customType: "agent-dialogue-state",
    data: { version: 2, enabled: true, gpt: "openai-codex/gpt-6-luna", claude: "anthropic/claude-sonnet-4-6",
      astra: "openai/gpt-6-astra", opus: "anthropic-api/claude-opus-4-6" },
  }]);
  addAlternativeModels(h);
  await h.command("on");
  const restored = selectedState(h);
  assert.equal(restored.version, 4);
  assert.equal(restored.astra, "openai/gpt-6-astra");
  assert.equal(restored.opus, "anthropic-api/claude-opus-4-6");
  assert.equal("gpt" in restored || "claude" in restored, false);
  h.input("review this idea");
  await h.flush();
  assert.deepEqual(h.promptModels, ["anthropic/claude-fable-5-2"]);
  assert.deepEqual(h.handoff().details.reviewer, { agent: REVIEWER_AGENT, model: "openai/gpt-6-astra" });
  assert.deepEqual(h.handoff().details.worker, { agent: WORKER_AGENT, model: "anthropic-api/claude-opus-4-6" });
});

test("legacy built-in Opus selections upgrade once; explicit v4 selections survive restart", async () => {
  for (const version of [3, 4]) {
    const opus = "anthropic/claude-opus-4-6";
    const h = harness(review, [{ type: "custom", customType: "agent-dialogue-state",
      data: { version, enabled: true, astra: ASTRA, opus, ...(version === 4 ? { fable: "anthropic-api/claude-fable-5-2" } : {}) } }]);
    addAlternativeModels(h);
    await h.command("on");
    assert.equal(selectedState(h).opus, version === 3 ? "anthropic/claude-opus-5-5" : opus);
    assert.equal(selectedState(h).fable, version === 3 ? "anthropic/claude-fable-5-2" : "anthropic-api/claude-fable-5-2");
  }
});

test("a worker using another model fails the run and informs the Brain without inventing review evidence", async () => {
  const h = await startedReview(routed({ route: "research", skills: ["arxiv"], reason: "Collect sources." }));
  const args = { name: "CollectSources", agent: WORKER_AGENT, task: "Collect only the requested sources." };
  const pin = h.event("before_subagent_spawn", { invocationKind: "task", agent: WORKER_AGENT });
  assert.deepEqual(pin, { model: "anthropic/claude-opus-5-5:medium" });
  h.event("tool_execution_start", { toolCallId: "worker", toolName: "task", args });
  const event = { toolCallId: "worker", toolName: "task", content: [],
    details: { results: [{ id: args.name, agent: WORKER_AGENT, exitCode: 0, resolvedModelIdentity: ASTRA, output: "collected" }] } };
  const rejected = await h.event("tool_result", event);
  assert.ok(rejected.content.some(block => block.text.includes("WORKER_UNAVAILABLE")));
  assert.equal(await h.event("tool_result", event), undefined);
  h.event("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(latestFlow(h).status, "failed");
  assert.equal(reviewRows(h).length, 0);
});

test("handoff remains running through an async wait; only terminal executor completion seals the flow", async () => {
  const h = harness(solo);
  await h.command("on");
  h.input("ordinary task");
  await h.flush();
  assert.equal(latestFlow(h).status, "running");
  assert.equal(latestFlow(h).rows.at(-1).state, "running");
  const cardsBefore = h.cards.length;
  await h.command("flow");
  assert.equal(h.cards.length, cardsBefore, "viewing progress must not enqueue model input");
  h.event("agent_end", { willContinue: true, awaitingAsyncWork: true });
  assert.equal(latestFlow(h).status, "running");
  const message = { role: "assistant", stopReason: "stop", content: [
    { type: "thinking", thinking: "PRIVATE-REASONING" }, { type: "text", text: "Verified public answer." },
  ] };
  h.event("message_end", { message });
  h.event("agent_end", { messages: [message] });
  assert.equal(latestFlow(h).status, "completed");
  assert.equal(latestFlow(h).rows.at(-1).summary, "Verified public answer.");
  await h.command("flow");
  assert.equal(h.cards.length, cardsBefore, "completion and detail display must not trigger a follow-up turn");
  assert.equal(JSON.stringify(latestFlow(h)).includes("PRIVATE-REASONING"), false);
});

test("reviewer rounds are pinned to Astra, carry prior public rounds, and count only with model metadata and output", async () => {
  const h = await startedReview();
  // Retired helpers remain refused; native roles retain their pinned model policy.
  assert.equal(h.event("tool_call", { toolName: "task", toolCallId: "legacy", input: { agent: "rh-critic-method", task: "audit" } }).block, true);
  assert.equal(h.event("tool_call", { toolName: "task", toolCallId: "legacy2", input: { tasks: [{ agent: "dialogue-review", task: "x" }], context: "c" } }).block, true);
  assert.deepEqual(h.event("before_subagent_spawn", { invocationKind: "task", agent: "rh-thinker", spawnKey: "x" }).block, true);
  assert.equal(h.event("before_subagent_spawn", { invocationKind: "task", agent: "scout", spawnKey: "s" }), undefined);
  assert.deepEqual(h.event("before_subagent_spawn", { invocationKind: "task", agent: REVIEWER_AGENT, spawnKey: "Round1" }), { model: `${ASTRA}:max` });

  const first = h.event("tool_call", { toolName: "task", toolCallId: "r1", input: {
    name: "Round1", agent: REVIEWER_AGENT, model: "anthropic/claude-sonnet-4-6", tools: ["bash"], task: "Read /workspace/RESEARCH_REVIEW_REQUEST.md and review.",
  } });
  assert.equal(first.input.model, undefined);
  assert.equal(first.input.tools, undefined);
  assert.doesNotMatch(first.input.task, /이전 검토 라운드/);
  h.event("tool_execution_start", { toolCallId: "r1", toolName: "task", args: first.input });
  assert.equal(reviewRows(h).length, 1);
  assert.deepEqual(reviewRows(h)[0].jobIds, ["Round1"]);
  h.event("tool_execution_update", { toolCallId: "r1", toolName: "task", partialResult: { details: { progress: [{ id: "Round1", status: "running" }] } } });
  assert.equal(reviewRows(h)[0].state, "running");
  const accepted = await h.event("tool_result", { toolCallId: "r1", toolName: "task", content: [{ type: "text", text: "raw" }],
    details: { results: [reviewerResult("Round1")] } });
  assert.match(accepted.content.at(-1).text, /검토 라운드 1 인정/);
  assert.match(accepted.content.at(-1).text, /자동 승인이 아닙니다/);
  assert.equal(reviewRows(h)[0].state, "completed");
  assert.equal(reviewRows(h)[0].model, `${ASTRA} · max`);
  assert.equal(await h.event("tool_result", { toolCallId: "r1", toolName: "task", content: [], details: { results: [reviewerResult("Round1")] } }), undefined, "one note per job");

  const second = h.event("tool_call", { toolName: "task", toolCallId: "r2", input: {
    tasks: [{ name: "Round2", agent: REVIEWER_AGENT, task: "Re-review after my response: latency now measured in bench.md." }], context: "shared",
  } });
  assert.match(second.input.tasks[0].task, /Re-review after my response/);
  assert.match(second.input.tasks[0].task, /이전 검토 라운드[\s\S]*ROUND-OUTPUT-Round1/);
  assert.equal(second.input.context, "shared");
  h.event("tool_execution_start", { toolCallId: "r2", toolName: "task", args: second.input });
  await h.event("tool_result", { toolCallId: "r2", toolName: "task", content: [], details: { results: [reviewerResult("Round2")] } });
  assert.equal(reviewRows(h).length, 2);
  assert.ok(reviewRows(h).every(row => row.state === "completed"));
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Final answer with open disagreements listed." }] };
  h.event("message_end", { message });
  h.event("agent_end", { messages: [message] });
  assert.equal(latestFlow(h).status, "completed");
  assert.match(latestFlow(h).note, /검토자 라운드 2회 완료 관측/);
});

test("detached wait output completes the review and becomes next-round evidence", async () => {
  const h = await startedReview();
  h.event("tool_execution_start", { toolCallId: "r1", toolName: "task", args: { name: "Round1", agent: REVIEWER_AGENT } });
  h.event("tool_execution_update", { toolCallId: "r1", toolName: "task", partialResult: {
    details: { progress: [{ id: "Round1", status: "completed", resolvedModelIdentity: ASTRA }] },
  } });
  assert.notEqual(reviewRows(h)[0].state, "failed");
  h.event("tool_execution_start", { toolCallId: "w1", toolName: "wait", args: {} });
  const output = "Latency was not measured; the proportional speedup claim is unsupported.";
  const result = { id: "Round1", type: "task", status: "completed", resolvedModelIdentity: ASTRA,
    resultText: `<task-result id="Round1" agent="aris-reviewer" status="completed" duration="41s">\n\n<output>\n${output}\n</output>\n</task-result>\n\nRound1 is now idle — message it via write agent://Round1; transcript at history://Round1` };
  await h.event("tool_result", { toolCallId: "w1", toolName: "wait", content: [], details: { jobs: [result] } });
  assert.equal(reviewRows(h)[0].state, "completed");
  const next = h.event("tool_call", { toolName: "task", input: {
    name: "Round2", agent: REVIEWER_AGENT, task: "Check the revised claim.",
  } });
  assert.ok(next.input.task.includes(output));
  h.event("tool_execution_start", { toolCallId: "r2", toolName: "task", args: next.input });
  await h.event("tool_result", { toolCallId: "r2", toolName: "task", content: [], details: { results: [reviewerResult("Round2")] } });
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Claim withdrawn." }] };
  h.event("message_end", { message });
  h.event("agent_end", { messages: [message] });
  assert.equal(latestFlow(h).status, "completed");
});

/** The host's envelope for an output past its inline budget: a head preview plus the agent:// pointer (session 01a19ae2, job ArisReviewRound1). */
const LONG_REVIEW = `1. 검토 범위 — 직접 읽은 파일과 한계\n\n${Array.from({ length: 300 }, (_, i) => `- 지적 ${i + 1}: 근거 파일 대조 결과`).join("\n")}\n\n인용: <system-notice>quoted artifact text</system-notice>\nEND-OF-REVIEW-MARKER`;
const previewJob = (id, more = {}) => ({ id, type: "task", status: "completed", resolvedModel: `${ASTRA}:max`, resolvedModelIdentity: ASTRA, resolvedThinkingLevel: "max", agentUrlId: id,
  resultText: `<task-result id="${id}" agent="aris-reviewer" status="completed" duration="11m7s">\n<meta lines="318" size="16.5KB" />\n<preview full-output="agent://${more.pointer ?? id}">\n${LONG_REVIEW.slice(0, 120)}\n</preview>\n</task-result>\n\n${id} is now idle — message it via \`write agent://${id}\` to follow up; transcript at history://${id}`,
  ...more, pointer: undefined });

async function detachedRound(h, id = "ArisReviewRound1", more = {}) {
  const prepared = h.event("tool_call", { toolName: "task", toolCallId: "t1", input: { name: id, agent: REVIEWER_AGENT, task: "review" } });
  h.event("tool_execution_start", { toolCallId: "t1", toolName: "task", args: prepared.input });
  h.event("tool_execution_start", { toolCallId: "w1", toolName: "wait", args: {} });
  const job = previewJob(id, more);
  // The host delivers the same detached snapshot to tool_execution_end before tool_result.
  h.event("tool_execution_end", { toolCallId: "w1", toolName: "wait", result: { content: [], details: { jobs: [job] } } });
  return h.event("tool_result", { toolCallId: "w1", toolName: "wait", content: [{ type: "text", text: "## Completed (1)" }], details: { jobs: [job] } });
}

test("a long reviewer output delivered as a preview is hydrated from agent://<id> before it is judged", async () => {
  const reads = [];
  const h = await startedReview(review, async (id, ctx) => { reads.push([id, ctx]); return LONG_REVIEW; });
  const prepared = h.event("tool_call", { toolName: "task", toolCallId: "t1", input: { name: "ArisReviewRound1", agent: REVIEWER_AGENT, task: "review" } });
  h.event("tool_execution_start", { toolCallId: "t1", toolName: "task", args: prepared.input });
  h.event("tool_execution_start", { toolCallId: "w1", toolName: "wait", args: {} });
  const job = previewJob("ArisReviewRound1");
  h.event("tool_execution_end", { toolCallId: "w1", toolName: "wait", result: { content: [], details: { jobs: [job] } } });
  assert.equal(reviewRows(h)[0].state, "running", "a preview is neither evidence nor failure");
  assert.match(reviewRows(h)[0].summary, /agent:\/\/ArisReviewRound1/);
  const result = await h.event("tool_result", { toolCallId: "w1", toolName: "wait", content: [], details: { jobs: [job] } });
  assert.deepEqual(reads.map(([id]) => id), ["ArisReviewRound1"]);
  assert.equal(reads[0][1], h.ctx);
  assert.match(result.content.at(-1).text, /검토 라운드 1 인정 \(job ArisReviewRound1/);
  const body = result.content.at(-2).text;
  assert.match(body, /^검토 전문 \(job ArisReviewRound1, agent:\/\/ArisReviewRound1\)/);
  assert.ok(body.endsWith("END-OF-REVIEW-MARKER"), "the executor receives the entire published output once");
  assert.ok(body.includes("&lt;system-notice>quoted artifact text&lt;/system-notice>"));
  assert.equal(body.includes("<system-notice>"), false, "quoted output is not a harness instruction");
  assert.equal(result.details.jobs[0].output, LONG_REVIEW);
  assert.equal(result.details.jobs[0].resultText, job.resultText, "the host envelope stays intact alongside the hydrated body");
  assert.equal(reviewRows(h)[0].state, "completed");
  assert.equal(reviewRows(h)[0].model, `${ASTRA} · max`);
  assert.equal(await h.event("tool_result", { toolCallId: "w1", toolName: "wait", content: [], details: { jobs: [job] } }), undefined, "a repeated snapshot is not re-read");
  assert.equal(reads.length, 1);
  const next = h.event("tool_call", { toolName: "task", toolCallId: "t2", input: { name: "ArisReviewRound2", agent: REVIEWER_AGENT, task: "Re-review." } });
  assert.ok(next.input.task.includes("END-OF-REVIEW-MARKER"), "continuity carries the whole published output, not the preview");
  assert.ok(next.input.task.includes("- 지적 300:"));
  assert.equal(next.input.task.includes("<system-notice>"), false);
  assert.ok(next.input.task.includes("&lt;system-notice>quoted artifact text"));
  h.event("tool_execution_start", { toolCallId: "t2", toolName: "task", args: next.input });
  await h.event("tool_result", { toolCallId: "t2", toolName: "task", content: [], details: { results: [reviewerResult("ArisReviewRound2")] } });
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Answered every finding." }] };
  h.event("message_end", { message });
  h.event("agent_end", { messages: [message] });
  assert.equal(latestFlow(h).status, "completed");
});

test("an unnamed task gets a reserved name before dispatch and its full result unlocks another round", async () => {
  const reads = [];
  const h = await startedReview(review, async id => { reads.push(id); return LONG_REVIEW; });
  const prepared = h.event("tool_call", { toolName: "task", toolCallId: "t1", input: { agent: REVIEWER_AGENT, task: "review without a name" } });
  const id = prepared.input.name;
  h.event("tool_execution_start", { toolCallId: "t1", toolName: "task", args: prepared.input });
  const result = await h.event("tool_result", { toolCallId: "t1", toolName: "task", content: [],
    details: { results: [{ ...previewJob(id), agent: REVIEWER_AGENT, exitCode: 0 }] } });
  assert.deepEqual(reads, [id]);
  assert.equal(reviewRows(h)[0].state, "completed");
  assert.ok(result.content.at(-2).text.endsWith("END-OF-REVIEW-MARKER"));
  const next = h.event("tool_call", { toolName: "task", toolCallId: "t2", input: { name: "Round2", agent: REVIEWER_AGENT, task: "Re-review." } });
  assert.ok(next.input.task.includes("END-OF-REVIEW-MARKER"));
});

test("a short inline output never triggers a read", async () => {
  const reads = [];
  const h = await startedReview(review, async id => { reads.push(id); return "unused"; });
  const prepared = h.event("tool_call", { toolName: "task", toolCallId: "r1", input: { name: "Round1", agent: REVIEWER_AGENT, task: "review" } });
  h.event("tool_execution_start", { toolCallId: "r1", toolName: "task", args: prepared.input });
  const result = await h.event("tool_result", { toolCallId: "r1", toolName: "task", content: [], details: { results: [reviewerResult("Round1")] } });
  assert.match(result.content.at(-1).text, /검토 라운드 1 인정/);
  assert.deepEqual(reads, []);
});

test("preview hydration fails honestly: foreign pointer, read error, empty document, mismatched head, wrong model", async () => {
  const cases = [
    { more: { pointer: "OtherAgent" }, reader: async () => LONG_REVIEW, reads: 0, problem: /본문이 비어/ },
    { more: {}, reader: async () => { throw new Error("No artifacts directory found"); }, reads: 1, problem: /agent:\/\/ArisReviewRound1\)을 확인하지 못함: No artifacts directory found/ },
    { more: {}, reader: async () => "   ", reads: 1, problem: /본문이 비어 있음/ },
    { more: {}, reader: async () => "Different text that is not the previewed output", reads: 1, problem: /미리보기와 일치하지 않음/ },
    { more: { resolvedModel: "anthropic/claude-sonnet-4-6", resolvedModelIdentity: "anthropic/claude-sonnet-4-6" }, reader: async () => LONG_REVIEW, reads: 0, problem: /검토자 모델 불일치/ },
  ];
  for (const { more, reader, reads: expected, problem } of cases) {
    let reads = 0;
    const h = await startedReview(review, id => { reads++; return reader(id); });
    const result = await detachedRound(h, "ArisReviewRound1", more);
    assert.equal(reads, expected, JSON.stringify(more));
    assert.match(result.content.at(-1).text, /REVIEW_UNAVAILABLE \(job ArisReviewRound1\)/);
    assert.match(result.content.at(-1).text, problem);
    assert.equal(reviewRows(h)[0].state, "failed");
    const next = h.event("tool_call", { toolName: "task", toolCallId: "t2", input: { name: "ArisReviewRound2", agent: REVIEWER_AGENT, task: "again" } });
    assert.equal(next.block, true, "failed evidence cannot be retried by another round automatically");
    const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
    h.event("message_end", { message });
    h.event("agent_end", { messages: [message] });
    assert.equal(latestFlow(h).status, "failed", JSON.stringify(more));
  }
});

test("a run stopped while agent:// is being read is left untouched by the late result", async () => {
  const gate = deferred();
  const h = await startedReview(review, async () => { await gate.promise; return LONG_REVIEW; });
  const pending = detachedRound(h);
  await h.command("stop");
  assert.equal(latestFlow(h).status, "cancelled");
  const snapshot = JSON.stringify(latestFlow(h));
  gate.resolve();
  assert.equal(await pending, undefined, "no note for a run that no longer exists");
  assert.equal(JSON.stringify(latestFlow(h)), snapshot);
});

test("every named native job gets its own node, including default tasks without an agent", async () => {
  const h = await startedReview();
  h.event("tool_execution_start", { toolCallId: "n1", toolName: "task", args: { tasks: [
    { name: "CollectHome", agent: "scout", task: "a" }, { name: "CollectMnt", agent: "scout", task: "b" }, { name: "Plain", task: "c" }, { agent: "scout", task: "unnamed" },
  ] } });
  const native = latestFlow(h).rows.filter(row => row.id.startsWith("native:"));
  assert.deepEqual(native.map(row => [row.id, row.agent, row.state]), [["native:CollectHome", "scout", "pending"], ["native:CollectMnt", "scout", "pending"], ["native:Plain", "task", "pending"]]);
  h.event("tool_execution_end", { toolCallId: "n1", toolName: "task", isError: true, result: { content: [{ type: "text", text: "spawn refused" }], details: {} } });
  assert.ok(latestFlow(h).rows.filter(row => row.id.startsWith("native:")).every(row => row.state === "failed" && row.summary === "spawn refused"));
});

test("a reviewer result without model metadata, with the wrong model, or without output is REVIEW_UNAVAILABLE and fails completion", async () => {
  for (const variant of [{ resolvedModelIdentity: undefined }, { resolvedModelIdentity: "anthropic/claude-sonnet-4-6" }, { output: "   " }]) {
    const h = await startedReview();
    const prepared = h.event("tool_call", { toolName: "task", toolCallId: "r1", input: { name: "Round1", agent: REVIEWER_AGENT, task: "review" } });
    h.event("tool_execution_start", { toolCallId: "r1", toolName: "task", args: prepared.input });
    const result = await h.event("tool_result", { toolCallId: "r1", toolName: "task", content: [], details: { results: [reviewerResult("Round1", variant)] } });
    assert.match(result.content.at(-1).text, /REVIEW_UNAVAILABLE \(job Round1\)/);
    assert.equal(reviewRows(h)[0].state, "failed");
    const next = h.event("tool_call", { toolName: "task", toolCallId: "r2", input: { name: "Round2", agent: REVIEWER_AGENT, task: "again" } });
    assert.equal(next.block, true, "invalid evidence cannot be retried by another round automatically");
    const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
    h.event("message_end", { message });
    h.event("agent_end", { messages: [message] });
    assert.equal(latestFlow(h).status, "failed", JSON.stringify(variant));
  }
});

test("a review skill whose reviewer never completed is incomplete, while a non-review skill completes without one", async () => {
  const h = await startedReview();
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "I reviewed it myself." }] };
  h.event("message_end", { message });
  h.event("agent_end", { messages: [message] });
  assert.equal(latestFlow(h).status, "incomplete");
  assert.match(latestFlow(h).note, /aris-reviewer 완료가 관측되지 않았습니다/);

  const search = await startedReview(routed({ route: "research", skills: ["arxiv"], reason: "Literature search." }));
  assert.equal(search.handoff().details.reviewRequired, false);
  search.event("message_end", { message });
  search.event("agent_end", { messages: [message] });
  assert.equal(latestFlow(search).status, "completed");
});

test("late native progress from an older run cannot update a replacement review flow", async () => {
  const h = await startedReview();
  const prepared = h.event("tool_call", { toolName: "task", toolCallId: "old-call", input: { name: "Round1", agent: REVIEWER_AGENT, task: "review" } });
  h.event("tool_execution_start", { toolCallId: "old-call", toolName: "task", args: prepared.input });
  await h.command("stop");
  h.setIdle(true);
  h.input("replacement review");
  await h.flush();
  const before = structuredClone(latestFlow(h));
  h.event("tool_execution_update", { toolCallId: "old-call", toolName: "task", partialResult: { details: {
    progress: [{ id: "Round1", agent: REVIEWER_AGENT, status: "completed" }],
  } } });
  assert.deepEqual(latestFlow(h), before);
  assert.equal(reviewRows(h).length, 0);
});

test("in-place compaction preserves an ARIS run and accepts its pending reviewer result", async () => {
  const h = await startedReview();
  const prepared = h.event("tool_call", { toolName: "task", toolCallId: "r1", input: { name: "Round1", agent: REVIEWER_AGENT, task: "review" } });
  h.event("tool_execution_start", { toolCallId: "r1", toolName: "task", args: prepared.input });
  h.event("tool_execution_update", { toolCallId: "r1", toolName: "task", partialResult: { details: { progress: [{ id: "Round1", agent: REVIEWER_AGENT, status: "running" }] } } });
  await h.event("session_before_compact");
  h.event("session_compact");
  assert.equal(latestFlow(h).status, "running");
  h.event("agent_end", { willContinue: true, awaitingAsyncWork: true });
  h.event("tool_execution_start", { toolCallId: "peer-wait", toolName: "wait", args: {} });
  await h.event("tool_result", { toolCallId: "peer-wait", toolName: "wait", content: [], details: { jobs: [{
    id: "Round1", type: "task", status: "completed", resolvedModelIdentity: ASTRA, output: "Post-compaction review text.",
  }] } });
  assert.equal(reviewRows(h)[0].state, "completed");
  const next = h.event("tool_call", { toolName: "task", toolCallId: "r2", input: { name: "Round2", agent: REVIEWER_AGENT, task: "Re-review" } });
  assert.match(next.input.task, /Post-compaction review text/);
  await h.command("stop");
  assert.equal(latestFlow(h).status, "cancelled");
});

test("/dialogue skills lists the installed catalog with readiness and no agent-era aliases", async () => {
  const h = harness(review);
  await h.command("skills");
  const listing = h.cards.at(-1);
  assert.deepEqual(listing.details.skills, ["research-review", "arxiv", "auto-review-loop"]);
  assert.equal(listing.details.available, true);
  const cardsBefore = h.cards.length;
  await h.command("agents");
  assert.equal(h.cards.length, cardsBefore);
  assert.match(h.notices.at(-1)[0], /\/dialogue skills/);
});

const automaticDelivery = (id, content = "host delivery") => ({ message: {
  role: "custom", customType: "async-result", content,
  details: { jobs: [{ jobId: id, agentId: id, type: "task", status: "completed" }] },
} });

test("automatic delivery completes a known review and retains its published evidence without another tool result", async () => {
  const reads = [];
  const full = "Original artifact check: measured latency is missing.\nEND-AUTO-REVIEW";
  const h = await startedReview(review, async id => { reads.push(id); return full; });
  h.event("tool_execution_start", { toolCallId: "auto-task", toolName: "task", args: { name: "AutoReview", agent: REVIEWER_AGENT } });
  h.event("tool_execution_update", { toolCallId: "auto-task", partialResult: { details: {
    progress: [{ id: "AutoReview", agent: REVIEWER_AGENT, status: "running", resolvedModelIdentity: ASTRA }],
  } } });
  await h.event("message_end", automaticDelivery("UnknownJob"));
  assert.deepEqual(reads, []);
  await h.event("message_end", automaticDelivery("AutoReview"));
  assert.equal(reviewRows(h)[0].state, "completed");
  assert.deepEqual(reads, ["AutoReview"]);
  assert.ok(h.context().some(card => card.details.phase === "evidence" && card.content.includes(full)));
  await h.event("message_end", automaticDelivery("AutoReview"));
  assert.deepEqual(reads, ["AutoReview"], "repeated delivery cannot read or admit the same review twice");
  h.event("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(latestFlow(h).status, "completed");
});

test("automatic delivery without observed model metadata cannot acquit a reviewer", async () => {
  const h = await startedReview(review, async () => "A public result is not model identity.");
  h.event("tool_execution_start", { toolCallId: "unbound", toolName: "task", args: { name: "NoIdentity", agent: REVIEWER_AGENT } });
  await h.event("message_end", automaticDelivery("NoIdentity", "claims to be Astra"));
  assert.equal(reviewRows(h)[0].state, "failed");
  h.event("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(latestFlow(h).status, "failed");
});

test("stopping during automatic output retrieval prevents a late evidence message", async () => {
  const pending = deferred();
  const h = await startedReview(review, () => pending.promise);
  h.event("tool_execution_start", { toolCallId: "late-auto", toolName: "task", args: { name: "LateAuto", agent: REVIEWER_AGENT } });
  const delivery = h.event("message_end", automaticDelivery("LateAuto"));
  await h.command("stop");
  const stopped = structuredClone(latestFlow(h));
  pending.resolve("Late published review");
  await delivery;
  assert.deepEqual(latestFlow(h), stopped);
  assert.equal(h.cards.some(card => card.details.phase === "evidence"), false);
});

test("closing the flow explorer during routing does not cancel or execute the request", async () => {
  const hold = heldTurn();
  let options;
  const h = harness(hold.run, [], skillsModule(), undefined, (_get, _theme, value) => {
    options = value;
    return { render: () => [], invalidate() {} };
  });
  h.ctx.ui.custom = factory => new Promise(resolve => {
    factory({ terminal: { rows: 40 }, requestRender() {} }, undefined, {}, resolve);
  });
  await h.command("on");
  h.input("Plan the implementation.");
  const routing = h.flush();
  const entriesBefore = h.entries.length;
  const cardsBefore = h.cards.length;
  const viewing = h.command("flow");
  assert.equal(h.press("\x1b"), undefined, "the inspector owns Escape while routing continues");
  options.onClose();
  await viewing;
  assert.equal(hold.signal.aborted, false);
  assert.equal(h.entries.length, entriesBefore);
  assert.equal(h.cards.length, cardsBefore);
  assert.deepEqual(h.prompts, []);
  await h.command("stop");
  hold.release();
  await routing;
});

test("flow detail reads require a known node and discard output after the inspector closes", async () => {
  const pending = deferred();
  let options;
  const reads = [];
  const h = harness(review, [], skillsModule(), id => { reads.push(id); return pending.promise; }, (_get, _theme, value) => {
    options = value;
    return { render: () => [], invalidate() {} };
  });
  h.ctx.ui.custom = factory => new Promise(resolve => {
    factory({ terminal: { rows: 40 }, requestRender() {} }, undefined, {}, resolve);
  });
  await h.command("on");
  h.input("Review the public artifact.");
  await h.flush();
  h.event("tool_execution_start", { toolCallId: "inspect", toolName: "task", args: { name: "InspectReview", agent: REVIEWER_AGENT, task: "Inspect the methods." } });
  const stored = structuredClone(latestFlow(h));
  const cardsBefore = h.cards.length;
  const viewing = h.command("flow");
  await assert.rejects(options.readOutput({ id: "foreign" }));
  assert.deepEqual(reads, []);
  const reading = options.readOutput({ id: "review:InspectReview" });
  options.onClose();
  await viewing;
  pending.resolve("This late output must not reach another panel.");
  await assert.rejects(reading);
  assert.deepEqual(reads, ["InspectReview"]);
  assert.deepEqual(latestFlow(h), stored);
  assert.equal(h.cards.length, cardsBefore);
});

test("generic automatic delivery fills complete public results in solo and ARIS without injecting evidence", async () => {
  for (const route of [solo, review]) {
    const reads = [];
    const output = `${"public result\n".repeat(60)}END-GENERIC`;
    const h = harness(route, [], skillsModule(), async id => { reads.push(id); return output; });
    await h.command("on");
    h.input("Inspect the implementation.");
    await h.flush();
    h.event("tool_execution_start", { toolCallId: "generic-auto", toolName: "task",
      args: { context: "Shared public context.", tasks: [{ name: "GenericAuto", task: "Inspect public files." }] } });
    h.emit("task:subagent:progress", { parentToolCallId: "generic-auto", agent: "task", task: "Inspect public files.",
      progress: { id: "GenericAuto", status: "running", resolvedModelIdentity: ASTRA, resolvedThinkingLevel: "max" } });
    h.emit("task:subagent:lifecycle", { parentToolCallId: "generic-auto", id: "GenericAuto", agent: "task", status: "completed" });
    assert.equal(latestFlow(h).rows.find(row => row.id === "native:GenericAuto").state, "completed");
    const before = h.cards.length;
    await h.event("message_end", automaticDelivery("GenericAuto"));
    const row = latestFlow(h).rows.find(row => row.id === "native:GenericAuto");
    assert.equal(row.output, output);
    assert.equal(row.task, "Shared public context.\n\nInspect public files.");
    assert.equal(row.parentId, "final");
    assert.equal(row.model, `${ASTRA} · max`);
    assert.equal(row.jobs[0].resultReceived, true);
    assert.equal(h.cards.length, before, "generic output never creates ARIS evidence or another model turn");
    await h.event("message_end", automaticDelivery("GenericAuto"));
    assert.deepEqual(reads, ["GenericAuto"]);
    await h.command("stop");
  }
});

test("native staged agents retain public streaming output while eval spawning is refused", async () => {
  const h = harness(routed({ route: "solo", reason: "Inspect", waves: [
    { id: "Inspect", title: "Inspect", goal: "Inspect requested inputs", parallel: 1 },
  ] }), [], skillsModule(), async () => "Full eval agent output\nEND-EVAL");
  await h.command("on");
  h.input("Inspect using native task.");
  await h.flush();
  assert.equal(h.event("before_subagent_spawn", { invocationKind: "eval", spawnKey: "Bypass", agent: "task" }).block, true);
  const prepared = h.event("tool_call", { toolName: "task", input: { name: "EvalGenerated", task: "Inspect the full runtime." } });
  h.event("tool_execution_start", { toolCallId: "eval-spawn", toolName: "task", args: prepared.input });
  h.emit("task:subagent:progress", { parentToolCallId: "eval-spawn", agent: "task", task: "Inspect the full runtime.",
    progress: { id: "EvalGenerated", status: "running", resolvedModelIdentity: ASTRA } });
  const savedBeforeStream = h.entries.filter(entry => entry.customType === FLOW).length;
  h.emit("task:subagent:event", { id: "EvalGenerated", event: { type: "message_update", message: {
    role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "Visible partial output" }],
  } } });
  let row = latestFlow(h).rows.find(row => row.id === "native:EvalGenerated");
  assert.equal(row.state, "running");
  assert.equal(row.output, "Visible partial output");
  assert.equal(JSON.stringify(latestFlow(h)).includes("PRIVATE"), false);
  assert.equal(h.entries.filter(entry => entry.customType === FLOW).length, savedBeforeStream,
    "streamed public text updates live state without appending a full flow per token");
  h.emit("task:subagent:event", { id: "EvalGenerated", event: { type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text: "Visible completed turn" }],
  } } });
  assert.equal(h.entries.filter(entry => entry.customType === FLOW).length, savedBeforeStream + 1,
    "a completed public turn persists the latest flow once");
  await h.event("message_end", automaticDelivery("EvalGenerated"));
  row = latestFlow(h).rows.find(row => row.id === "native:EvalGenerated");
  assert.equal(row.output, "Full eval agent output\nEND-EVAL");
  assert.equal(row.state, "completed");
  await h.command("stop");
});

test("an admitted child cannot recursively bypass the main-owned Wave schedule", async () => {
  const root = await startedReview();
  root.event("tool_execution_start", { toolCallId: "parent-spawn", toolName: "task",
    args: { name: "ObservedParent", agent: "task", task: "Work only on the assigned packet." } });
  root.emit("task:subagent:lifecycle", { parentToolCallId: "parent-spawn", id: "ObservedParent", agent: "task", status: "started" });
  const child = harness(solo, [], skillsModule(), undefined, undefined,
    { kind: "sub", id: "ObservedParent", name: "task", depth: 1, parentId: "Main" });
  child.changeSession("child-session");
  child.event("session_start");
  assert.equal(child.event("tool_call", { toolName: "task", input: { name: "Nested", task: "Do not run." } }).block, true);
  assert.equal(child.event("before_subagent_spawn", { invocationKind: "task", spawnKey: "Nested", agent: "task" }).block, true);
  assert.equal(child.event("before_subagent_spawn", { invocationKind: "eval", spawnKey: "NestedEval", agent: "task" }).block, true);
  assert.deepEqual(latestFlow(root).rows.flatMap(row => row.jobIds), ["ObservedParent"]);
  await child.event("session_shutdown");
  await root.command("stop");
});

test("foreign, cancelled and replaced factory events cannot contaminate the current run", async () => {
  const root = await startedReview();
  root.event("tool_execution_start", { toolCallId: "owned-call", toolName: "task",
    args: { name: "ScopedParent", task: "Work." } });
  const child = harness(solo, [], skillsModule(), undefined, undefined,
    { kind: "sub", id: "ScopedParent", name: "task", depth: 1, parentId: "Main" });
  child.changeSession("old-child");
  child.event("tool_execution_start", { toolCallId: "child-call", toolName: "eval", args: {} });
  const foreign = harness(solo, [], skillsModule(), undefined, undefined,
    { kind: "sub", id: "ScopedParent", name: "task", depth: 1, parentId: "OtherMain" });
  foreign.changeSession("foreign-child");
  const before = structuredClone(latestFlow(root));
  foreign.event("tool_execution_start", { toolCallId: "foreign-call", toolName: "task", args: { name: "Foreign", task: "No." } });
  root.emit("task:subagent:progress", { parentToolCallId: "foreign-call", agent: "task",
    progress: { id: "Foreign", status: "running" } });
  root.emit("task:subagent:progress", { agent: "task", progress: { id: "UnattestedEval", status: "running" } });
  root.event("tool_execution_start", { toolCallId: "unrelated-wait", toolName: "wait", args: {} });
  await root.event("tool_result", { toolCallId: "unrelated-wait", toolName: "wait", content: [], details: {
    jobs: [{ id: "Foreign", agent: "task", type: "task", status: "completed", output: "Not owned." }],
  } });
  assert.deepEqual(latestFlow(root), before);
  child.changeSession("unrelated-navigation");
  child.event("session_switch");
  child.event("tool_execution_start", { toolCallId: "navigated-call", toolName: "task",
    args: { name: "NavigatedForeign", task: "Different session." } });
  assert.deepEqual(latestFlow(root), before);
  await root.command("stop");
  const cancelled = structuredClone(latestFlow(root));
  child.emit("task:subagent:progress", { parentToolCallId: "child-call", agent: "task",
    progress: { id: "CancelledDescendant", status: "running" } });
  assert.deepEqual(latestFlow(root), cancelled);
  root.setIdle(true);
  root.input("Replacement run.");
  await root.flush();
  root.event("tool_execution_start", { toolCallId: "new-parent", toolName: "task", args: { name: "ScopedParent", task: "New work." } });
  const replacement = structuredClone(latestFlow(root));
  child.event("tool_execution_start", { toolCallId: "stale-spawn", toolName: "task", args: { name: "StaleDescendant", task: "Old work." } });
  child.emit("task:subagent:progress", { parentToolCallId: "stale-spawn", agent: "task",
    progress: { id: "StaleDescendant", status: "running" } });
  root.emit("task:subagent:lifecycle", { parentToolCallId: "owned-call", id: "ScopedParent", agent: "task", status: "completed" });
  assert.deepEqual(latestFlow(root), replacement);
  await child.event("session_shutdown");
  await foreign.event("session_shutdown");
  await root.command("stop");
});

test("Terra stages reserve parallel capacity and cannot advance until every public result arrives", async () => {
  const h = harness(routed({ route: "solo", reason: "Inspect then check", waves: [
    { id: "Inspect", title: "Inspect", goal: "Collect independent inputs", parallel: 2 },
    { id: "Check", title: "Check", goal: "Check the collected inputs", parallel: 1 },
  ] }));
  await h.command("on");
  h.input("Use two execution stages.");
  await h.flush();
  const request = (id, name) => h.event("tool_call", {
    toolName: "task", toolCallId: id, input: { name, task: "Read the assigned input only." },
  });
  const first = request("first", "Inspect__First");
  const second = request("second", "Inspect__Second");
  assert.equal(request("overflow", "Inspect__Third").block, true, "capacity is reserved before host execution starts");
  assert.equal(request("early", "Check__Early").block, true);
  h.event("tool_execution_start", { toolCallId: "first", toolName: "task", args: first.input });
  h.event("tool_execution_start", { toolCallId: "second", toolName: "task", args: second.input });
  h.event("tool_execution_start", { toolCallId: "results", toolName: "wait", args: {} });
  await h.event("tool_result", { toolCallId: "results", toolName: "wait", content: [], details: { results: [
    { id: "Inspect__First", status: "completed", output: "First evidence" },
  ] } });
  h.emit("task:subagent:lifecycle", { parentToolCallId: "second", id: "Inspect__Second", agent: "task", status: "completed" });
  assert.equal(request("no-body", "Check__NoBody").block, true, "lifecycle completion alone cannot open the barrier");
  await h.event("tool_result", { toolCallId: "results", toolName: "wait", content: [], details: { results: [
    { id: "Inspect__Second", status: "completed", output: "Second evidence" },
  ] } });
  const next = request("next", "Check__Final");
  h.event("tool_execution_start", { toolCallId: "next", toolName: "task", args: next.input });
  const node = latestFlow(h).rows.find(row => row.jobIds.includes("Check__Final"));
  assert.equal(node.wave, 3);
  assert.equal(node.parentId, "final");
  assert.equal(request("backward", "Inspect__Late").block, true);
  await h.event("tool_result", { toolCallId: "results", toolName: "wait", content: [], details: { results: [
    { id: "Check__Final", status: "completed", output: "Both inputs checked" },
  ] } });
  h.event("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
  assert.equal(latestFlow(h).status, "completed");
});
