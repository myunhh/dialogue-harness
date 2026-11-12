// Model transport for fixed Terra routing; execution uses the host's native sessions.
//
// Runs one consultant turn through the host's own `@oh-my-pi/pi-ai` streaming
// entrypoint (the OMP extension loader rebinds that specifier to the running
// host build) and the session's ModelRegistry auth. Nothing here reads
// credential files or copies tokens: `ctx.modelRegistry.resolver(model, sessionId)`
// hands streamSimple an ApiKeyResolver that mints/refreshes the key inside the
// host's auth-retry policy.
import { streamSimple } from "@oh-my-pi/pi-ai";
import { matchesRole, ROLES } from "./protocol.js";

/** Per-turn wall-clock ceiling. Reasoning models stall rarely but expensively. */
export const TURN_DEADLINE_MS = 120_000;
/**
 * Output ceiling requested per turn. Honored by Anthropic/OpenAI-compatible
 * transports; the Codex backend rejects caller-supplied output caps and the
 * host strips `max_output_tokens` for `openai-codex`, so it is a request, not
 * a guarantee.
 */
export const TURN_MAX_TOKENS = 2000;
export const TURN_REASONING = "low";

/**
 * Resolve the exact selector to an authenticated host model and enforce the
 * speaker's family. Never substitutes: a selector that does not resolve, or
 * resolves to a different provider/id than written, is an error.
 */
export function resolveSpeakerModel(ctx, speaker, selector) {
	const role = ROLES[speaker];
	if (!role) throw new Error(`Unknown dialogue speaker "${speaker}"`);
	if (typeof selector !== "string" || selector.trim() === "") {
		throw new Error(`No model configured for ${speaker}`);
	}
	const spec = selector.trim();
	const model = ctx.models.resolve(spec);
	if (!model) {
		throw new Error(`Model "${spec}" for ${speaker} is not an authenticated model in this session (see /model)`);
	}
	// `resolve` accepts bare ids and aliases; the dialogue requires the exact
	// provider/id so a different provider's same-named model is never picked up.
	const exact = `${model.provider}/${model.id}`;
	if (spec.includes("/") && exact.toLowerCase() !== spec.toLowerCase()) {
		throw new Error(`Model "${spec}" for ${speaker} resolved to "${exact}"; configure the exact selector`);
	}
	const family = ctx.models.family(model);
	if (!matchesRole(speaker, model, family)) {
		throw new Error(`Model "${exact}" is not valid for ${role.label}: family "${family}", expected "${role.family}" and the named role's model lineage`);
	}
	return model;
}

/**
 * Run one dialogue turn. Resolves on `{text, usage, stopReason}` only when the
 * provider finished with `stop` and produced visible text; every other outcome
 * (abort, deadline, provider error, truncation, tool-use attempt, empty text)
 * rejects so the protocol can never hand off a fabricated or partial result.
 */
export async function runModelTurn(ctx, { speaker, model, reasoning, systemPrompt, messages, signal, onDelta }) {
	const resolved = resolveSpeakerModel(ctx, speaker, model);
	const label = `${resolved.provider}/${resolved.id}`;
	const effort = turnEffort(resolved, reasoning);
	const sessionId = ctx.sessionManager?.getSessionId?.();
	const auth = createAuth(ctx.modelRegistry, resolved, sessionId);

	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new DialogueTurnError(`${label} exceeded ${TURN_DEADLINE_MS / 1000}s`, "timeout")), TURN_DEADLINE_MS);
	const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;

	try {
		if (combined.aborted) throw abortError(combined, label);
		const stream = streamSimple(
			resolved,
			{ systemPrompt: [systemPrompt], messages },
			{
				apiKey: auth,
				sessionId,
				signal: combined,
				maxTokens: TURN_MAX_TOKENS,
				reasoning: effort,
				hideThinkingSummary: true,
			},
		);
		let final;
		for await (const event of stream) {
			if (combined.aborted) throw abortError(combined, label);
			// Only visible text reaches the transcript; thinking/tool events are dropped.
			if (event.type === "text_delta") {
				if (event.delta) {
					onDelta?.(event.delta);
				}
			} else if (event.type === "done") {
				final = event.message;
			} else if (event.type === "error") {
				final = event.error;
			}
		}
		if (!final) final = await stream.result();
		if (combined.aborted) throw abortError(combined, label);
		if (final.stopReason !== "stop") throw stopError(final, label);
		const visible = final.content
			.filter(block => block.type === "text" && typeof block.text === "string")
			.map(block => block.text)
			.join("");
		if (visible.trim() === "") throw new DialogueTurnError(`${label} returned no visible text`, "empty");
		return { text: visible, usage: final.usage, stopReason: final.stopReason };
	} catch (error) {
		if (combined.aborted && !(error instanceof DialogueTurnError)) throw abortError(combined, label);
		if (error instanceof DialogueTurnError) throw error;
		throw new DialogueTurnError(`${label} request failed: ${sanitize(messageOf(error))}`, "error", { cause: error });
	} finally {
		deadline.abort();
		clearTimeout(timer);
	}
}

/**
 * An explicit effort is a requirement, never a hint to silently downgrade.
 * Other consultant calls retain the lowest supported effort.
 */
export function turnEffort(model, requested) {
	const efforts = model.thinking?.efforts;
	if (requested !== undefined) {
		if (!model.reasoning || !Array.isArray(efforts) || !efforts.includes(requested)) {
			throw new DialogueTurnError(`${model.provider}/${model.id} does not support required reasoning "${requested}"`, "config");
		}
		return requested;
	}
	if (!model.reasoning) return undefined;
	if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
	return efforts.includes(TURN_REASONING) ? TURN_REASONING : efforts[0];
}

export class DialogueTurnError extends Error {
	/** @param {"aborted"|"timeout"|"error"|"length"|"toolUse"|"empty"|"config"} kind */
	constructor(message, kind, options) {
		super(message, options);
		this.name = "DialogueTurnError";
		this.kind = kind;
	}
}

function createAuth(registry, model, sessionId) {
	if (typeof registry?.resolver !== "function") {
		throw new DialogueTurnError("OMP >=18.15.0 with a model credential resolver is required", "error");
	}
	return registry.resolver(model, sessionId);
}

function abortError(signal, label) {
	const reason = signal.reason;
	if (reason instanceof DialogueTurnError) return reason;
	return new DialogueTurnError(`${label} turn aborted`, "aborted", reason instanceof Error ? { cause: reason } : undefined);
}

function stopError(message, label) {
	switch (message.stopReason) {
		case "aborted":
			return new DialogueTurnError(`${label} turn aborted`, "aborted");
		case "length":
			return new DialogueTurnError(`${label} hit the output limit before finishing`, "length");
		case "toolUse":
			return new DialogueTurnError(`${label} attempted a tool call; consultants have no tools`, "toolUse");
		default: {
			const status = typeof message.errorStatus === "number" ? ` (HTTP ${message.errorStatus})` : "";
			const detail = sanitize(message.errorMessage || "provider error");
			return new DialogueTurnError(`${label} failed${status}: ${detail}`, "error");
		}
	}
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

const SECRET_PATTERNS = [
	/\b(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g,
	/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}/g,
	/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
	/\b(?:api[_-]?key|token|authorization)\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
];

/** Strip bearer/API-key shaped substrings and cap length before surfacing provider text. */
export function sanitize(detail) {
	let out = String(detail ?? "");
	for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
	out = out.replace(/\s+/g, " ").trim();
	return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}
