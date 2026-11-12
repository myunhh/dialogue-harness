import test from "node:test";
import assert from "node:assert/strict";
import { parseWaves, prepareWaveCall, waveComplete } from "../waves.js";
import { createFlow, expectNative, finishFlow, observeNative, planFlow } from "../flow.js";
import { parseRoute, DEFAULTS } from "../protocol.js";

const stages = () => [
  { id: "Inspect", title: "Inspect", goal: "Inspect the requested inputs", parallel: 2 },
  { id: "Check", title: "Check", goal: "Check the collected evidence", parallel: 1 },
  { id: "Report", title: "Report", goal: "Produce the requested artifact", parallel: 1 },
];
function run(waves = stages()) {
  const flow = createFlow("waves");
  planFlow(flow, { route: "solo", reason: "Scoped work", waves }, DEFAULTS);
  return flow;
}
function admit(flow, names) {
  const prepared = prepareWaveCall(flow, { tasks: names.map(name => ({ name, task: "Read the assigned input only." })) });
  flow.activeWave = prepared.index;
  flow.nextWaveTask = prepared.nextName;
  for (const task of prepared.input.tasks) expectNative(flow, "task", task.name, { ...task, parentId: "final" });
  return prepared.input.tasks;
}
function complete(flow, id, more = {}) {
  observeNative(flow, { details: { results: [{ id, status: "completed", output: `Evidence from ${id}`, ...more }] } });
}

test("Terra requires a bounded, unambiguous execution-stage plan", () => {
  const catalog = [{ name: "research-review" }];
  assert.throws(() => parseRoute('{"route":"solo","reason":"work"}', catalog), /waves/);
  for (const waves of [null, {}, [null], [{ ...stages()[0], id: ["Inspect"] }],
    [stages()[0], stages()[0]], [{ ...stages()[0], parallel: 0 }], [{ ...stages()[0], parallel: 5 }],
    [{ ...stages()[0], goal: " " }], Array.from({ length: 13 }, (_, i) => ({ ...stages()[0], id: `Stage${i}` }))]) {
    assert.throws(() => parseWaves(waves), JSON.stringify(waves));
  }
  assert.equal(parseRoute(JSON.stringify({ route: "solo", reason: "work", waves: stages() }), catalog).waves.length, 3);
});

test("a stage barrier requires every full successful result, not lifecycle completion", () => {
  const flow = run();
  admit(flow, ["Inspect__First", "Inspect__Second"]);
  assert.throws(() => admit(flow, ["Check__Early"]), /finish successfully/);
  assert.throws(() => admit(flow, ["Inspect__Third"]), /concurrent/);
  complete(flow, "Inspect__First");
  observeNative(flow, { details: { progress: [{ id: "Inspect__Second", status: "completed" }] } });
  assert.equal(waveComplete(flow, 0), false);
  assert.throws(() => admit(flow, ["Check__StillEarly"]), /full public results/);
  complete(flow, "Inspect__Second");
  admit(flow, ["Check__Now"]);
  const check = flow.rows.find(row => row.jobIds.includes("Check__Now"));
  assert.equal(check.wave, 3);
  assert.equal(check.parentId, "final", "a later execution Wave does not invent a nested parent");
  assert.throws(() => admit(flow, ["Inspect__Late"]), /closed/);
});

test("mixed/skipped/unknown stages and duplicate names cannot partially advance a plan", () => {
  const flow = run();
  for (const names of [["Inspect__A", "Check__B"], ["Report__Skip"], ["Unknown__A"], ["Inspect__A", "Inspect__A"]]) {
    assert.throws(() => admit(flow, names));
    assert.equal(flow.activeWave, 0);
    assert.deepEqual(flow.rows.flatMap(row => row.jobIds), []);
  }
  admit(flow, ["Inspect__A"]);
  complete(flow, "Inspect__A");
  assert.throws(() => admit(flow, ["Inspect__A"]), /already used/);
});

test("failure, cancellation and missing public output do not unlock later stages", () => {
  for (const more of [{ status: "failed", error: "failed" }, { status: "cancelled" }, { output: "" }]) {
    const flow = run();
    admit(flow, ["Inspect__A"]);
    complete(flow, "Inspect__A", more);
    assert.equal(waveComplete(flow, 0), false);
    assert.throws(() => admit(flow, ["Check__A"]), /finish successfully/);
  }
});

test("repeated rounds stay in their stage and all planned stages must run before completion", () => {
  const flow = run();
  admit(flow, ["Inspect__Round1"]);
  complete(flow, "Inspect__Round1");
  admit(flow, ["Inspect__Round2"]);
  complete(flow, "Inspect__Round2");
  admit(flow, ["Check__Round1"]);
  complete(flow, "Check__Round1");
  const premature = structuredClone(flow);
  finishFlow(premature, "completed");
  assert.equal(premature.status, "incomplete");
  admit(flow, ["Report__Artifact"]);
  complete(flow, "Report__Artifact");
  finishFlow(flow, "completed");
  assert.equal(flow.status, "completed");
});

test("main-only plans cannot start delegates, and generated names reserve real stage capacity", () => {
  const direct = run([]);
  assert.throws(() => admit(direct, ["Extra"]), /without delegated Waves/);
  finishFlow(direct, "completed");
  assert.equal(direct.status, "completed");
  const flow = run();
  const first = admit(flow, [undefined])[0].name;
  const second = admit(flow, [undefined])[0].name;
  assert.notEqual(first, second);
  assert.throws(() => admit(flow, [undefined]), /concurrent/);
});
