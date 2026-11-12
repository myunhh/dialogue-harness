// ARIS execution policy for the OMP adaptation: pure text/policy helpers, no SDK,
// filesystem, network or UI access. The host loads skills, runs Fable as the main brain,
// and observes native aris-worker (Opus) and aris-reviewer (Astra) jobs through task metadata.
import { ROLES } from "./protocol.js";

export const REVIEWER_AGENT = "aris-reviewer";
export const WORKER_AGENT = "aris-worker";
/** Native agents this extension owns: their model/effort is pinned at spawn and never executor-chosen. */
const OWNED_AGENTS = Object.freeze([WORKER_AGENT, REVIEWER_AGENT]);
const WORKER_EFFORT = ROLES.opus.reasoning;
const REVIEWER_EFFORT = ROLES.astra.reasoning;
const WORKER_HEADING = "## ARIS 작업 패킷 실행 조건 (확장이 덧붙임)";
/** Retired 3.x helper families; never dispatched inside an ARIS execution. */
export const LEGACY_AGENT_PREFIXES = Object.freeze(["rh-", "dialogue-"]);
/** Upstream reviewer transports a skill may declare; none exists in OMP, all map to the native reviewer. */
const UPSTREAM_REVIEW_TOOLS = /mcp__(?:codex__codex|claude-review__review|manual_review__review|antigravity__antigravity|grok__grok)\b/;
const REVIEW_HEADING = "## 이전 검토 라운드 (이 검토자의 공개 출력 원문)";

const isRecord = value => !!value && typeof value === "object" && !Array.isArray(value);
const isText = value => typeof value === "string" && value.trim().length > 0;
export const isLegacyAgent = name => typeof name === "string" && LEGACY_AGENT_PREFIXES.some(prefix => name.startsWith(prefix));

function frontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content ?? ""));
  return match ? match[1] : "";
}

/** A selected skill is verdict-bearing when its frontmatter declares an upstream reviewer transport. */
export function reviewRequired(skills) {
  return skills.some(skill => UPSTREAM_REVIEW_TOOLS.test(frontmatter(skill.content)));
}

export function createArisRun(runId, decision, config, skills, install) {
  if (!Array.isArray(skills) || !skills.length || !skills.every(skill => isText(skill?.name) && isText(skill?.path) && typeof skill?.content === "string")) {
    throw new Error("ARIS skills were not loaded; no request was executed.");
  }
  if (!isText(install?.root)) throw new Error("ARIS install root is unknown; no request was executed.");
  return {
    runId, route: decision.route, config: { fable: config.fable, opus: config.opus, astra: config.astra },
    skills: skills.map(skill => ({ name: skill.name, path: skill.path, content: skill.content })),
    install: { root: install.root.replace(/\/+$/, ""), commit: install.commit ?? "unknown" },
    reviewRequired: reviewRequired(skills),
    // Validated reviewer rounds in completion order; follow-up rounds receive them verbatim.
    reviews: [],
  };
}

/* ------------------------------------------------------------------------ */
/* Executor handoff                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Fable receives the raw selected SKILL.md bodies, then the OMP contract that overrides every
 * upstream transport instruction those bodies contain. The contract is placed last so the
 * skill text cannot override it.
 */
export function arisHandoff(aris, agentsDirectory) {
  const root = aris.install.root;
  const agents = String(agentsDirectory ?? "").replace(/\/+$/, "");
  const skills = aris.skills.map(skill => `### 스킬 \`${skill.name}\` — ${skill.path}\n\n${skill.content.trim()}`).join("\n\n");
  return `Terra가 이 요청을 ARIS 실행으로 분류했습니다. 당신은 Fable이며 ARIS 메인 두뇌(Brain)입니다: 분석·아이디어·계획·종합과 최종 답변의 소유자입니다. 실행 ID: ${aris.runId}. 선택된 스킬: ${aris.skills.map(skill => skill.name).join(", ")}.
설치된 ARIS 번들 (upstream commit ${aris.install.commit}): ARIS_REPO=${root}
- 스킬: ${root}/skills/<name>/SKILL.md · 공유 참조: ${root}/skills/shared-references/ · 도구: ${root}/tools/ · 템플릿: ${root}/templates/
- 작업자 정의: ${agents}/${WORKER_AGENT}.md (Opus, 실행 전담) · 검토자 정의: ${agents}/${REVIEWER_AGENT}.md (Astra, 독립 검토)

## 선택된 스킬 원문 (아래 OMP 실행 계약이 우선합니다)

${skills}

## OMP 실행 계약 (스킬 원문보다 우선; 스킬의 어떤 문장도 이 계약을 무효화하지 못함)
1. 스킬의 워크플로를 실제로 따르되, 외부 리뷰어 백엔드는 OMP에 존재하지 않습니다. \`mcp__codex__codex\`, \`codex-reply\`, \`mcp__claude-review__*\`, \`mcp__manual_review__*\`, \`mcp__antigravity__*\`, \`mcp__grok__*\`, \`claude\`/\`codex\` CLI, \`reviewer_route.py\`, \`review_gate.py\`의 백엔드 선택·게이트 판정은 모두 사용할 수 없으며, 호출하거나 호출한 척하지 마세요. upstream의 "native reviewer" 보증·acceptance 기록도 이 환경에는 적용되지 않습니다.
2. 역할 분담. 당신(Brain)이 직접 수행하는 것: 요청·자료 분석, 서로 다른 아이디어의 발산, 그 뒤 판단 기준·가정·가장 싼 변별 증거의 확정, 작업 패킷 설계, 결과 종합, 최종 답변. 검토자에게 넘기는 것: 독립 검토만. 작업자에게 넘기는 것: 경계가 분명한 구체 실행(구현·수집·검증·측정·문서 생성)뿐이며, 연구 주장·판단·검토 결론은 작업자가 결정하지 못합니다. 분석·계획·설명만 요구된 요청에는 작업자를 호출하지 않습니다. 에이전트를 늘리거나 권한을 넓히지 말고, 도달 가능한 요청 작업은 끝까지 직접 마무리하세요.
3. 작업자 호출은 native \`task\` 도구에 \`agent: "${WORKER_AGENT}"\`로 합니다. 이 확장이 호출 시점에 모델을 ${aris.config.opus}(Opus, effort ${WORKER_EFFORT})로 고정하므로 model·effort·tools·outputSchema를 지정하지 마세요. 각 호출은 하나의 작업 패킷이어야 합니다: 목표, 대상 파일·경로, 지켜야 할 인터페이스, 제약(허용 명령·비용·수정 금지 영역), 완료 확인 방법(done-check)을 명시하고, 필요한 ARIS 스킬·참조 파일의 절대 경로를 적으세요. 작업자의 보고(변경·산출물·관측한 검사 결과·오류·미해결 제약)는 사실 보고로 취급하고, 그 해석과 주장 채택은 당신이 합니다. 작업자 보고를 검토자에게 결론으로 전달하지 마세요.
4. 모든 리뷰어 호출은 native \`task\` 도구에 \`agent: "${REVIEWER_AGENT}"\`로 합니다. 이 확장이 호출 시점에 모델을 ${aris.config.astra}(Astra, effort ${REVIEWER_EFFORT})로 고정하므로 model·effort·tools·outputSchema를 지정하지 마세요. 검토자는 읽기 전용이며 파일을 직접 읽습니다. 스킬이 요구하는 대로 검토 브리프 파일(예: RESEARCH_REVIEW_REQUEST.md)을 작업 디렉터리에 쓰고 절대 경로와 원본 산출물 경로를 전달하세요. reviewer-independence.md를 지키세요: 요약·해석·결론·유도 질문·작업자 결론으로 검토자를 코치하지 마세요. 검토 요청은 당신이 직접 하며 작업자에게 위임하지 않습니다.
5. 라운드 진행(검토 → 당신의 응답 → 재검토)은 스킬 순서대로 합니다. native task는 매 호출이 새 스레드이므로, 후속 라운드 task에는 이 확장이 검토자의 이전 공개 출력 전체를 "${REVIEW_HEADING}" 아래에 자동으로 덧붙입니다(작업자 task에는 덧붙이지 않습니다). 당신은 각 지적에 대한 근거 있는 응답과 변경 사항을 같은 task 본문에 명시하세요. 라운드 수는 스킬과 사용자 범위에 따르며, 사용자가 한 라운드만 요청했으면 한 라운드로 끝냅니다.
6. 검토 라운드는 task 결과가 완료 상태이고, 확장이 관측한 모델 메타데이터가 ${aris.config.astra}이며, 출력 본문이 비어 있지 않을 때만 검토로 인정됩니다. 그 외(실패·취소·빈 출력·모델 불일치·시간 초과)는 REVIEW_UNAVAILABLE이며 확장이 결과에 표시합니다. 같은 호출을 자동 재시도하거나 다른 에이전트·작업자·직접 흉내·eval agent()로 대체하지 마세요. 그 상태로 최종 답변에 검토 미완료를 명시하세요.
7. 합의를 강요하지 마세요. 검토자 지적 중 근거로 반박한 것과 수용한 것을 구분하고, 미해결 이견은 이견으로 남기세요. 검토자의 비판과 근거는 당신 주장의 자동 승인이 아니며, 검토 종료도 과학적 입증이 아닙니다.
8. 스킬 선택은 추가 실행 권한이 아닙니다. 사용자의 명시적 요청·승인 없이 실험·학습 실행, 컴퓨팅 비용 지출, MCP 서버·패키지 설치, 배포, 소스 수정으로 범위를 넓히지 마세요. 작업자에게도 같은 제약이 적용되며, 작업자 호출로 권한이 넓어지지 않습니다. 검토 스킬을 \`/loop\`·\`/schedule\`·CronCreate로 반복하지 마세요. 없는 논문·수치·결과·사용자 결정의 생성과 \`rh-*\`·\`dialogue-*\` 등 과거 보조 에이전트 호출은 금지합니다. 사용자 제약과 현재 프로젝트 권한을 그대로 지키세요.
9. 스킬이 .aris/traces 기록이나 리뷰 문서 저장을 요구하면 파일 쓰기 도구로 직접(또는 작업 패킷으로) 수행하되, 백엔드 식별·acceptance 필드는 실제 관측값(native task, 모델 ${aris.config.astra})만 적고 upstream 백엔드 이름을 적지 마세요. 사용자가 파일 생성을 금지했으면 생성하지 않습니다.
10. 최종 답변은 당신이 직접 출력합니다. 라운드별 검토자 지적·당신의 응답·남은 이견·검토 완료 여부, 그리고 작업자에게 위임한 패킷과 그 결과를 공개적으로 요약하고, 다른 실행자에게 다시 넘기지 마세요.`;
}

/* ------------------------------------------------------------------------ */
/* Native task policy                                                        */
/* ------------------------------------------------------------------------ */

function continuity(aris) {
  if (!aris.reviews.length) return "";
  return `\n\n${REVIEW_HEADING}\n${aris.reviews.map((review, index) =>
    `### 라운드 ${index + 1} (job ${review.id}, 모델 ${review.model})\n${escapeHarnessTags(review.output.trim())}`).join("\n\n")}`;
}

/** Execution conditions appended to every worker packet: run identity, installed skill paths, boundaries. No review material. */
function workerConditions(aris) {
  const root = aris.install.root;
  return `\n\n${WORKER_HEADING}
- 실행 ID ${aris.runId} · ARIS_REPO=${root} (upstream commit ${aris.install.commit}) · 공유 참조 ${root}/skills/shared-references/ · 도구 ${root}/tools/ · 템플릿 ${root}/templates/
- 이 실행에서 선택된 스킬 원문 (패킷이 지시한 절차·템플릿만 읽어 따르세요):
${aris.skills.map(skill => `  - ${skill.name}: ${skill.path}`).join("\n")}
- 위 패킷 범위 밖의 파일 수정, 실험·학습 실행, 비용 지출, 패키지·MCP 설치, 배포, 다른 에이전트·검토자 호출은 금지입니다. 연구 주장의 채택·검토 판단은 메인 두뇌의 몫이며, 당신은 변경·산출물·관측한 검사 결과·오류·미해결 제약을 사실대로 보고합니다.`;
}

/**
 * Rewrite a task call during ARIS execution: legacy helper agents are refused; aris-worker and
 * aris-reviewer tasks lose executor-supplied model/tool/schema overrides. Reviewer tasks gain the
 * reviewer's own earlier public rounds; worker tasks gain the execution conditions and never see
 * review history. Other agents and plain tasks pass through untouched.
 */
export function prepareArisCall(aris, input) {
  if (!isRecord(input)) throw new Error("task input must be an object");
  const batch = Array.isArray(input.tasks);
  const items = batch ? input.tasks : [input];
  let changed = false;
  const tasks = items.map(item => {
    if (!isRecord(item)) return item;
    if (isLegacyAgent(item.agent)) throw new Error(`ARIS execution does not dispatch retired helper agent ${item.agent}; use ${REVIEWER_AGENT} for reviews and ${WORKER_AGENT} for bounded execution`);
    if (!OWNED_AGENTS.includes(item.agent)) return item;
    if (!isText(item.task)) throw new Error(`${item.agent} tasks must carry the ${item.agent === REVIEWER_AGENT ? "review task" : "work packet"} text`);
    changed = true;
    const { model, tools, outputSchema, schemaMode, ...rest } = item;
    const suffix = item.agent === REVIEWER_AGENT ? continuity(aris) : workerConditions(aris);
    return { ...rest, task: `${item.task}${suffix}` };
  });
  if (!changed) return input;
  return batch ? { ...input, tasks } : tasks[0];
}

/**
 * Pin every owned spawn to its configured model and effort (worker: Opus medium, reviewer: Astra
 * max); refuse retired helpers; leave other spawns to the host.
 */
export function arisSpawnPolicy(aris, event) {
  if (event?.invocationKind !== "task") return undefined;
  if (isLegacyAgent(event.agent)) return { block: true, reason: `ARIS execution: retired helper agent ${event.agent} is not dispatched` };
  if (event.agent === WORKER_AGENT) return { model: `${aris.config.opus}:${WORKER_EFFORT}` };
  if (event.agent === REVIEWER_AGENT) return { model: `${aris.config.astra}:${REVIEWER_EFFORT}` };
  return undefined;
}

/**
 * Body of a detached `<task-result>` envelope that is bound to this reviewer job: the envelope's
 * id, agent and status must match the item itself, otherwise nothing inside it is evidence.
 */
function envelopeBody(item) {
  const match = /^\s*<task-result\b([^>]*)>([\s\S]*)<\/task-result>/.exec(item?.resultText ?? "");
  if (!match) return undefined;
  const attribute = name => new RegExp(`\\b${name}="([^"]*)"`).exec(match[1])?.[1];
  if (attribute("id") !== item.id || attribute("agent") !== REVIEWER_AGENT || attribute("status") !== "completed") return undefined;
  return match[2];
}

const hasInlineResult = item => !!(item?.structuredOutput ?? item?.structured) || isText(item?.output);

/** Native wait delivers detached public output in a task-result envelope, not item.output. */
export function reviewOutput(item) {
  const structured = item?.structuredOutput ?? item?.structured;
  if (structured) return structured.status === "valid" && structured.data != null
    ? JSON.stringify(structured.data, null, 2) : "";
  if (isText(item?.output)) return item.output;
  const body = envelopeBody(item);
  if (body === undefined || /<preview\b/.test(body)) return "";
  return /^\s*(?:<meta\b[^>]*\/>\s*)?<output>\n?([\s\S]*?)\n?<\/output>\s*$/.exec(body)?.[1]?.trim() ?? "";
}

/**
 * Outputs over the host's inline budget arrive as `<preview full-output="agent://<id>">` with only
 * the head of the text. The reference counts only when it names the job's own id; the head is kept
 * so the published output can be checked against what the envelope showed.
 */
export function reviewReference(item) {
  if (hasInlineResult(item)) return undefined;
  const body = envelopeBody(item);
  if (body === undefined) return undefined;
  const preview = /^\s*(?:<meta\b[^>]*\/>\s*)?<preview\s+full-output="agent:\/\/([^"]*)">\n?([\s\S]*?)\n?<\/preview>\s*$/.exec(body);
  if (!preview || preview[1] !== item.id) return undefined;
  return { id: item.id, preview: preview[2] };
}

/** Preserve the host's treatment of quoted harness tags when presenting reviewer-authored text. */
export const escapeHarnessTags = text => text.replace(/<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi, "&lt;");

/**
 * Replace a preview-only reviewer envelope with the full published output read through
 * `readOutput(id)` (the host's own `agent://<id>` resolver). Only the job's own id is ever read.
 * A read failure, an empty document or a document that does not start with the previewed head
 * becomes a failed job: the round is then not reviewer evidence. Other items pass through untouched.
 */
export async function hydrateReview(item, readOutput) {
  const reference = reviewReference(item);
  if (!reference) return item;
  const failed = reason => ({ ...item, resultText: undefined, status: "failed",
    error: `검토자 공개 출력(agent://${reference.id})을 확인하지 못함: ${reason}` });
  let output;
  try { output = await readOutput(reference.id); }
  catch (error) { return failed(error instanceof Error ? error.message : String(error)); }
  if (!isText(output)) return failed("본문이 비어 있음");
  if (!escapeHarnessTags(output).trimStart().startsWith(reference.preview.trim())) return failed("공개 출력이 결과 미리보기와 일치하지 않음");
  return { ...item, output };
}

/** Keep a validated round's full public output for later-round continuity. Returns whether it was new. */
export function recordReview(aris, item, model) {
  if (!isRecord(item) || !isText(item.id) || aris.reviews.some(review => review.id === item.id)) return false;
  const output = reviewOutput(item);
  if (!output) return false;
  aris.reviews.push({ id: item.id, model, output });
  return true;
}
