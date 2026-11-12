import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// transport.js statically imports the host-rebound `@oh-my-pi/pi-ai`; outside
// the OMP loader that specifier does not exist. Route it to an in-process stub
// whose stream is scripted per test via `globalThis.__dialogueStreamScript`.
const stubSource = `
export function streamSimple(model, context, options) {
	const script = globalThis.__dialogueStreamScript;
	return script(model, context, options);
}
`;
register(
	`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
	if (specifier === "@oh-my-pi/pi-ai") return { url: "stub:pi-ai", shortCircuit: true };
	return next(specifier, context);
}
export async function load(url, context, next) {
	if (url === "stub:pi-ai") return { format: "module", source: ${JSON.stringify(stubSource)}, shortCircuit: true };
	return next(url, context);
}
`)}`,
	import.meta.url,
);

const { runModelTurn, resolveSpeakerModel, sanitize, DialogueTurnError } = await import(
	"../transport.js"
);

const model = (provider, id, cls, extra = {}) => ({
	provider,
	id,
	reasoning: true,
	thinking: { efforts: ["low", "medium", "high"] },
	identity: { class: cls },
	...extra,
});
const claude = model("anthropic", "claude-opus-4-6", "anthropic");
const gpt = model("openai-codex", "gpt-6-astra", "openai");

function ctxWith(models, { resolverCalls = [] } = {}) {
	const byExact = new Map(models.map(m => [`${m.provider}/${m.id}`.toLowerCase(), m]));
	return {
		models: {
			list: () => models,
			current: () => undefined,
			resolve: spec => byExact.get(spec.toLowerCase()) ?? models.find(m => m.id === spec),
			family: m => (m.identity.class === "unknown" ? m.provider.toLowerCase() : m.identity.class),
		},
		modelRegistry: {
			resolver: (m, sessionId) => {
				resolverCalls.push({ model: m, sessionId });
				return async () => "resolved-key";
			},
		},
		sessionManager: { getSessionId: () => "session-1" },
	};
}

async function* events(list) {
	for (const e of list) yield e;
}
function scripted(list, { onOptions } = {}) {
	globalThis.__dialogueStreamScript = (m, context, options) => {
		onOptions?.(m, context, options);
		const stream = events(list);
		const terminal = list.at(-1);
		stream.result = async () => terminal.message ?? terminal.error;
		return stream;
	};
}
const done = (content, stopReason = "stop", extra = {}) => ({
	type: "done",
	reason: stopReason,
	message: { role: "assistant", content, stopReason, usage: { input: 1, output: 2 }, ...extra },
});

test("speaker family is enforced from catalog identity, never provider substrings", () => {
	const ctx = ctxWith([claude, gpt, model("openai-codex", "claude-ish", "openai")]);
	assert.equal(resolveSpeakerModel(ctx, "opus", "anthropic/claude-opus-4-6"), claude);
	assert.equal(resolveSpeakerModel(ctx, "astra", "openai-codex/gpt-6-astra"), gpt);
	assert.throws(() => resolveSpeakerModel(ctx, "opus", "openai-codex/gpt-6-astra"), /family "openai", expected "anthropic"/);
	assert.throws(() => resolveSpeakerModel(ctx, "astra", "anthropic/claude-opus-4-6"), /family "anthropic", expected "openai"/);
	assert.throws(() => resolveSpeakerModel(ctx, "opus", "openai-codex/claude-ish"), /expected "anthropic"/);
});

test("unavailable or alias-resolved selectors reject instead of substituting", () => {
	const alias = { ...claude, provider: "github-copilot" };
	const ctx = ctxWith([alias]);
	ctx.models.resolve = () => alias; // host alias/bare-id matching picks a different provider
	assert.throws(() => resolveSpeakerModel(ctx, "opus", "anthropic/claude-opus-4-6"), /resolved to "github-copilot\/claude-opus-4-6"/);
	assert.throws(() => resolveSpeakerModel(ctxWith([]), "astra", "openai-codex/gpt-6-astra"), /not an authenticated model/);
	assert.throws(() => resolveSpeakerModel(ctxWith([gpt]), "astra", "   "), /No model configured/);
});

test("named roles reject same-family models from the wrong lineage", () => {
	const luna = model("openai-codex", "gpt-6-luna", "openai");
	const terra = model("openai-codex", "gpt-6.1-terra", "openai");
	const ctx = ctxWith([gpt, luna, terra, claude, model("anthropic", "claude-sonnet-4-6", "anthropic")]);
	assert.throws(() => resolveSpeakerModel(ctx, "astra", "openai-codex/gpt-6-luna"));
	assert.throws(() => resolveSpeakerModel(ctx, "opus", "anthropic/claude-sonnet-4-6"));
	assert.throws(() => resolveSpeakerModel(ctx, "router", "openai-codex/gpt-6-astra"));
});

test("unsupported required reasoning rejects before inference instead of silently downgrading", async () => {
	for (const extra of [{ thinking: { efforts: ["low", "high"] } }, { reasoning: false }, { thinking: undefined }]) {
		const terra = model("openai-codex", "gpt-6.1-terra", "openai", extra);
		let opened = false;
		globalThis.__dialogueStreamScript = () => { opened = true; };
		await assert.rejects(runModelTurn(ctxWith([terra]), {
			speaker: "router", model: "openai-codex/gpt-6.1-terra", reasoning: "xhigh",
			systemPrompt: "routing", messages: [],
		}), error => error instanceof DialogueTurnError && error.kind === "config");
		assert.equal(opened, false);
	}
});

test("only visible text streams to onDelta; thinking and tool events never reach the transcript", async () => {
	const ctx = ctxWith([claude]);
	scripted(
		[
			{ type: "start" },
			{ type: "thinking_delta", contentIndex: 0, delta: "SECRET-THOUGHT" },
			{ type: "text_delta", contentIndex: 1, delta: "Hello " },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"cmd":"rm"}' },
			{ type: "text_delta", contentIndex: 1, delta: "world" },
			done([
				{ type: "thinking", thinking: "SECRET-THOUGHT" },
				{ type: "text", text: "Hello world" },
			]),
		],
	);
	const deltas = [];
	const result = await runModelTurn(ctx, {
		speaker: "opus",
		model: "anthropic/claude-opus-4-6",
		systemPrompt: "SYS",
		messages: [{ role: "user", content: "hi" }],
		onDelta: d => deltas.push(d),
	});
	assert.deepEqual(deltas, ["Hello ", "world"]);
	assert.equal(result.text, "Hello world");
});

test("non-stop outcomes reject honestly with a sanitized detail", async () => {
	const ctx = ctxWith([gpt]);
	const args = { speaker: "astra", model: "openai-codex/gpt-6-astra", systemPrompt: "S", messages: [] };
	const run = () => runModelTurn(ctx, args);

	scripted([{ type: "text_delta", contentIndex: 0, delta: "partial" }, done([{ type: "text", text: "partial" }], "length")]);
	await assert.rejects(run, err => err instanceof DialogueTurnError && err.kind === "length");

	scripted([done([{ type: "toolCall", id: "1", name: "bash", arguments: {} }], "toolUse")]);
	await assert.rejects(run, err => err.kind === "toolUse");

	scripted([
		{
			type: "error",
			reason: "error",
			error: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorStatus: 401,
				errorMessage: "Unauthorized: Bearer sk-ant-abcdefghijklmnop rejected",
			},
		},
	]);
	await assert.rejects(run, err => {
		assert.equal(err.kind, "error");
		assert.match(err.message, /HTTP 401/);
		assert.doesNotMatch(err.message, /sk-ant-abcdefghijklmnop/);
		return true;
	});

	scripted([done([{ type: "text", text: "   " }])]);
	await assert.rejects(run, err => err.kind === "empty");

	globalThis.__dialogueStreamScript = () => {
		throw new Error("fetch failed: token=abcdefghijklmnopqrstuvwxyz");
	};
	await assert.rejects(run, err => {
		assert.equal(err.kind, "error");
		assert.doesNotMatch(err.message, /abcdefghijklmnopqrstuvwxyz/);
		return true;
	});
});

test("caller abort rejects as aborted even when the provider stream ends normally", async () => {
	const ctx = ctxWith([claude]);
	const controller = new AbortController();
	let aborted = false;
	globalThis.__dialogueStreamScript = (m, context, options) => {
		options.signal.addEventListener("abort", () => (aborted = true));
		const stream = (async function* () {
			yield { type: "text_delta", contentIndex: 0, delta: "first" };
			controller.abort();
			yield done([{ type: "text", text: "first" }]);
		})();
		stream.result = async () => done([{ type: "text", text: "first" }]).message;
		return stream;
	};
	const deltas = [];
	await assert.rejects(
		runModelTurn(ctx, {
			speaker: "opus",
			model: "anthropic/claude-opus-4-6",
			systemPrompt: "S",
			messages: [],
			signal: controller.signal,
			onDelta: d => deltas.push(d),
		}),
		err => err instanceof DialogueTurnError && err.kind === "aborted",
	);
	assert.equal(aborted, true, "abort propagates to the provider signal");
	assert.deepEqual(deltas, ["first"]);

	const pre = new AbortController();
	pre.abort();
	let called = false;
	globalThis.__dialogueStreamScript = () => {
		called = true;
	};
	await assert.rejects(
		runModelTurn(ctx, { speaker: "opus", model: "anthropic/claude-opus-4-6", systemPrompt: "S", messages: [], signal: pre.signal }),
		err => err.kind === "aborted",
	);
	assert.equal(called, false, "pre-aborted turns never open a request");
});

test("sanitize redacts bearer, key and JWT shapes and caps length", () => {
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh12";
	const out = sanitize(`Authorization: Bearer abc.def-ghi_jkl ${jwt} apiKey=supersecretvalue ok`);
	assert.doesNotMatch(out, /abc\.def-ghi_jkl|eyJhbGci|supersecretvalue/);
	assert.match(out, /\[redacted\]/);
	assert.ok(sanitize("x".repeat(1000)).length <= 401);
});
