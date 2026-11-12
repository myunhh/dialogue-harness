import { test } from "node:test";
import assert from "node:assert/strict";
import { collectContext, normalizeConfig, parseRoute, routeRequest, DEFAULT_REVIEW_SKILL, DialogueAbortError, DialogueConfigError } from "../protocol.js";

const response = text => ({ text, stopReason: "stop" });
const catalog = [
	{ name: "research-review", description: "Get a deep critical review of research from a selected reviewer." },
	{ name: "arxiv", description: "Search arXiv  for\n papers." },
	{ name: "experiment-plan", description: "Plan experiments." },
	{ name: "citation-audit", description: "Audit citations." },
	{ name: "paper-write", description: "Write a paper." },
];

test("role selectors are validated and unknown keys are dropped", () => {
	for (const role of ["fable", "astra", "opus"]) {
		assert.throws(() => normalizeConfig({ [role]: "no-provider" }), DialogueConfigError);
	}
	assert.deepEqual(normalizeConfig({ fable: "anthropic/claude-fable-5-2", astra: "openai/gpt-c-astra", opus: "anthropic/claude-opus-5-5", claude: "x" }),
		{ fable: "anthropic/claude-fable-5-2", astra: "openai/gpt-c-astra", opus: "anthropic/claude-opus-5-5" });
});

test("router accepts only explicit decisions; invalid responses never become a default route", async () => {
	assert.deepEqual(parseRoute(JSON.stringify({ route: "solo", reason: " 근거 ", waves: [] }), catalog), { route: "solo", reason: "근거", waves: [] });
	for (const text of ["prose", "null", "[]", '{"route":"maybe","reason":"x"}', '{"route":"aris","skills":["arxiv"],"reason":"x"}',
		'{"route":"solo"}', '{"route":"solo","reason":""}', '{"route":"dialogue","reason":42}', '{"route":"solo","skills":[],"reason":"x"}']) {
		await assert.rejects(routeRequest({ prompt: "request", catalog, runTurn: async () => response(text) }));
	}
	await assert.rejects(routeRequest({ prompt: "request", catalog: [], runTurn: async () => response('{"route":"solo","reason":"x"}') }), /No installed ARIS skills/);
});

test("ARIS routes select installed skills only; dialogue defaults to research-review", () => {
	assert.deepEqual(parseRoute(JSON.stringify({ route: "dialogue", reason: "review", waves: [] }), catalog),
		{ route: "dialogue", reason: "review", skills: [DEFAULT_REVIEW_SKILL], waves: [] });
	const skills = ["arxiv", "experiment-plan"];
	assert.deepEqual(parseRoute(JSON.stringify({ route: "research", skills, reason: " 문헌과 실험 계획 ", waves: [] }), catalog),
		{ route: "research", reason: "문헌과 실험 계획", skills, waves: [] });
	for (const selection of [undefined, [], "arxiv", ["rh-critic-method"], ["../arxiv"], ["arxiv", "arxiv"], [null], [{ name: "arxiv" }],
		["arxiv", "experiment-plan", "citation-audit", "paper-write", "research-review"]]) {
		assert.throws(() => parseRoute(JSON.stringify({ route: "research", skills: selection, reason: "review", waves: [] }), catalog), JSON.stringify(selection));
	}
	assert.throws(() => parseRoute(JSON.stringify({ route: "dialogue", skills: ["dialogue-review"], reason: "review", waves: [] }), catalog));
	assert.throws(() => parseRoute(JSON.stringify({ route: "solo", skills, reason: "review", waves: [] }), catalog));
});

test("routing cancelled during inference cannot return a late successful decision", async () => {
	const abort = new AbortController();
	await assert.rejects(routeRequest({
		prompt: "request", signal: abort.signal, catalog,
		runTurn: async () => {
			abort.abort();
			return response('{"route":"solo","reason":"routine"}');
		},
	}), DialogueAbortError);
});

test("collectContext keeps recent text, drops thinking/tool/state cards, honours compaction and size bound", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "very old question" } },
		{ type: "compaction", summary: "SUMMARY-OF-OLD" },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "newer question" }, { type: "image", data: "x", mimeType: "image/png" }] } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "SECRET-THOUGHT" },
					{ type: "text", text: "visible answer" },
					{ type: "toolCall", name: "bash", arguments: { command: "rm -rf /" } },
				],
			},
		},
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "TOOL-OUTPUT" }] } },
		{ type: "custom_message", customType: "agent-dialogue-status", content: "OLD DIALOGUE CARD" },
		{ type: "custom_message", customType: "memo", content: [{ type: "text", text: "kept note" }] },
		{ type: "model_usage", model: "m", usage: {} },
	];
	const ctx = collectContext(entries);
	assert.match(ctx, /SUMMARY-OF-OLD/);
	assert.doesNotMatch(ctx, /very old question/);
	assert.match(ctx, /User: newer question/);
	assert.match(ctx, /Assistant: visible answer/);
	assert.match(ctx, /Note \(memo\): kept note/);
	assert.doesNotMatch(ctx, /SECRET-THOUGHT/);
	assert.doesNotMatch(ctx, /rm -rf/);
	assert.doesNotMatch(ctx, /TOOL-OUTPUT/);
	assert.doesNotMatch(ctx, /OLD DIALOGUE CARD/);

	// Oversized history: newest kept, oldest dropped, hard bound respected.
	const big = Array.from({ length: 50 }, (_, i) => ({
		type: "message",
		message: { role: "user", content: `msg-${i} ${"x".repeat(900)}` },
	}));
	const bounded = collectContext(big, 5000);
	assert.ok(bounded.length <= 5000);
	assert.match(bounded, /msg-49/);
	assert.doesNotMatch(bounded, /msg-0 /);
	assert.match(bounded, /older item\(s\) omitted/);

	// A single huge entry is clipped, never emitted whole.
	const huge = collectContext([{ type: "message", message: { role: "assistant", content: "y".repeat(20000) } }], 24000);
	assert.ok(huge.length <= 4000);
	assert.match(huge, /\[truncated\]$/);
	assert.equal(collectContext([]), "");
});
