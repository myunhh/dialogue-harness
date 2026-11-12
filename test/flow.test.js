import test from "node:test";
import assert from "node:assert/strict";
import { FLOW, createFlow, expectNative, finishFlow, flowText, observeNative, planFlow, publicSummary, publicText, restoreFlow, reviewEvidence, reviewProblem, startExecution, updateStage, workerEvidence, workerProblem } from "../flow.js";
import { REVIEWER_AGENT, WORKER_AGENT } from "../aris-runtime.js";

const RUN_ID = "0f1e2d3c-4b5a-4697-8877-66554433aabb";
/** Role → pinned selector contract: Fable brain, Opus worker, Astra solo/reviewer. */
const CONFIG = Object.freeze({ fable: "anthropic/claude-fable-5-2", opus: "anthropic/claude-opus-5-5", astra: "openai-codex/gpt-6-astra" });
function aris(route = "dialogue", skills = ["research-review"], reviewRequired = true) {
  const flow = createFlow(RUN_ID);
  planFlow(flow, { route, skills, reason: "Review requested", waves: [] }, CONFIG, { reviewRequired });
  startExecution(flow);
  return flow;
}
const row = (flow, id) => flow.rows.find(item => item.id === id);
const reviews = flow => flow.rows.filter(item => item.review === true);
const workers = flow => flow.rows.filter(item => item.worker === true);
const progress = (id, status, more = {}) => ({ details: { progress: [{ id, agent: REVIEWER_AGENT, status, ...more }] } });
const jobs = (id, status, more = {}) => ({ details: { jobs: [{ id, type: "task", status, ...more }] } });
const done = (id, more = {}) => ({ details: { results: [{ id, agent: REVIEWER_AGENT, exitCode: 0, resolvedModelIdentity: CONFIG.astra, output: `review ${id}`, ...more }] } });
const workerProgress = (id, status, more = {}) => ({ details: { progress: [{ id, agent: WORKER_AGENT, status, ...more }] } });
const workerDone = (id, more = {}) => ({ details: { results: [{ id, agent: WORKER_AGENT, exitCode: 0, output: `implemented ${id}`, ...more }] } });

test("ARIS routes plan a Fable brain row, a pinned Opus worker and a pinned Astra reviewer; solo stays Astra", () => {
  const flow = aris("research", ["arxiv", "experiment-plan"], false);
  assert.equal(row(flow, "router").state, "completed");
  assert.equal(row(flow, "router").role, "router");
  const brain = row(flow, "final");
  assert.equal(brain.state, "running");
  assert.equal(brain.agent, "Fable");
  assert.equal(brain.model, CONFIG.fable);
  assert.equal(brain.role, "brain");
  assert.equal(brain.parentId, "router");
  assert.deepEqual(flow.skills, ["arxiv", "experiment-plan"]);
  assert.deepEqual(flow.worker, { agent: WORKER_AGENT, model: CONFIG.opus });
  assert.deepEqual(flow.reviewer, { agent: REVIEWER_AGENT, model: CONFIG.astra });
  assert.equal(flow.reviewRequired, false);
  assert.equal(workers(flow).length, 0, "no worker row exists until the brain delegates");
  const solo = createFlow("solo");
  planFlow(solo, { route: "solo", reason: "Direct", waves: [] }, CONFIG);
  assert.equal(solo.reviewer, undefined);
  assert.equal(solo.worker, undefined);
  assert.equal(row(solo, "final").agent, "Astra");
  assert.equal(row(solo, "final").model, CONFIG.astra);
  assert.equal(row(solo, "final").role, "solo");
  assert.equal(row(solo, "final").parentId, "router");
});

test("every reviewer job is its own observed round; agent-less wait snapshots need a prior association", () => {
  const flow = aris();
  assert.equal(observeNative(flow, jobs("Round1", "running")), false, "unknown id without agent is ignored");
  assert.equal(reviews(flow).length, 0);
  observeNative(flow, progress("Round1", "running", { resolvedModelIdentity: CONFIG.astra, resolvedThinkingLevel: "xhigh", thinking: "PRIVATE" }));
  assert.equal(reviews(flow).length, 1);
  assert.equal(reviews(flow)[0].state, "running");
  assert.equal(reviews(flow)[0].model, `${CONFIG.astra} · xhigh`);
  assert.equal(reviews(flow)[0].agent, "Astra");
  assert.equal(JSON.stringify(flow).includes("PRIVATE"), false);
  observeNative(flow, jobs("Round1", "completed", { resolvedModelIdentity: CONFIG.astra, output: "found gaps" }));
  assert.equal(reviews(flow)[0].state, "completed");
  assert.equal(reviews(flow)[0].summary, "found gaps");
  expectNative(flow, REVIEWER_AGENT, "Round2");
  assert.equal(reviews(flow).length, 2);
  assert.match(reviews(flow)[1].label, /라운드 2/);
  observeNative(flow, jobs("Round2", "running"));
  assert.equal(reviews(flow)[1].state, "running");
  assert.equal(expectNative(flow, REVIEWER_AGENT, "Round2"), false, "idempotent");
});

test("reviewer completion needs explicit matching model metadata and nonempty output", () => {
  const flow = aris();
  assert.equal(reviewProblem(flow, { id: "x", output: "text", resolvedModelIdentity: "OPENAI-CODEX/GPT-6-ASTRA@2026" }), undefined);
  assert.equal(reviewProblem(flow, { id: "x", output: "text", resolvedModel: CONFIG.astra }), undefined);
  assert.match(reviewProblem(flow, { id: "x", output: "text" }), /모델 메타데이터가 없어/);
  assert.match(reviewProblem(flow, { id: "x", output: "text", resolvedModelIdentity: CONFIG.opus }), /모델 불일치/);
  assert.match(reviewProblem(flow, { id: "x", output: " \n", resolvedModelIdentity: CONFIG.astra }), /본문이 비어/);
  assert.match(reviewProblem(flow, { id: "x", resolvedModelIdentity: CONFIG.astra, structuredOutput: { status: "invalid", data: { a: 1 } } }), /본문이 비어/);
  assert.equal(reviewProblem(flow, { id: "x", resolvedModelIdentity: CONFIG.astra, structured: { status: "valid", data: { summary: "ok" } } }), undefined);

  observeNative(flow, done("Round1", { resolvedModelIdentity: undefined }));
  assert.equal(reviews(flow)[0].state, "failed");
  assert.match(reviews(flow)[0].summary, /모델 메타데이터/);
  // A later optimistic "completed" snapshot cannot erase the failure.
  observeNative(flow, jobs("Round1", "completed"));
  assert.equal(reviews(flow)[0].state, "failed");
  assert.deepEqual(reviewEvidence(flow), { rounds: 1, completed: 0, required: true });
  finishFlow(flow, "completed");
  assert.equal(flow.status, "failed");
});

test("completion-only progress waits for the result and cannot invalidate an already verified review", () => {
  const flow = aris();
  observeNative(flow, progress("Round1", "running"));
  observeNative(flow, progress("Round1", "completed", { resolvedModelIdentity: CONFIG.astra }));
  assert.equal(reviews(flow)[0].state, "running");
  assert.equal(reviewEvidence(flow).completed, 0);
  observeNative(flow, done("Round1"));
  assert.equal(reviews(flow)[0].state, "completed");
  observeNative(flow, jobs("Round1", "completed"));
  assert.equal(reviews(flow)[0].state, "completed");
  finishFlow(flow, "completed");
  assert.equal(flow.status, "completed");
});

test("honest completion: required reviewer rounds must be observed complete; unrequired skills complete alone", () => {
  const required = aris();
  finishFlow(required, "completed");
  assert.equal(required.status, "incomplete");
  assert.match(required.note, /aris-reviewer 완료가 관측되지 않았습니다/);

  const reviewed = aris();
  observeNative(reviewed, done("Round1"));
  observeNative(reviewed, done("Round2"));
  finishFlow(reviewed, "completed");
  assert.equal(reviewed.status, "completed");
  assert.match(reviewed.note, /검토자 라운드 2회 완료 관측/);
  assert.equal(row(reviewed, "final").state, "completed");

  const pending = aris();
  observeNative(pending, done("Round1"));
  observeNative(pending, progress("Round2", "running"));
  finishFlow(pending, "completed");
  assert.equal(pending.status, "incomplete");
  assert.equal(reviews(pending)[1].state, "interrupted");

  const search = aris("research", ["arxiv"], false);
  finishFlow(search, "completed");
  assert.equal(search.status, "completed");
});

test("parallel jobs using the same agent retain separate states, models, and failures", () => {
  const flow = aris();
  expectNative(flow, "scout", "Helper1");
  expectNative(flow, "scout", "Helper2");
  observeNative(flow, { details: { progress: [
    { id: "Helper1", agent: "scout", status: "running", resolvedModelIdentity: CONFIG.astra },
    { id: "Helper2", agent: "scout", status: "running", resolvedModelIdentity: CONFIG.opus },
  ] } });
  observeNative(flow, { details: { results: [
    { id: "Helper1", agent: "scout", exitCode: 1, error: "provider capacity exceeded" },
  ] } });
  const first = flow.rows.find(item => item.jobIds.includes("Helper1"));
  const second = flow.rows.find(item => item.jobIds.includes("Helper2"));
  assert.notEqual(first, second);
  assert.equal(first.state, "failed");
  assert.equal(first.summary, "provider capacity exceeded");
  assert.equal(first.model, CONFIG.astra);
  assert.equal(second.state, "running");
  assert.equal(second.model, CONFIG.opus);
  observeNative(flow, { details: { jobs: [
    { id: "Helper2", type: "task", status: "completed", output: "mapped" },
  ] } });
  assert.equal(second.state, "completed");
  assert.equal(first.state, "failed");
  assert.deepEqual(reviewEvidence(flow), { rounds: 0, completed: 0, required: true });
  finishFlow(flow, "completed");
  assert.equal(flow.status, "failed");
});

test("an unplanned reviewer agent is an ordinary job, not validated review evidence", () => {
  const solo = createFlow("solo");
  planFlow(solo, { route: "solo", reason: "Direct", waves: [] }, CONFIG);
  startExecution(solo);
  observeNative(solo, progress("Round1", "running"));
  assert.equal(solo.rows.find(item => item.jobIds.includes("Round1")).state, "running");
  assert.equal(reviews(solo).length, 0);
});

test("cancelled runs reject late native completion and preserve prior completed rounds", () => {
  const flow = aris();
  observeNative(flow, done("Round1"));
  observeNative(flow, progress("Round2", "running"));
  finishFlow(flow, "cancelled", "User cancelled");
  const before = structuredClone(flow);
  assert.equal(observeNative(flow, done("Round2")), false);
  assert.deepEqual(flow, before);
  assert.equal(reviews(flow)[0].state, "completed");
  assert.equal(reviews(flow)[1].state, "cancelled");
  assert.equal(row(flow, "final").state, "cancelled");
});

test("restoring a running snapshot marks it interrupted without changing stored evidence", () => {
  const data = aris();
  observeNative(data, progress("Round1", "running"));
  const restored = restoreFlow([{ type: "custom", customType: FLOW, data }]);
  assert.equal(restored.status, "interrupted");
  assert.equal(reviews(restored)[0].state, "interrupted");
  assert.deepEqual(restored.skills, ["research-review"]);
  assert.equal(data.status, "running");
  assert.equal(reviews(data)[0].state, "running");
  assert.equal(restoreFlow([{ type: "custom", customType: FLOW, data: { version: 1, id: "x", rows: [{ id: "router" }] } }]), undefined);
});

test("public summaries drop private thinking and tool arguments instead of displaying reasoning transcripts", () => {
  const summary = publicSummary([
    { type: "thinking", thinking: "PRIVATE REASONING" },
    { type: "toolCall", name: "read", arguments: { path: "PRIVATE PATH" } },
    { type: "text", text: "Public finding\nwith evidence." },
  ]);
  assert.equal(summary, "Public finding with evidence.");
  assert.equal(publicSummary("\x1b]0;unsafe title\x07\x1b[31mPublic\x1b[0m"), "Public");
});

test("long-review previews stay active until full output arrives, without erasing validated results", () => {
  const flow = aris();
  expectNative(flow, REVIEWER_AGENT, "LongReview");
  const preview = jobs("LongReview", "completed", {
    resolvedModelIdentity: CONFIG.astra,
    resultText: '<task-result id="LongReview" agent="aris-reviewer" status="completed">\n<preview full-output="agent://LongReview">\nPublic review prefix\n</preview>\n</task-result>',
  });
  observeNative(flow, preview);
  assert.equal(reviews(flow)[0].state, "running");
  assert.equal(reviewEvidence(flow).completed, 0);
  assert.equal(reviews(flow)[0].output, undefined, "a preview is not the full public result");
  observeNative(flow, jobs("LongReview", "completed", { resolvedModelIdentity: CONFIG.astra, output: "Public review prefix and the complete conclusion." }));
  assert.equal(reviews(flow)[0].state, "completed");
  const summary = reviews(flow)[0].summary;
  assert.equal(reviews(flow)[0].output, "Public review prefix and the complete conclusion.");
  observeNative(flow, preview);
  assert.equal(reviews(flow)[0].state, "completed");
  assert.equal(reviews(flow)[0].summary, summary);
  assert.equal(reviewEvidence(flow).completed, 1);
});

test("a long-review reference never bypasses reviewer identity validation", () => {
  for (const model of [undefined, CONFIG.opus]) {
    const flow = aris();
    expectNative(flow, REVIEWER_AGENT, "WrongModel");
    observeNative(flow, jobs("WrongModel", "completed", {
      resolvedModelIdentity: model,
      resultText: '<task-result id="WrongModel" agent="aris-reviewer" status="completed"><preview full-output="agent://WrongModel">review</preview></task-result>',
    }));
    assert.equal(reviews(flow)[0].state, "failed");
    assert.equal(reviewEvidence(flow).completed, 0);
  }
});

test("worker rows show the pinned Opus model immediately and hang off the brain as siblings of reviewer rounds", () => {
  const flow = aris();
  assert.equal(expectNative(flow, WORKER_AGENT, "Impl1"), true);
  const worker = workers(flow)[0];
  assert.equal(worker.state, "pending");
  assert.equal(worker.agent, "Opus");
  assert.equal(worker.model, CONFIG.opus, "expected model is visible before any lifecycle metadata arrives");
  assert.equal(worker.role, "worker");
  assert.equal(worker.parentId, "final");
  assert.equal(worker.review, undefined);
  observeNative(flow, progress("Round1", "running"));
  assert.equal(reviews(flow)[0].role, "reviewer");
  assert.equal(reviews(flow)[0].parentId, "final");
  assert.equal(workers(flow).length, 1);
  assert.deepEqual(flow.rows.map(item => item.id), ["router", "worker:Impl1", "review:Round1", "final"]);
});

test("a completed worker job counts only with explicit metadata matching the pinned Opus model", () => {
  const flow = aris();
  assert.match(workerProblem(flow, { id: "x" }), /작업자 모델 메타데이터가 없어/);
  assert.match(workerProblem(flow, { id: "x", resolvedModelIdentity: CONFIG.fable }), /작업자 모델 불일치/);
  assert.equal(workerProblem(flow, { id: "x", resolvedModelIdentity: `${CONFIG.opus.toUpperCase()}@2026:medium` }), undefined);
  assert.equal(workerProblem(flow, { id: "x" }, { model: CONFIG.opus }), undefined, "identity learned from an earlier snapshot of the same job");

  // Missing metadata on the result is a failure, never a silent success.
  observeNative(flow, workerDone("NoModel"));
  assert.equal(workers(flow)[0].state, "failed");
  assert.match(workers(flow)[0].summary, /모델 메타데이터/);
  // A later optimistic lifecycle "completed" cannot overturn the rejection.
  observeNative(flow, jobs("NoModel", "completed"));
  assert.equal(workers(flow)[0].state, "failed");

  // Execution on another model is reported as a mismatch, with the observed model kept visible.
  observeNative(flow, workerProgress("WrongModel", "running", { resolvedModelIdentity: CONFIG.astra }));
  assert.equal(workers(flow)[1].state, "running");
  assert.equal(workers(flow)[1].model, CONFIG.astra);
  observeNative(flow, workerDone("WrongModel", { resolvedModelIdentity: CONFIG.astra }));
  assert.equal(workers(flow)[1].state, "failed");
  assert.match(workers(flow)[1].summary, /작업자 모델 불일치/);

  // The pinned model observed while running satisfies a later agent-less completion snapshot.
  observeNative(flow, workerProgress("Good", "running"));
  observeNative(flow, jobs("Good", "completed"));
  assert.equal(workers(flow)[2].state, "running", "status-only completion waits for model/result metadata");
  observeNative(flow, workerProgress("Good", "running", { resolvedModelIdentity: CONFIG.opus, resolvedThinkingLevel: "medium" }));
  assert.equal(workers(flow)[2].model, `${CONFIG.opus} · medium`);
  observeNative(flow, jobs("Good", "completed"));
  assert.equal(workers(flow)[2].state, "running", "even a known model needs a result, not just lifecycle completion");
  observeNative(flow, jobs("Good", "completed", { output: "patched" }));
  assert.equal(workers(flow)[2].state, "completed");
  assert.equal(workers(flow)[2].summary, "patched");

  assert.deepEqual(workerEvidence(flow), { jobs: 3, completed: 1 });
  observeNative(flow, done("Round1"));
  finishFlow(flow, "completed");
  assert.equal(flow.status, "failed", "a rejected worker job fails the run even with a verified review");
});

test("planning and analysis requests never require a worker; delegated workers must still finish", () => {
  const planning = aris("research", ["experiment-plan"], false);
  finishFlow(planning, "completed");
  assert.equal(planning.status, "completed");
  assert.deepEqual(workerEvidence(planning), { jobs: 0, completed: 0 });

  const reviewedOnly = aris();
  observeNative(reviewedOnly, done("Round1"));
  finishFlow(reviewedOnly, "completed");
  assert.equal(reviewedOnly.status, "completed");

  const dispatched = aris();
  expectNative(dispatched, WORKER_AGENT, "Impl1");
  observeNative(dispatched, done("Round1"));
  finishFlow(dispatched, "completed");
  assert.equal(dispatched.status, "incomplete");
  assert.equal(workers(dispatched)[0].state, "skipped");

  // Worker and reviewer are independent branches: the reviewer's completion says nothing about the worker.
  const concurrent = aris();
  observeNative(concurrent, workerProgress("Impl1", "running", { resolvedModelIdentity: CONFIG.opus }));
  observeNative(concurrent, done("Round1"));
  assert.equal(workers(concurrent)[0].state, "running");
  assert.equal(reviews(concurrent)[0].state, "completed");
  finishFlow(concurrent, "completed");
  assert.equal(concurrent.status, "incomplete");
  assert.equal(workers(concurrent)[0].state, "interrupted");
  assert.equal(reviews(concurrent)[0].state, "completed");
});

test("restored legacy snapshots without roles or worker metadata still load", () => {
  const legacy = { version: 1, id: "old", route: "dialogue", status: "completed", reason: "r", note: "", rows: [
    { id: "router", label: "요청 분류", agent: "Terra", model: "m", state: "completed", summary: "", jobIds: [], jobs: [] },
    { id: "review:R1", label: "round", agent: "Astra", model: CONFIG.astra, review: true, state: "completed", summary: "", jobIds: ["R1"], jobs: [{ id: "R1", state: "completed" }] },
    { id: "final", label: "ARIS", agent: "Opus", model: "anthropic/claude-opus-4-6", state: "completed", summary: "", jobIds: [], jobs: [] },
  ] };
  const restored = restoreFlow([{ type: "custom", customType: FLOW, data: legacy }]);
  assert.equal(restored.status, "completed");
  assert.deepEqual(workerEvidence(restored), { jobs: 0, completed: 0 });
  assert.equal(reviewEvidence(restored).completed, 1);
});

test("public details retain multiline request/task/text without private blocks or terminal controls", () => {
  assert.equal(publicText("\x9dPRIVATE TITLE\x9c\x1bPPRIVATE CONTROL\x1b\\Public\nlast"), "Public\nlast");
  const content = [
    { type: "thinking", thinking: "PRIVATE REASONING" },
    { type: "toolCall", name: "read", arguments: { path: "PRIVATE PATH" } },
    { type: "text", text: "\x1b]0;PRIVATE TITLE\x07\x1b[31mPublic\x1b[0m\nline one" },
    { type: "text", text: "line two\r\nlast line" },
  ];
  const text = "Public\nline one\nline two\nlast line";
  assert.equal(publicText(content), text);
  const flow = createFlow("public-input", content);
  planFlow(flow, { route: "solo", reason: "Direct", waves: [] }, CONFIG);
  startExecution(flow);
  expectNative(flow, "scout", "Inspect", { context: content, task: [{ type: "text", text: "Inspect\nall details" }, { type: "thinking", thinking: "PRIVATE TASK" }] });
  assert.equal(flow.request, text);
  assert.equal(row(flow, "native:Inspect").task, `${text}\n\nInspect\nall details`);
  updateStage(flow, "final", "running", content);
  assert.equal(row(flow, "final").output, text);
  assert.equal(row(flow, "final").summary, "Public line one line two last line");
  assert.equal(JSON.stringify(flow).includes("PRIVATE"), false);
});

test("full public results and failures are retained beyond the brief summary limit", () => {
  const output = `${"public detail\n".repeat(80)}last public line`;
  const error = `${"failure detail\n".repeat(80)}last error line`;
  const flow = aris();
  updateStage(flow, "final", "running", output);
  assert.equal(row(flow, "final").output, output);
  assert.equal(row(flow, "final").summary.length, 220);
  observeNative(flow, done("Long", { output, thinking: "PRIVATE REASONING" }));
  assert.equal(reviews(flow)[0].output, output);
  assert.equal(reviews(flow)[0].summary.length, 220);
  expectNative(flow, "scout", "Failed");
  observeNative(flow, { details: { results: [{ id: "Failed", exitCode: 1, output, error }] } });
  assert.equal(row(flow, "native:Failed").output, `${output}\n\n${error}`);
  assert.equal(row(flow, "native:Failed").summary.length, 220);
  assert.equal(JSON.stringify(flow).includes("PRIVATE"), false);
});

test("observed transitions keep immutable start/end times and reject stale evidence", t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const flow = createFlow("timed", "Request");
  assert.equal(flow.startedAt, 1000);
  assert.equal(row(flow, "router").startedAt, 1000);
  now = 1100;
  planFlow(flow, { route: "dialogue", skills: ["research-review"], reason: "Review", waves: [] }, CONFIG, { reviewRequired: true });
  assert.equal(row(flow, "router").finishedAt, 1100);
  now = 1200;
  startExecution(flow);
  now = 1250;
  expectNative(flow, REVIEWER_AGENT, "Timed");
  assert.equal(reviews(flow)[0].startedAt, undefined, "registration is not execution");
  now = 1300;
  observeNative(flow, progress("Timed", "running"));
  now = 1400;
  observeNative(flow, progress("Timed", "running"));
  assert.equal(reviews(flow)[0].startedAt, 1300);
  assert.equal(flow.updatedAt, 1400);
  now = 1500;
  observeNative(flow, done("Timed", { output: "Full\npublic result" }));
  assert.equal(reviews(flow)[0].finishedAt, 1500);
  const settled = structuredClone(flow);
  now = 1600;
  assert.equal(observeNative(flow, progress("Timed", "running", { resolvedModelIdentity: CONFIG.opus, output: "STALE" })), false);
  assert.deepEqual(flow, settled);
  now = 1700;
  finishFlow(flow, "completed");
  assert.equal(flow.finishedAt, 1700);
  assert.equal(row(flow, "final").startedAt, 1200);
  assert.equal(row(flow, "final").finishedAt, 1700);
  const finished = structuredClone(flow);
  now = 9999;
  assert.equal(observeNative(flow, done("Late", { output: "late result" })), false);
  assert.equal(updateStage(flow, "final", "failed", "late failure"), false);
  finishFlow(flow, "failed");
  assert.deepEqual(flow, finished);
});

test("explicit terminal failure escalation keeps the first end time and prior public evidence", t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const flow = aris();
  observeNative(flow, progress("Round1", "running"));
  now = 1100;
  observeNative(flow, done("Round1", { output: "Original\npublic result" }));
  now = 1200;
  observeNative(flow, { details: { results: [{ id: "Round1", exitCode: 1, error: "Actual\nlate failure" }] } });
  assert.equal(reviews(flow)[0].state, "failed");
  assert.equal(reviews(flow)[0].finishedAt, 1100);
  assert.equal(reviews(flow)[0].output, "Original\npublic result\n\nActual\nlate failure");
  const rejected = structuredClone(reviews(flow)[0]);
  now = 1300;
  observeNative(flow, done("Round1", { output: "late optimistic result" }));
  assert.deepEqual(reviews(flow)[0], rejected);
});

test("restored running histories freeze at observed time without inventing legacy fields", t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const flow = aris();
  now = 1100;
  observeNative(flow, progress("Live", "running"));
  now = 1300;
  observeNative(flow, progress("Live", "running"));
  now = 9000;
  const restored = restoreFlow([{ type: "custom", customType: FLOW, data: flow }]);
  assert.equal(restored.finishedAt, 1300);
  assert.equal(restored.updatedAt, 1300);
  assert.equal(reviews(restored)[0].startedAt, 1100);
  assert.equal(reviews(restored)[0].finishedAt, 1300);
  assert.equal(flow.finishedAt, undefined);
  now = 20000;
  assert.deepEqual(restoreFlow([{ type: "custom", customType: FLOW, data: restored }]), restored);

  const legacy = structuredClone(flow);
  delete legacy.request;
  delete legacy.startedAt;
  delete legacy.updatedAt;
  for (const item of legacy.rows) {
    delete item.startedAt;
    delete item.finishedAt;
    delete item.output;
    delete item.task;
  }
  const old = restoreFlow([{ type: "custom", customType: FLOW, data: legacy }]);
  assert.equal(old.status, "interrupted");
  assert.equal(old.request, undefined);
  assert.equal(old.startedAt, undefined);
  assert.equal(old.updatedAt, undefined);
  assert.equal(old.finishedAt, undefined);
  for (const item of old.rows) {
    assert.equal(item.startedAt, undefined);
    assert.equal(item.finishedAt, undefined);
    assert.equal(item.output, undefined);
    assert.equal(item.task, undefined);
  }
});

test("typed native parent ids form a descendant graph while unknown parents are rejected", () => {
  const flow = aris();
  expectNative(flow, "task", "Parent", { task: "Coordinate." });
  observeNative(flow, { details: { progress: [{
    id: "EvalChild", agent: "task", parentId: "native:Parent", task: "Inspect runtime.",
    status: "running", resolvedModelIdentity: CONFIG.astra, publicOutput: "Visible\npartial output",
    thinking: "PRIVATE",
  }] } });
  const child = row(flow, "native:EvalChild");
  assert.equal(child.parentId, "native:Parent");
  assert.equal(child.task, "Inspect runtime.");
  assert.equal(child.output, "Visible\npartial output");
  assert.equal(child.model, CONFIG.astra);
  assert.equal(JSON.stringify(flow).includes("PRIVATE"), false);
  assert.equal(observeNative(flow, { details: { progress: [{
    id: "Orphan", agent: "task", parentId: "missing", status: "running",
  }] } }), false);
  assert.equal(row(flow, "native:Orphan"), undefined);
});

test("a generic lifecycle terminal preserves its finish time and accepts the later full result once", t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const flow = aris();
  expectNative(flow, "scout", "TerminalFirst");
  observeNative(flow, { details: { progress: [{ id: "TerminalFirst", status: "running" }] } });
  now = 1100;
  observeNative(flow, { details: { progress: [{ id: "TerminalFirst", status: "completed" }] } });
  const job = row(flow, "native:TerminalFirst");
  assert.equal(job.state, "completed");
  assert.equal(job.jobs[0].resultReceived, undefined);
  now = 1200;
  const output = `${"Full public detail\n".repeat(80)}FINAL-LINE`;
  observeNative(flow, { details: { results: [{
    id: "TerminalFirst", status: "completed", output, resolvedModelIdentity: CONFIG.astra,
  }] } });
  assert.equal(job.output, output);
  assert.equal(job.jobs[0].resultReceived, true);
  assert.equal(job.finishedAt, 1100);
  const final = structuredClone(job);
  observeNative(flow, { details: { progress: [{ id: "TerminalFirst", status: "running", publicOutput: "STALE" }] } });
  observeNative(flow, { details: { results: [{ id: "TerminalFirst", status: "completed", output: "Duplicate" }] } });
  assert.deepEqual(job, final);
});

test("terminal failure results attach their public body without converting failure to success", () => {
  const flow = aris();
  expectNative(flow, "task", "FailedFirst");
  observeNative(flow, { details: { progress: [{ id: "FailedFirst", status: "failed" }] } });
  observeNative(flow, { details: { results: [{
    id: "FailedFirst", status: "completed", output: "Public result recovered after lifecycle failure.",
  }] } });
  assert.equal(row(flow, "native:FailedFirst").state, "failed");
  assert.equal(row(flow, "native:FailedFirst").output, "Public result recovered after lifecycle failure.");
  assert.equal(row(flow, "native:FailedFirst").jobs[0].resultReceived, true);
});

test("nested owned jobs still require pinned models and reviewer output before becoming evidence", () => {
  const flow = aris();
  expectNative(flow, "task", "Coordinator");
  observeNative(flow, { details: { results: [{
    id: "NestedReview", agent: REVIEWER_AGENT, parentId: "native:Coordinator", status: "completed",
    resolvedModelIdentity: CONFIG.opus, output: "Wrong-model review.",
  }, {
    id: "NestedWorker", agent: WORKER_AGENT, parentId: "native:Coordinator", status: "completed",
    resolvedModelIdentity: CONFIG.astra, output: "Wrong-model work.",
  }] } });
  assert.equal(reviews(flow)[0].parentId, "native:Coordinator");
  assert.equal(workers(flow)[0].parentId, "native:Coordinator");
  assert.equal(reviews(flow)[0].state, "failed");
  assert.equal(workers(flow)[0].state, "failed");
  assert.equal(reviewEvidence(flow).completed, 0);
  assert.equal(workerEvidence(flow).completed, 0);
});
