import { ARIS_ROUTES, ROUTER } from "./protocol.js";
import { REVIEWER_AGENT, WORKER_AGENT, reviewOutput, reviewReference } from "./aris-runtime.js";
import { unfinishedWaves } from "./waves.js";

export const FLOW = "agent-dialogue-flow";
const INITIAL_NOTE = "공개 실행 기록 · /dialogue flow 상세 · Esc 중단";
const terminal = state => ["completed", "failed", "cancelled", "skipped", "interrupted"].includes(state);
/**
 * Row roles: router (Terra) · solo (Astra alone) · brain (Fable: analysis, planning, synthesis, final answer)
 * · worker (Opus: bounded execution delegated by the brain) · reviewer (Astra: independent review round).
 * Other native jobs keep their observed agent and carry no role.
 */
const makeRow = (id, label, agent, model, role, parentId) =>
  ({ id, label, agent, model, role, parentId, state: "pending", summary: "", jobIds: [], jobs: [] });

/** Keep public text only; terminal controls and private/tool blocks never enter stored details. */
export function publicText(content) {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
  return text.replace(/(?:(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[PX^_]|\x90|\x98|\x9e|\x9f)[\s\S]*?(?:\x1b\\|\x9c|$)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-Z\\-_])/g, "")
    .replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, " ");
}

export function publicSummary(content) {
  const text = publicText(content).replace(/\s+/g, " ").trim();
  return text.length > 220 ? `${text.slice(0, 219)}…` : text;
}

const timestamp = value => typeof value === "number" && Number.isFinite(value);
function transition(row, state, at) {
  if (row.state === state) return false;
  if (state === "running" && row.startedAt === undefined && timestamp(at)) row.startedAt = at;
  if (terminal(state) && !terminal(row.state) && row.finishedAt === undefined && timestamp(at)) row.finishedAt = at;
  row.state = state;
  return true;
}

export function createFlow(id, request = "") {
  const at = Date.now();
  const router = makeRow("router", "요청 분류", "Terra", `${ROUTER.model} · ${ROUTER.reasoning}`, "router");
  transition(router, "running", at);
  return { version: 1, id, request: publicText(request), startedAt: at, updatedAt: at,
    route: "pending", status: "running", reason: "요청에 맞는 실행 경로를 선택합니다.",
    rows: [router], note: INITIAL_NOTE };
}

const modelBase = selector => String(selector ?? "").split("@")[0].split(":")[0].trim().toLowerCase();
const reviewRows = flow => flow.rows.filter(row => row.review === true);
const workerRows = flow => flow.rows.filter(row => row.worker === true);

/**
 * solo: Astra performs the work. dialogue/research: Fable is the brain — it follows the loaded ARIS
 * skills, plans and writes the final answer; bounded execution it chooses to delegate runs as native
 * aris-worker jobs pinned to Opus, and every native aris-reviewer call becomes its own observed round
 * pinned to Astra. A worker is never required: planning/analysis requests finish without one.
 */
export function planFlow(flow, decision, config, options = {}) {
  flow.route = decision.route;
  flow.reason = decision.reason;
  flow.waves = structuredClone(decision.waves);
  flow.activeWave = 0;
  flow.rows[0].wave = 0;
  updateStage(flow, "router", "completed", decision.reason);
  if (ARIS_ROUTES.includes(decision.route)) {
    flow.skills = [...decision.skills];
    flow.worker = { agent: WORKER_AGENT, model: config.opus };
    flow.reviewer = { agent: REVIEWER_AGENT, model: config.astra };
    flow.reviewRequired = options.reviewRequired === true;
    flow.rows.push(makeRow("final", `ARIS 분석·계획·답변 · ${flow.skills.join(", ")}`, "Fable", config.fable, "brain", "router"));
  } else {
    flow.rows.push(makeRow("final", "직접 작업·답변", "Astra", config.astra, "solo", "router"));
  }
  flow.rows.find(row => row.id === "final").wave = 1;
}

export function updateStage(flow, id, state, summary) {
  const row = flow.rows.find(item => item.id === id);
  if (!row || flow.status !== "running" || terminal(row.state)) return false;
  const at = Date.now();
  transition(row, state, at);
  if (summary !== undefined) {
    row.output = publicText(summary);
    row.summary = publicSummary(summary);
  }
  flow.updatedAt = at;
  return true;
}

export function startExecution(flow) {
  updateStage(flow, "final", "running");
}

/** Pre-register a named native job (e.g. an aris-worker/aris-reviewer task name) so later agent-less wait snapshots correlate. */
export function expectNative(flow, agent, id, task = {}) {
  if (flow.status !== "running" || typeof id !== "string" || !id) return false;
  const row = correlate(flow, { id, agent, parentId: task.parentId });
  if (!row || row.jobIds.includes(id)) return false;
  const input = [publicText(task?.context), publicText(task?.task)].filter(text => text.trim()).join("\n\n");
  if (input) row.task = input;
  row.jobs.push({ id, state: "pending" });
  row.jobIds.push(id);
  flow.updatedAt = Date.now();
  return true;
}

/** Bound native envelopes are public tool results, not assistant claims. */
export function nativeOutput(item) {
  const inline = reviewOutput(item);
  if (inline) return inline;
  const body = nativeEnvelope(item);
  if (!body || /<preview\b/.test(body)) return "";
  return /^\s*(?:<meta\b[^>]*\/>\s*)?<output>\n?([\s\S]*?)\n?<\/output>\s*$/.exec(body)?.[1]?.trim() ?? "";
}

function nativeEnvelope(item) {
  const match = /^\s*<task-result\b([^>]*)>([\s\S]*)<\/task-result>/.exec(item?.resultText ?? "");
  if (!match || !item.agent) return;
  const attribute = name => new RegExp(`\\b${name}="([^"]*)"`).exec(match[1])?.[1];
  if (attribute("id") !== item.id || attribute("agent") !== item.agent || attribute("status") !== "completed") return;
  return match[2];
}

export function nativeReference(item) {
  if (nativeOutput(item)) return;
  const body = nativeEnvelope(item);
  const preview = body && /^\s*(?:<meta\b[^>]*\/>\s*)?<preview\s+full-output="agent:\/\/([^"]*)">\n?([\s\S]*?)\n?<\/preview>\s*$/.exec(body);
  return preview && preview[1] === item.id ? { id: item.id, preview: preview[2] } : undefined;
}

function resultSummary(result) {
  const structured = result.structuredOutput ?? result.structured;
  if (structured && structured.status !== "valid") return "";
  if (typeof structured?.data?.summary === "string") return publicSummary(structured.data.summary);
  const output = nativeOutput(result);
  if (typeof output !== "string") return "";
  try {
    const parsed = JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return typeof parsed?.summary === "string" ? publicSummary(parsed.summary) : "구조화 결과 수신 · native 작업 카드에서 원문 확인";
  } catch {
    return publicSummary(output);
  }
}

function nativeState(record, isResult) {
  if (record.aborted || record.status === "aborted" || record.status === "cancelled") return "cancelled";
  if (record.error || record.status === "failed" || (isResult && typeof record.exitCode === "number" && record.exitCode !== 0)) return "failed";
  if (record.status === "completed" || (isResult && record.exitCode === 0)) return "completed";
  if (record.status === "running") return "running";
  return "pending";
}

const resolvedIdentity = item => item.resolvedModelIdentity || item.resolvedModel;

function pinnedModelProblem(identity, pinned, who) {
  if (typeof identity !== "string" || !identity.trim()) return `${who} 모델 메타데이터가 없어 인정하지 않음`;
  if (modelBase(identity) !== modelBase(pinned)) return `${who} 모델 불일치: ${publicSummary(identity)} ≠ ${pinned}`;
  return undefined;
}

const reviewModelProblem = (flow, item) => pinnedModelProblem(resolvedIdentity(item), flow.reviewer?.model, "검토자");

/**
 * Why a "completed" worker job is not worker execution: the resolved model must be explicit and
 * exactly the pinned Opus selector. The identity may come from the result itself or from an
 * earlier lifecycle snapshot of the same job; a job whose model was never observed is rejected
 * rather than silently counted as execution on some other model.
 */
export function workerProblem(flow, item, job) {
  return pinnedModelProblem(resolvedIdentity(item) || job?.model, flow.worker?.model, "작업자");
}

/**
 * Why a "completed" reviewer job is not reviewer evidence: the resolved model must be explicit and
 * exactly the pinned Astra selector, and the public output must be nonempty. Silence never acquits.
 */
export function reviewProblem(flow, item) {
  const modelProblem = reviewModelProblem(flow, item);
  if (modelProblem) return modelProblem;
  if (!reviewOutput(item)) return "검토자 결과 본문이 비어 있어 검토로 인정하지 않음";
  return undefined;
}

/**
 * Locate the row a native record belongs to. Each delegated job has its own node.
 * The observer supplies parentId as an actual flow row id from host tool/session
 * identity; absent metadata retains the direct executor relationship.
 */
function correlate(flow, item) {
  const known = flow.rows.find(candidate => candidate.jobIds.includes(item.id));
  if (known) return known;
  if (item.parentId !== undefined && !flow.rows.some(row => row.id === item.parentId)) return undefined;
  if (typeof item.agent !== "string" || !item.agent) return undefined;
  const parentId = item.parentId ?? "final";
  const final = flow.rows.findIndex(candidate => candidate.id === "final");
  const insert = row => {
    const index = flow.activeWave ?? 0;
    const wave = flow.waves?.[index];
    if (wave) Object.assign(row, { wave: index + 2, waveId: wave.id });
    flow.rows.splice(final < 0 ? flow.rows.length : final, 0, row);
    return row;
  };
  if (flow.reviewer && item.agent === flow.reviewer.agent) {
    const row = makeRow(`review:${item.id}`, `${REVIEWER_AGENT} 검토 라운드 ${reviewRows(flow).length + 1}`, "Astra", flow.reviewer.model, "reviewer", parentId);
    row.review = true;
    return insert(row);
  }
  if (flow.worker && item.agent === flow.worker.agent) {
    const row = makeRow(`worker:${item.id}`, `${WORKER_AGENT} 실행 ${workerRows(flow).length + 1}`, "Opus", flow.worker.model, "worker", parentId);
    row.worker = true;
    return insert(row);
  }
  return insert(makeRow(`native:${item.id}`, item.id, item.agent, "모델 확인 중", undefined, parentId));
}

/** Consume only public result/error text and typed lifecycle metadata, never transcripts or thinking. */
export function observeNative(flow, result) {
  if (flow.status !== "running" || !result?.details) return false;
  const details = result.details;
  const at = Date.now();
  let observed = false;
  let changed = false;
  function record(item, isResult = false) {
    if (!item || typeof item.id !== "string" || !item.id || (item.type && item.type !== "task")) return;
    // wait snapshots contain no agent name: only scheduled names or previously associated job ids count.
    const row = correlate(flow, item);
    if (!row) return;
    let job = row.jobs.find(candidate => candidate.id === item.id);
    if (!job) {
      job = { id: item.id, state: "pending" };
      row.jobs.push(job);
      row.jobIds.push(item.id);
      changed = true;
    }
    const hasResult = isResult || ["output", "resultText", "structuredOutput", "structured"].some(key => key in item);
    let state = nativeState(item, hasResult);
    // Lifecycle termination is not the published result. One later result may fill
    // its public body, but rejected evidence and cancelled jobs cannot be acquitted.
    const completingBody = terminal(job.state) && hasResult && !job.resultReceived;
    if (terminal(job.state) && !completingBody &&
      !(job.state === "completed" && ["failed", "cancelled"].includes(state))) return;
    if (terminal(row.state) && !terminal(job.state)) return;
    const task = publicText(item.task);
    if (task && !row.task) { row.task = task; changed = true; }
    const live = publicText(item.publicOutput);
    if (live && !job.resultReceived && row.output !== live) { row.output = live; changed = true; }
    const identity = resolvedIdentity(item);
    const saveIdentity = () => {
      if (typeof identity === "string" && identity.trim() && job.model !== identity) { job.model = identity; changed = true; }
      if (typeof item.resolvedThinkingLevel === "string" && job.thinkingLevel !== item.resolvedThinkingLevel) {
        job.thinkingLevel = item.resolvedThinkingLevel; changed = true;
      }
    };
    // Lifecycle completion can precede the actual result; retain its model but do not judge early.
    if ((row.review || row.worker) && state === "completed" && !hasResult &&
      !("output" in item) && !("structuredOutput" in item) && !("structured" in item) && !("resultText" in item)) {
      if (!terminal(job.state)) { saveIdentity(); observed = true; }
      return;
    }
    const reference = state === "completed" ? (row.review ? reviewReference(item) : nativeReference(item)) : undefined;
    const problem = state !== "completed" ? undefined
      : row.review ? (reference ? reviewModelProblem(flow, item) : reviewProblem(flow, item))
      : row.worker ? workerProblem(flow, item, job) : undefined;
    if (problem) state = "failed";
    else if (reference) state = "running";
    const terminalFailure = job.state === "completed" && ["failed", "cancelled"].includes(state);
    if (terminal(job.state) && !terminalFailure && !completingBody) return;
    if (completingBody && job.state !== "completed") state = job.state;
    if (hasResult && !reference && !item.truncated && terminal(state) && !job.resultReceived) { job.resultReceived = true; changed = true; }
    observed = true;
    saveIdentity();
    const advance = !terminal(job.state) && (state !== "pending" || job.state === "pending");
    if ((advance || terminalFailure) && job.state !== state) { job.state = state; changed = true; }
    if (typeof identity === "string") {
      const model = item.resolvedModelIdentity && item.resolvedThinkingLevel ? `${identity} · ${item.resolvedThinkingLevel}` : identity;
      if (row.model !== model) { row.model = model; changed = true; }
    }
    const summary = problem ? problem : reference && state === "running" ? `검토 원문 수신 중 · agent://${reference.id}`
      : state === "completed" ? resultSummary(item)
      : state === "failed" ? publicSummary(item.error || item.errorText || "native 호출 실패")
      : state === "cancelled" ? publicSummary(item.abortReason || "작업 취소됨") : undefined;
    if (summary && row.summary !== summary) { row.summary = summary; changed = true; }
    const output = publicText(row.review ? reviewOutput(item) : nativeOutput(item));
    const error = state === "failed" ? publicText(item.error || item.errorText)
      : state === "cancelled" ? publicText(item.abortReason) : "";
    const full = [output, error].filter(text => text.trim()).join("\n\n");
    if (full && (terminal(job.state) || state === "completed")) {
      const evidence = terminalFailure && !output && row.output ? `${row.output}\n\n${full}` : full;
      if (row.output !== evidence) { row.output = evidence; changed = true; }
    }
    const states = row.jobs.map(candidate => candidate.state);
    const aggregate = states.includes("running") ? "running" : states.includes("pending") ? "pending"
      : states.includes("failed") ? "failed" : states.includes("cancelled") ? "cancelled" : "completed";
    if (transition(row, aggregate, at)) changed = true;
  }
  for (const item of Array.isArray(details.progress) ? details.progress : []) record(item);
  for (const item of Array.isArray(details.results) ? details.results : []) record(item, true);
  if (details.evalResult && typeof details.evalResult === "object") record(details.evalResult, true);
  for (const item of Array.isArray(details.jobs) ? details.jobs : []) record(item);
  if (observed && flow.updatedAt !== at) { flow.updatedAt = at; changed = true; }
  return changed;
}

/** Reviewer evidence state for ARIS routes: completed rounds that passed model/output validation. */
export function reviewEvidence(flow) {
  const rows = reviewRows(flow);
  return { rounds: rows.length, completed: rows.filter(row => row.state === "completed").length,
    required: flow.reviewRequired === true };
}

/** Worker execution state: delegated jobs and those completed on the pinned Opus model. Never required. */
export function workerEvidence(flow) {
  const rows = workerRows(flow);
  return { jobs: rows.length, completed: rows.filter(row => row.state === "completed").length };
}

export function finishFlow(flow, status, note = "") {
  endFlow(flow, status, note, Date.now());
}

function endFlow(flow, status, note, at) {
  if (flow.status !== "running") return;
  if (status === "completed") {
    const priorRows = flow.rows.filter(row => row.id !== "final");
    const evidence = reviewEvidence(flow);
    if (priorRows.some(row => row.state === "failed")) status = "failed";
    else if (priorRows.some(row => row.state === "cancelled")) status = "cancelled";
    else if (priorRows.some(row => row.state !== "completed")) status = "incomplete";
    else if (evidence.required && evidence.completed === 0) {
      status = "incomplete";
      note ||= "선택한 스킬은 검토자 라운드가 필요하지만 aris-reviewer 완료가 관측되지 않았습니다.";
    } else if (unfinishedWaves(flow).length) {
      status = "incomplete";
      note ||= `Terra Wave 실행·공개 결과 미완료: ${unfinishedWaves(flow).join(", ")}`;
    }
    const final = flow.rows.find(row => row.id === "final");
    if (final && !terminal(final.state)) transition(final, "completed", at);
  }
  const running = flow.rows.filter(row => row.state === "running");
  for (const row of flow.rows) {
    if (row.state === "pending") { transition(row, "skipped", at); row.summary ||= "선택됐지만 실행 완료가 관측되지 않음"; }
    else if (row.state === "running") {
      transition(row, status === "cancelled" ? "cancelled" : status === "failed" && running.length === 1 ? "failed" : "interrupted", at);
    }
  }
  flow.status = status;
  if (timestamp(at)) {
    flow.updatedAt = at;
    flow.finishedAt ??= at;
  }
  // Execution ending never implies reviewer acceptance; the note carries the observed evidence only.
  flow.note = publicSummary(note || (status === "completed"
    ? (flow.reviewer ? `실행 종료 · 검토자 라운드 ${reviewEvidence(flow).completed}회 완료 관측${flow.worker ? ` · 작업자 실행 ${workerEvidence(flow).completed}건` : ""}`
      : "공개 결과 요약 · /dialogue flow 상세")
    : status === "incomplete" ? "호출되지 않았거나 완료 신호가 없는 단계가 있습니다." : "실행 중단 · 완료된 단계만 보존"));
}

export function restoreFlow(entries) {
  const data = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === FLOW && entry.data?.version === 1)?.data;
  if (!data || typeof data.id !== "string" || !Array.isArray(data.rows) ||
    !data.rows.every(row => typeof row.id === "string" && typeof row.state === "string" && Array.isArray(row.jobIds) && Array.isArray(row.jobs))) return undefined;
  const flow = structuredClone(data);
  if (flow.status === "running") {
    const observations = [flow.updatedAt, flow.startedAt, ...flow.rows.flatMap(row => [row.startedAt, row.finishedAt])].filter(timestamp);
    const at = observations.length ? Math.max(...observations) : undefined;
    endFlow(flow, "interrupted", "이전 실행 기록입니다. 현재 작업의 생존·완료를 확인한 상태가 아닙니다.", at);
  }
  return flow;
}

export function flowText(flow) {
  const labels = { pending: "분류 중", solo: "일반 작업", dialogue: "ARIS 검토", research: "ARIS 연구" };
  return [`Agent Flow · ${labels[flow.route]} · ${flow.status}`, flow.reason, flow.skills?.length ? `skills: ${flow.skills.join(", ")}` : "",
    ...(flow.waves ?? []).map((wave, index) => `Wave ${index + 2} · ${wave.title} · ${wave.goal}`),
    ...flow.rows.map(row => `${row.parentId ? "  └ " : ""}${Number.isInteger(row.wave) ? `W${row.wave} ` : ""}[${row.state}] ${row.label} — ${row.agent}${row.role ? ` (${row.role})` : ""} · ${row.model}${row.summary ? `\n  ${row.summary}` : ""}${row.jobIds.length ? ` · ${row.jobIds.join(", ")}` : ""}`), flow.note].filter(Boolean);
}
