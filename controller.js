import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ARIS_ROUTES, DEFAULTS, DEFAULT_REVIEW_SKILL, collectContext, matchesRole, normalizeConfig, ROLES, ROUTER, SELECTABLE_ROLES, routeRequest } from "./protocol.js";
import { FLOW, createFlow, expectNative, finishFlow, flowText, nativeReference, observeNative, planFlow, publicText, restoreFlow, reviewProblem, startExecution, updateStage } from "./flow.js";
import { REVIEWER_AGENT, WORKER_AGENT, arisHandoff, arisSpawnPolicy, createArisRun, escapeHarnessTags, hydrateReview, prepareArisCall, recordReview } from "./aris-runtime.js";
import { prepareWaveCall, waveHandoff } from "./waves.js";

const STATE = "agent-dialogue-state";
const CARD = "agent-dialogue";
const AGENTS_DIR = fileURLToPath(new URL("./agents/", import.meta.url));
const HELP = [
  "/dialogue on · off · status · stop",
  "/dialogue skills — 설치된 ARIS 스킬 목록과 실행 준비 상태",
  "/dialogue flow — Wave 카드 그래프 · 노드 선택 · 공개 작업/결과 상세",
  "/dialogue models — Fable Brain · Opus Worker · Astra 검토자 모델 선택",
  "/dialogue fable|opus|astra [provider/model] — 생략하면 선택창",
  "ON = AUTO: Terra 6.1 xhigh가 Astra 단독 / ARIS 검토 / ARIS 연구 스킬을 선택합니다.",
  `ARIS 경로: Fable이 분석·아이디어·종합을 맡고, native ${WORKER_AGENT}(Opus)가 실행, ${REVIEWER_AGENT}(Astra)가 독립 검토합니다.`,
  "라우팅에는 최근 텍스트(최대 24,000자)와 요청/이미지를 전송하며 추가 사용량이 발생합니다.",
].join("\n");

function restoredState(entries) {
  let result = { enabled: false, ...DEFAULTS };
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE) continue;
    const data = entry.data;
    if (![1, 2, 3, 4].includes(data?.version) || typeof data.enabled !== "boolean") continue;
    const required = data.version === 1 ? [] : data.version < 4 ? ["astra", "opus"] : SELECTABLE_ROLES;
    if (!required.every(role => typeof data[role] === "string" && /^[^\s/]+\/\S+$/.test(data[role]))) continue;
    // Upgrade the old built-in Opus default; retain custom selectors and all v4 choices.
    const config = data.version === 1 ? {} : { ...data };
    if (data.version < 4 && config.opus === "anthropic/claude-opus-4-6") config.opus = DEFAULTS.opus;
    result = { enabled: data.enabled, ...normalizeConfig(config) };
  }
  return result;
}


function assertModel(ctx, selector, role) {
  const model = ctx.models.list().find(item => `${item.provider}/${item.id}` === selector);
  const label = ROLES[role].label;
  if (!model) throw new Error(`${label} 모델을 사용할 수 없습니다: ${selector}. /login 또는 /dialogue models를 확인하세요.`);
  if (!matchesRole(role, model, ctx.models.family(model))) {
    throw new Error(`${label} 역할에 맞는 모델이 필요합니다: ${selector}`);
  }
  if (role === "router" && (!model.reasoning || !model.thinking?.efforts?.includes(ROUTER.reasoning))) {
    throw new Error(`Terra 라우터는 ${ROUTER.reasoning} 지원이 필수입니다. 낮은 강도로 대체하지 않습니다.`);
  }
  if (role !== "router" && (!model.reasoning || !model.thinking?.efforts?.includes(ROLES[role].reasoning))) {
    throw new Error(`${label} 역할은 ${ROLES[role].reasoning} 추론 강도가 필요합니다: ${selector}. 다른 모델로 대체하지 않습니다.`);
  }
  return model;
}

/** Readiness of the ARIS path: installed bundle, native task tool, owned agents and all three models. */
function arisReadiness(pi, ctx, config, validateArisInstall) {
  let install;
  let problem;
  try { install = validateArisInstall(); }
  catch (error) { problem = error instanceof Error ? error.message : String(error); }
  const task = pi.getActiveTools().includes("task") && pi.getAllTools().find(tool => tool.name === "task");
  if (!problem && !task) problem = "native task 도구가 비활성화되어 있습니다";
  if (!problem) {
    const missing = [WORKER_AGENT, REVIEWER_AGENT].find(agent => !task.description.includes(`- \`${agent}\``));
    if (missing) problem = `${missing} 에이전트가 native task 목록에 없습니다. /reload-plugins가 필요합니다`;
  }
  for (const role of SELECTABLE_ROLES) {
    if (problem) break;
    try { assertModel(ctx, config[role], role); }
    catch (error) { problem = error.message; }
  }
  return { install, problem };
}

const routeTitle = decision => decision.route === "solo" ? (decision.waves.length ? "Astra 주도" : "Astra 단독")
  : `${decision.route === "dialogue" ? "ARIS 검토" : "ARIS 연구"} · ${decision.skills.join(", ")}`;

const isRecord = value => !!value && typeof value === "object" && !Array.isArray(value);

// Factories are rebound by the host in each child session. Only live root runs
// enter this bridge; a child factory binds once to an already admitted host job.
const observedRuns = new Set();

/**
 * Factory-local state: subagents never inherit the main session's active run.
 * `skills` is the installed-bundle accessor ({ getArisCatalog, loadArisSkills, validateArisInstall }).
 * `readAgentOutput(id, ctx)` resolves a published `agent://<id>` document through the host; a host
 * without one fails every detached round instead of guessing at files.
 */
export function registerDialogue(pi, runModelTurn, createFlowView, skills, readAgentOutput = async id => {
  throw new Error(`agent://${id} 공개 출력을 읽을 수단이 호스트에 없음`);
}) {
  const { getArisCatalog, loadArisSkills, validateArisInstall } = {
    getArisCatalog: () => skills.getArisCatalog(),
    loadArisSkills: names => skills.loadArisSkills(names),
    validateArisInstall: () => skills.validateArisInstall(),
  };
  let state = { enabled: false, ...DEFAULTS };
  let active;
  let unsubscribe;
  let revision = 0;
  let execution;
  let displayedRun;
  let explorer;
  let observedContext;
  let observationOwner;
  let observationIdentity;
  const observationSubscriptions = [];
  // Host setModel is asynchronous and not abortable. Drain switches before
  // session navigation, and serialize replacement requests through the same gate.
  let handoffTail = Promise.resolve();

  const isMain = ctx => !ctx.agent || ctx.agent.kind === "main";
  const card = (content, details = {}) => pi.sendMessage({
    customType: CARD, content, display: true, details,
  }, { triggerTurn: false });
  const status = ctx => ctx.ui.setStatus(CARD, state.enabled ? "Dialogue AUTO · Terra → Astra / Fable Brain · Opus Worker · Astra 검토" : undefined);
  const persist = ctx => {
    revision++;
    pi.appendEntry(STATE, { version: 4, ...state });
    status(ctx);
  };
  const owns = run => active === run && !run.controller.signal.aborted &&
    run.ctx.sessionManager.getSessionId() === run.sessionId;

  function paint(run, save = false) {
    displayedRun = run;
    if (save) pi.appendEntry(FLOW, structuredClone(run.flow));
    if (run.ctx.mode === "tui") {
      if (run.view) {
        run.view.invalidate();
        run.tui.requestRender();
      } else {
        run.ctx.ui.setWidget(FLOW, (tui, theme) => {
          run.tui = tui;
          run.view = createFlowView(() => run.flow, theme, { getHeight: () => tui.terminal.rows });
          return run.view;
        });
      }
    } else run.ctx.ui.setWidget(FLOW, flowText(run.flow));
    if (explorer?.run === run) {
      explorer.view?.invalidate();
      explorer.tui?.requestRender();
    }
    run.lastPaint = Date.now();
  }

  function endFlow(run, result, note) {
    if (run.flow.status !== "running") return;
    finishFlow(run.flow, result, note);
    observedRuns.delete(run);
    run.toolCalls?.clear();
    run.agentParents?.clear();
    run.publicOutputs?.clear();
    // UI-only: sendMessage during agent_end can queue a new model turn.
    paint(run, true);
  }

  function interruptExecution(note) {
    if (!execution) return;
    endFlow(execution.run, "interrupted", note);
    execution = undefined;
  }

  function cancel(reason, announce = true) {
    const run = active;
    if (!run) return;
    active = undefined;
    run.controller.abort(new Error(reason));
    endFlow(run, "cancelled", reason);
    status(run.ctx);
    if (announce && run.ctx.sessionManager.getSessionId() === run.sessionId) {
      card(`**에이전트 대화 중단** — ${reason}\n\n이번 요청은 실행하지 않았습니다. 다시 입력하면 새 대화를 시작합니다.`, { runId: run.id, phase: "cancelled" });
    }
  }

  function closeExplorer() {
    explorer?.close?.();
  }

  async function showFlow(ctx) {
    const run = displayedRun;
    if (!run) {
      ctx.ui.notify("아직 자동 라우팅 실행 기록이 없습니다. /dialogue on 후 요청하세요.", "info");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.setWidget(FLOW, flowText(run.flow));
      return;
    }
    if (explorer) return;
    const panel = { run };
    const sessionId = ctx.sessionManager.getSessionId();
    const current = () => explorer === panel && displayedRun === run && ctx.sessionManager.getSessionId() === sessionId;
    explorer = panel;
    try {
      await ctx.ui.custom((tui, theme, _keys, done) => {
        panel.tui = tui;
        panel.close = () => done(undefined);
        panel.view = createFlowView(() => run.flow, theme, {
          interactive: true,
          getHeight: () => tui.terminal.rows,
          requestRender: () => tui.requestRender(),
          onClose: panel.close,
          readOutput: async selected => {
            if (!current()) throw new Error("세션 또는 실행이 변경되어 원문 읽기를 중단했습니다.");
            const row = run.flow.rows.find(item => item.id === selected.id);
            if (!row?.jobIds.length) throw new Error("이 노드에는 게시된 native 작업 원문이 없습니다.");
            const outputs = [];
            for (const id of row.jobIds) {
              if (!current()) throw new Error("세션 또는 실행이 변경되어 원문 읽기를 중단했습니다.");
              const text = publicText(await readAgentOutput(id, ctx));
              if (!text) throw new Error(`agent://${id}: 공개 출력이 비어 있습니다.`);
              outputs.push(row.jobIds.length > 1 ? `agent://${id}\n${text}` : text);
            }
            if (!current()) throw new Error("세션 또는 실행이 변경되어 원문 읽기를 중단했습니다.");
            return outputs.join("\n\n");
          },
        });
        return panel.view;
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, fullscreen: true, mouseTracking: false } });
    } catch (error) {
      if (current()) ctx.ui.notify(`Flow 화면을 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      panel.view?.dispose?.();
      if (explorer === panel) explorer = undefined;
    }
  }

  async function pickModels(ctx, roles) {
    if (!ctx.hasUI) throw new Error("모델 선택창에는 UI가 필요합니다. /dialogue <fable|opus|astra> <provider/model>을 사용하세요.");
    const sessionId = ctx.sessionManager.getSessionId();
    const startedAtRevision = revision;
    const selected = {};
    const assertCurrent = () => {
      if (revision !== startedAtRevision || sessionId !== ctx.sessionManager.getSessionId() || active) {
        throw new Error("세션·설정 또는 실행 상태가 변경되어 모델 선택을 적용하지 않았습니다. 선택창을 다시 여세요.");
      }
    };
    for (const [index, role] of roles.entries()) {
      assertCurrent();
      const speaker = ROLES[role].label;
      const current = state[role];
      const options = ctx.models.list()
        .filter(model => matchesRole(role, model, ctx.models.family(model)))
        .map(model => {
          const selector = `${model.provider}/${model.id}`;
          return { label: selector, description: `${ROLES[role].duty} · ${ROLES[role].reasoning} · ${model.name || model.id}${selector === current ? " · 현재 선택" : ""}` };
        })
        .sort((a, b) => Number(b.label === current) - Number(a.label === current) || a.label.localeCompare(b.label));
      if (!options.length) throw new Error(`인증된 ${speaker} 모델이 없습니다. /login 후 다시 선택하세요.`);
      const choice = await ctx.ui.select(`${speaker} 모델 선택 (${index + 1}/${roles.length}) — 현재: ${current}`, options);
      assertCurrent();
      if (choice === undefined) {
        ctx.ui.notify("모델 선택을 취소했습니다. 기존 설정을 유지합니다.", "info");
        return false;
      }
      if (!options.some(option => option.label === choice)) throw new Error("목록에 없는 모델은 선택할 수 없습니다.");
      selected[role] = choice;
    }
    // Commit all roles together; cancelling any menu preserves the previous set.
    for (const role of roles) assertModel(ctx, selected[role], role);
    Object.assign(state, selected);
    return true;
  }

  async function dispatch(run, decision) {
    const { route } = decision;
    const aris = ARIS_ROUTES.includes(route);
    const operation = handoffTail.then(async () => {
      if (!owns(run)) return;
      if (!run.ctx.isIdle()) throw new Error("다른 작업이 시작되어 실행을 보류했습니다. 완료 후 요청을 다시 입력하세요.");
      if (aris) {
        const { problem } = arisReadiness(pi, run.ctx, run.config, validateArisInstall);
        if (problem) throw new Error(problem);
      }
      const role = aris ? "fable" : "astra";
      const taskLabel = aris ? `Brain · ${decision.skills.join(", ")}` : decision.waves.length ? "Wave 조정" : "단독 처리";
      const model = assertModel(run.ctx, run.config[role], role);
      run.flow.note = `${ROLES[role].label} ${taskLabel} 준비 중`;
      paint(run);
      if (!await pi.setModel(model)) throw new Error(`${ROLES[role].label} 실행 모델로 전환하지 못했습니다.`);
      if (!owns(run)) return;
      const current = run.ctx.models.current();
      if (!run.ctx.isIdle() || current?.provider !== model.provider || current?.id !== model.id) {
        throw new Error("실행 상태 또는 모델이 변경되어 요청을 전달하지 않았습니다.");
      }
      pi.setThinkingLevel(ROLES[role].reasoning);
      // The full selected SKILL.md bodies are already loaded in run.aris: the handoff precedes the prompt.
      pi.sendMessage({
        customType: CARD, display: false,
        content: `${aris ? arisHandoff(run.aris, AGENTS_DIR)
          : "Terra가 이 요청을 Astra 주도 일반 작업으로 분류했습니다. ARIS 스킬은 필요하지 않습니다. 원본 근거와 제약을 확인하고 수치·논리·코드 불변식을 점검한 뒤 필요한 최소 작업을 직접 수행·검증하세요. 관측과 추론, 검증하지 못한 부분을 구분하고 아래 Terra Wave 계획에 따라 필요한 작업만 위임하세요."}\n\n${waveHandoff(decision.waves)}`,
        details: { runId: run.id, phase: "handoff", ...decision, speaker: role, model: run.config[role], reasoning: ROLES[role].reasoning,
          ...(aris ? { worker: { agent: WORKER_AGENT, model: run.config.opus }, reviewer: { agent: REVIEWER_AGENT, model: run.config.astra }, install: run.aris.install, reviewRequired: run.aris.reviewRequired } : {}) },
      }, { triggerTurn: false, deliverAs: "nextTurn" });
      execution = { sessionId: run.sessionId, role, run };
      run.paint = save => paint(run, save);
      run.consume = (details, sourceCtx) => consumeResults(run, details, sourceCtx);
      run.evidence = content => pi.sendMessage({
        customType: CARD, display: false, content, details: { runId: run.id, phase: "evidence" },
      }, { triggerTurn: false, deliverAs: "nextTurn" });
      observedRuns.add(run);
      startExecution(run.flow);
      run.flow.note = "공개 실행 기록 · native 작업 카드는 실행 결과 원문 · Esc 중단";
      paint(run, true);
      run.ctx.ui.setStatus(CARD, `Dialogue AUTO · ${ROLES[role].label} ${taskLabel}`);
      // Programmatic prompts bypass the external input hook: no routing recursion.
      pi.sendUserMessage([{ type: "text", text: run.text }, ...run.images]);
      active = undefined;
    });
    handoffTail = operation.catch(() => {});
    await operation;
  }

  async function perform(run) {
    const args = {
      prompt: run.text, images: run.images, context: run.context, cwd: run.ctx.cwd,
      signal: run.controller.signal, runTurn: options => runModelTurn(run.ctx, options),
    };
    try {
      if (!owns(run)) return;
      run.ctx.ui.setStatus(CARD, "Dialogue AUTO · Terra 6.1 xhigh 라우팅");
      paint(run, true);
      const decision = await routeRequest({ ...args, catalog: getArisCatalog() });
      if (!owns(run)) return;
      if (ARIS_ROUTES.includes(decision.route)) {
        // Full SKILL.md bodies are loaded now, before any handoff or prompt; a missing file fails the run here.
        run.aris = createArisRun(run.id, decision, run.config, loadArisSkills(decision.skills), validateArisInstall());
        if (run.aris.reviewRequired && !decision.waves.length) throw new Error("선택한 스킬은 독립 검토가 필요하지만 Terra의 실행 Wave 계획이 비어 있습니다.");
      }
      planFlow(run.flow, decision, run.config, { reviewRequired: run.aris?.reviewRequired });
      paint(run, true);
      card(`**Terra 라우팅 → ${routeTitle(decision)}**\n\n${decision.reason}\n\n${decision.waves.length ? decision.waves.map((wave, index) => `Wave ${index + 2} · ${wave.title} · 동시 최대 ${wave.parallel}`).join("\n") : "위임 Wave 없음 · 메인 직접 처리"}`, {
        runId: run.id, phase: "route", ...decision, model: ROUTER.model, reasoning: ROUTER.reasoning,
      });
      if (owns(run)) await dispatch(run, decision);
    } catch (error) {
      if (!owns(run)) return;
      active = undefined;
      run.controller.abort(error);
      endFlow(run, "failed", error instanceof Error ? error.message : String(error));
      status(run.ctx);
      card(`**라우팅·준비 실패 — 자동 실행하지 않음**\n\n${error instanceof Error ? error.message : String(error)}\n\n설정을 확인한 후 요청을 다시 입력하세요.`, { runId: run.id, phase: "error" });
    }
  }

  function restore(_event, ctx) {
    observedContext = ctx;
    closeExplorer();
    cancel("세션이 변경되었습니다.", false);
    interruptExecution("세션이 변경되어 이전 실행의 추적을 종료했습니다.");
    unsubscribe?.();
    unsubscribe = undefined;
    if (!isMain(ctx)) return;
    revision++;
    state = restoredState(ctx.sessionManager.getBranch());
    status(ctx);
    const flow = restoreFlow(ctx.sessionManager.getBranch());
    displayedRun = undefined;
    ctx.ui.setWidget(FLOW, undefined);
    if (flow) paint({ flow, ctx });
    if (ctx.mode === "tui") {
      unsubscribe = ctx.ui.onTerminalInput(data => {
        if (active && !explorer && ["\x1b", "\x03", "\x1b[27u", "\x1b[27;1u"].includes(data)) {
          cancel("사용자가 중단했습니다.");
          return { consume: true };
        }
      });
    }
  }

  pi.on("session_start", restore);
  pi.on("session_switch", restore);
  pi.on("session_branch", restore);
  pi.on("session_tree", restore);
  for (const name of ["session_before_switch", "session_before_branch", "session_before_tree"]) {
    pi.on(name, async () => {
      closeExplorer();
      revision++;
      cancel("세션 이동으로 중단했습니다.");
      interruptExecution("세션 이동으로 추적 종료. 미완료 단계는 성공으로 표시하지 않습니다.");
      await handoffTail;
    });
  }
  pi.on("session_before_compact", async () => {
    revision++;
    cancel("문맥 압축으로 라우팅·자문을 중단했습니다.");
    // Compaction rewrites history in place; native jobs and their frozen packet
    // still belong to this session. Navigation/shutdown invalidate them separately.
    await handoffTail;
  });
  pi.on("session_shutdown", async () => {
    for (const dispose of observationSubscriptions.splice(0)) dispose();
    observedContext = undefined;
    observationOwner = undefined;
    observationIdentity = undefined;
    closeExplorer();
    revision++;
    cancel("세션을 종료했습니다.", false);
    interruptExecution("세션이 종료되었습니다. 실행 중이던 단계의 완료를 확인하지 못했습니다.");
    unsubscribe?.();
    await handoffTail;
  });
  pi.on("agent_end", (event, ctx) => {
    if (!isMain(ctx) || !execution || execution.sessionId !== ctx.sessionManager.getSessionId()) return;
    if (event.willContinue || event.awaitingAsyncWork) return;
    const run = execution.run;
    const last = [...(event.messages ?? [])].reverse().find(message => message.role === "assistant");
    const reason = last?.stopReason ?? run.lastStopReason;
    const result = reason === "aborted" ? "cancelled" : ["error", "length"].includes(reason) ? "failed"
      : reason === "stop" ? "completed" : "incomplete";
    // finishFlow downgrades "completed" when a reviewer round failed validation or a required round never completed.
    endFlow(run, result, result === "failed" ? "최종 모델 호출이 정상 완료되지 않았습니다." : undefined);
    execution = undefined;
    status(ctx);
  });

  const executing = ctx => isMain(ctx) && execution?.sessionId === ctx.sessionManager.getSessionId()
    && execution.run.flow.status === "running" ? execution.run : undefined;

  function tracking(ctx) {
    const root = executing(ctx);
    if (root || isMain(ctx)) return root;
    if (observationOwner) return observedRuns.has(observationOwner) &&
      observationOwner.flow.status === "running" && !observationOwner.controller.signal.aborted &&
      observationOwner.ctx.sessionManager.getSessionId() === observationOwner.sessionId &&
      ctx.sessionManager.getSessionId() === observationIdentity.sessionId &&
      ctx.agent?.id === observationIdentity.id && ctx.agent?.parentId === observationIdentity.parentId
      ? observationOwner : undefined;
    if (!ctx.agent?.id || !ctx.agent.parentId) return;
    for (const run of observedRuns) {
      const parent = run.agentParents.get(ctx.agent.id);
      if (!parent || parent.identity !== ctx.agent.parentId) continue;
      const file = ctx.sessionManager.getSessionFile?.();
      if (parent.sessionFile && file && parent.sessionFile !== file) continue;
      observationOwner = run;
      observationIdentity = { sessionId: ctx.sessionManager.getSessionId(), id: ctx.agent.id, parentId: ctx.agent.parentId };
      return run;
    }
  }
  const callKey = (ctx, id) => `${ctx.sessionManager.getSessionId()}:${id}`;
  const parentRow = (run, ctx) => isMain(ctx) ? "final"
    : run.flow.rows.find(row => row.jobIds.includes(ctx.agent.id))?.id;
  const knownJob = (run, id) => run.flow.rows.find(row => row.jobIds.includes(id));

  function scopedDetails(run, ctx, details, call) {
    if (!isRecord(details)) return details;
    const scope = item => {
      if (!isRecord(item) || typeof item.id !== "string" || (item.type && item.type !== "task")) return;
      const known = knownJob(run, item.id);
      const canSpawn = call && ["task", "eval"].includes(call.toolName);
      if (!known && (!canSpawn || !call.parentId)) return;
      if (known && call && canSpawn && known.parentId !== call.parentId) return;
      const task = call?.tasks?.find(task => task?.name === item.id) ??
        (call?.tasks?.length === 1 ? call.tasks[0] : undefined);
      const agent = item.agent || task?.agent ||
        (known ? known.review ? REVIEWER_AGENT : known.worker ? WORKER_AGENT : known.agent : canSpawn ? "task" : undefined);
      const result = { ...item, ...(agent ? { agent } : {}), parentId: known?.parentId ?? call?.parentId };
      if (!result.task && task) result.task = [publicText(task.context), publicText(task.task)].filter(Boolean).join("\n\n");
      if (canSpawn && (!known || item.sessionFile)) run.agentParents.set(item.id, {
        identity: ctx.agent?.id, sessionFile: item.sessionFile,
      });
      return result;
    };
    const result = { ...details };
    for (const key of ["progress", "results", "jobs"]) {
      if (Array.isArray(details[key])) result[key] = details[key].map(scope).filter(Boolean);
    }
    if (isRecord(details.evalResult)) result.evalResult = scope(details.evalResult);
    return result;
  }

  pi.on("message_end", async (event, ctx) => {
    const run = tracking(ctx);
    const message = event.message;
    if (!run) return;
    if (message?.role === "custom" && message.customType === "async-result") {
      // Auto-delivery is not a tool_result. Bind typed job IDs to this run and use only
      // previously observed native model metadata, never the delivery's prose.
      const results = [];
      const bodies = [];
      const deliveredText = typeof message.content === "string" ? message.content
        : (message.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
      for (const delivery of Array.isArray(message.details?.jobs) ? message.details.jobs : []) {
        if (delivery.type !== "task" || typeof delivery.jobId !== "string") continue;
        const row = run.flow.rows.find(candidate => candidate.jobIds.includes(delivery.jobId));
        if (!row) continue;
        const job = row.jobs.find(candidate => candidate.id === delivery.jobId);
        if (!job || job.resultReceived || job.state === "cancelled") continue;
        const item = { id: delivery.jobId, type: "task", status: delivery.status, resolvedModelIdentity: job.model,
          resolvedThinkingLevel: job.thinkingLevel };
        if (delivery.status === "completed") {
          try {
            if (delivery.agentId && delivery.agentId !== delivery.jobId) throw new Error("전달된 agent ID가 관측한 작업 ID와 다릅니다");
            item.output = await readAgentOutput(delivery.jobId, ctx);
            if ((row.review || row.worker) && item.output.trim() && !deliveredText.includes(escapeHarnessTags(item.output.trim()))) {
              bodies.push({ type: "text", text: `${row.review ? "검토" : "작업"} 전문 (job ${delivery.jobId})\n${escapeHarnessTags(item.output)}` });
            }
          } catch (error) { item.status = "failed"; item.error = error instanceof Error ? error.message : String(error); }
        }
        if (tracking(ctx) !== run) return;
        results.push(item);
      }
      if (!results.length) return;
      const processed = await run.consume({ results }, ctx);
      if (processed && (processed.added.length || bodies.length)) run.evidence(
        [...bodies, ...processed.added].map(block => block.text).join("\n\n"));
      return;
    }
    if (!isMain(ctx) || message?.role !== "assistant") return;
    run.lastStopReason = message.stopReason;
    if (publicText(message.content)) updateStage(run.flow, "final", "running", message.content);
    paint(run, true);
  });

  pi.on("tool_call", (event, ctx) => {
    const run = tracking(ctx);
    if (!run || event.toolName !== "task") return;
    if (!isMain(ctx)) return { block: true, reason: "Terra 실행 Wave는 메인 세션이 직접 조정합니다. 자식은 재위임할 수 없습니다." };
    try {
      const input = run.aris ? prepareArisCall(run.aris, event.input) : event.input;
      const prepared = prepareWaveCall(run.flow, input);
      run.flow.activeWave = prepared.index;
      run.flow.nextWaveTask = prepared.nextName;
      // Reserve the whole admitted batch before another tool_call can pass the capacity/barrier check.
      for (const task of prepared.input.tasks ?? [prepared.input]) {
        expectNative(run.flow, task.agent || "task", task.name, { ...task, context: prepared.input.context, parentId: "final" });
      }
      run.paint(true);
      return { input: prepared.input };
    }
    catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
  });
  pi.on("before_subagent_spawn", (event, ctx) => {
    const run = tracking(ctx);
    if (run && (!isMain(ctx) || event.invocationKind !== "task")) return {
      block: true, reason: "Terra Wave의 위임은 메인 세션의 native task만 사용합니다. 재귀·eval·외부 대체 실행은 허용되지 않습니다.",
    };
    const policy = run?.aris ? arisSpawnPolicy(run.aris, event) : undefined;
    return policy;
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const run = tracking(ctx);
    if (!run) return;
    const parentId = parentRow(run, ctx);
    if (!parentId) return;
    const tasks = event.toolName === "task" ? event.args?.tasks ?? [event.args] : [];
    let changed = false;
    const ids = [];
    for (const task of tasks) {
      if (!task || typeof task.name !== "string" || !task.name) continue;
      const agent = typeof task.agent === "string" && task.agent ? task.agent : "task";
      changed = expectNative(run.flow, agent, task.name, { ...task, context: event.args?.context, parentId }) || changed;
      const row = knownJob(run, task.name);
      if (row) {
        ids.push(row.id);
        run.agentParents.set(task.name, { identity: ctx.agent?.id });
      }
    }
    run.toolCalls.set(callKey(ctx, event.toolCallId), {
      ids, parentId, tasks: tasks.map(task => ({ ...task, context: event.args?.context })), toolName: event.toolName,
      sessionId: ctx.sessionManager.getSessionId(),
    });
    if (changed) run.paint(true);
  });

  const nativeItems = details => [
    ...(Array.isArray(details?.results) ? details.results : []),
    ...(Array.isArray(details?.jobs) ? details.jobs : []),
    ...(details?.evalResult && typeof details.evalResult === "object" ? [details.evalResult] : []),
  ];

  function nativeUpdate(event, ctx, result, ended) {
    const run = tracking(ctx);
    const call = run?.toolCalls.get(callKey(ctx, event.toolCallId));
    if (!call) return;
    let changed = observeNative(run.flow, { ...result, details: scopedDetails(run, ctx, result?.details, call) });
    if (ended && event.isError) {
      const error = publicText(result?.content) || "native 호출 실패";
      for (const id of call.ids) changed = updateStage(run.flow, id, "failed", error) || changed;
    }
    if (changed && (ended || Date.now() - run.lastPaint >= 100)) run.paint(ended);
  }
  pi.on("tool_execution_update", (event, ctx) => nativeUpdate(event, ctx, event.partialResult, false));
  pi.on("tool_execution_end", (event, ctx) => nativeUpdate(event, ctx, event.result, true));

  for (const channel of ["task:subagent:progress", "task:subagent:lifecycle", "task:subagent:event"]) {
    const dispose = pi.events?.on(channel, payload => {
      const ctx = observedContext;
      const run = ctx && tracking(ctx);
      if (!run || !isRecord(payload)) return;
      if (channel === "task:subagent:event") {
        const row = knownJob(run, payload.id);
        if (!row || row.parentId !== parentRow(run, ctx)) return;
        const event = payload.event;
        if (!["message_update", "message_end"].includes(event?.type) || event.message?.role !== "assistant") return;
        const text = publicText(event.message.content);
        if (!text) return;
        const output = run.publicOutputs.get(payload.id) ?? { completed: [], current: "" };
        if (event.type === "message_end") { output.completed.push(text); output.current = ""; }
        else output.current = text;
        run.publicOutputs.set(payload.id, output);
        if (observeNative(run.flow, { details: { progress: [{
          id: payload.id, status: "running", publicOutput: [...output.completed, output.current].filter(Boolean).join("\n\n"),
        }] } })) {
          if (event.type === "message_end") run.paint(true);
          else if (Date.now() - run.lastPaint >= 100) run.paint(false);
        }
        return;
      }
      let call = run.toolCalls.get(callKey(ctx, payload.parentToolCallId));
      const id = channel === "task:subagent:progress" ? payload.progress?.id : payload.id;
      const known = knownJob(run, id);
      if (!call && !payload.parentToolCallId && known?.parentId === parentRow(run, ctx) &&
        run.agentParents.get(id)?.identity === ctx.agent?.id) {
        call = { toolName: "eval", parentId: known.parentId, tasks: [] };
      }
      if (!call || !["task", "eval"].includes(call.toolName)) return;
      const item = channel === "task:subagent:progress"
        ? { ...payload.progress, agent: payload.agent, task: payload.task, sessionFile: payload.sessionFile }
        : { id: payload.id, agent: payload.agent, status: payload.status === "started" ? "running" : payload.status,
          sessionFile: payload.sessionFile };
      const details = scopedDetails(run, ctx, { progress: [item] }, call);
      if (observeNative(run.flow, { details }) &&
        (channel === "task:subagent:lifecycle" || Date.now() - run.lastPaint >= 100)) {
        run.paint(channel === "task:subagent:lifecycle");
      }
    });
    if (dispose) observationSubscriptions.push(dispose);
  }
  /**
   * Detached reviewer envelopes that only preview the output are replaced by the published
   * `agent://<id>` document. Returns the rewritten details and the items that gained a full body.
   */
  async function hydrateDetails(run, details, sourceCtx) {
    const filled = [];
    const hydrate = async item => {
      const row = isRecord(item) && knownJob(run, item.id);
      const job = row?.jobs.find(candidate => candidate.id === item.id);
      if (!row || job?.resultReceived || job?.state === "cancelled") return item;
      // Rejected owned-model evidence is final; never read or publish its preview body.
      if ((row.review || row.worker) && job?.state === "failed") return item;
      if (row.review) {
        const result = await hydrateReview(item, id => readAgentOutput(id, sourceCtx));
        if (result !== item && typeof result.output === "string") filled.push(result);
        return result;
      }
      const reference = nativeReference(item);
      if (!reference && !item.truncated) return item;
      try {
        const output = publicText(await readAgentOutput(item.id, sourceCtx));
        if (!output.trim()) throw new Error("공개 출력이 비어 있습니다.");
        if (reference && !escapeHarnessTags(output).trimStart().startsWith(reference.preview.trim())) {
          throw new Error("공개 출력이 결과 미리보기와 일치하지 않습니다.");
        }
        return { ...item, output, truncated: false };
      } catch (error) {
        return { ...item, status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    };
    if (!isRecord(details)) return { details, filled };
    const hydrated = { ...details };
    if (Array.isArray(details.results)) hydrated.results = await Promise.all(details.results.map(hydrate));
    if (Array.isArray(details.jobs)) hydrated.jobs = await Promise.all(details.jobs.map(hydrate));
    if (isRecord(details.evalResult)) hydrated.evalResult = await hydrate(details.evalResult);
    return { details: hydrated, filled };
  }

  async function consumeResults(run, incoming, sourceCtx = run.ctx) {
    if (observeNative(run.flow, { details: incoming })) paint(run, true);
    const { details, filled } = await hydrateDetails(run, incoming, sourceCtx);
    // The read yielded: a stop, session move or new request may have ended this run meanwhile.
    if (executing(run.ctx) !== run) return;
    if (observeNative(run.flow, { details })) paint(run, true);
    // Tell the Brain, once per owned job, whether it counts; silence or failure is never acceptance.
    const notes = [];
    for (const item of nativeItems(details)) {
      const worker = run.flow.rows.find(candidate => candidate.worker === true && candidate.jobIds.includes(item?.id));
      if (worker && !run.workerNotes.has(item.id)) {
        const job = worker.jobs.find(candidate => candidate.id === item.id);
        if (job && !["pending", "running"].includes(job.state)) {
          run.workerNotes.add(item.id);
          if (job.state !== "completed") notes.push(`WORKER_UNAVAILABLE (job ${item.id}): ${worker.summary || job.state}. 이 작업을 완료했다고 주장하지 말고 미완료 범위를 최종 답변에 명시하세요.`);
        }
      }
      const row = run.flow.rows.find(candidate => candidate.review === true && candidate.jobIds.includes(item?.id));
      if (!row || run.reviewNotes.has(item.id)) continue;
      const job = row.jobs.find(candidate => candidate.id === item.id);
      if (!job || ["pending", "running"].includes(job.state)) continue;
      run.reviewNotes.add(item.id);
      const problem = job.state === "completed" ? undefined : (row.summary || reviewProblem(run.flow, item));
      if (!problem && recordReview(run.aris, item, row.model)) {
        notes.push(`검토 라운드 ${run.aris.reviews.length} 인정 (job ${item.id}, 모델 ${row.model}). 검토자의 지적은 자동 승인이 아닙니다: 각 지적에 근거로 응답하고, 후속 라운드는 다시 agent "${REVIEWER_AGENT}" task로 호출하세요. 이전 라운드 원문은 확장이 자동으로 덧붙입니다.`);
      } else {
        notes.push(`REVIEW_UNAVAILABLE (job ${item.id}): ${problem || "검토 결과를 인정할 수 없음"}. 이 라운드는 검토로 인정되지 않으며 자동 재시도하지 않습니다. 최종 답변에 검토 미완료를 명시하세요.`);
      }
    }
    // The executor saw only the preview: hand it the whole published output once, with this result.
    const bodies = filled.map(item => `검토 전문 (job ${item.id}, agent://${item.id}) — 아래가 검토자 공개 출력 전체입니다:\n${escapeHarnessTags(item.output)}`);
    const added = [...bodies, ...(notes.length ? [notes.join("\n")] : [])].map(text => ({ type: "text", text }));
    return { added, details };
  }

  pi.on("tool_result", async (event, ctx) => {
    const run = tracking(ctx);
    const call = run?.toolCalls.get(callKey(ctx, event.toolCallId));
    if (!call) return;
    nativeUpdate(event, ctx, { content: event.content, details: event.details }, true);
    const details = scopedDetails(run, ctx, event.details, call);
    const processed = await run.consume(details, ctx);
    if (!processed?.added.length) return;
    return { content: [...(event.content ?? []), ...processed.added], details: processed.details };
  });

  // Cancelled/failed runs stay visible, but never become execution advice.
  pi.on("context", event => {
    const completed = new Set(event.messages
      .filter(message => message.customType === CARD && message.details?.phase === "handoff")
      .map(message => message.details.runId));
    return { messages: event.messages.filter(message => message.customType !== CARD ||
      (completed.has(message.details?.runId) && ["handoff", "evidence"].includes(message.details?.phase))) };
  });

  pi.on("input", (event, ctx) => {
    if (!isMain(ctx) || !state.enabled || event.source === "extension" || event.text.trimStart().startsWith("/")) return;
    if (!event.text.trim() && !event.images?.length) return;
    // Native steering/queued follow-ups retain their semantics during execution.
    if (!ctx.isIdle() && !active) {
      ctx.ui.notify("실행 중 입력은 기존 omp로 전달합니다. 대화 모드는 대기 상태의 새 요청에 적용됩니다.", "info");
      return;
    }
    cancel("새 요청으로 대체되었습니다.");
    closeExplorer();
    interruptExecution("새 요청으로 이전 실행 화면의 추적을 종료했습니다.");
    try {
      assertModel(ctx, ROUTER.model, "router");
      assertModel(ctx, state.astra, "astra");
      validateArisInstall();
    } catch (error) {
      card(`**라우팅 준비 확인 필요 — 실행하지 않음**\n\n${error.message}`, { phase: "error" });
      ctx.ui.setEditorText(event.text);
      return { handled: true };
    }
    const run = {
      id: randomUUID(), ctx, controller: new AbortController(),
      sessionId: ctx.sessionManager.getSessionId(),
      text: event.text, images: [...(event.images ?? [])],
      context: collectContext(ctx.sessionManager.getBranch()),
      config: { ...state }, lastPaint: 0, toolCalls: new Map(), reviewNotes: new Set(), workerNotes: new Set(),
      agentParents: new Map(), publicOutputs: new Map(),
    };
    run.flow = createFlow(run.id, run.text);
    active = run;
    paint(run, true);
    card(`**자동 라우팅 요청**\n\n${event.text}\n\nTerra 6.1 xhigh → Astra 단독 / ARIS 검토 / ARIS 연구 · /dialogue stop 또는 Esc로 중단`, { runId: run.id, phase: "request" });
    // Input hooks have a 30s host budget. Return immediately; manage lifetime
    // ourselves instead of allowing timeout to dispatch the task prematurely.
    ctx.setTimeout(() => perform(run), 0);
    return { handled: true };
  });

  const installSummary = () => {
    try { const install = validateArisInstall(); return `ARIS: ${install.count}개 스킬 · commit ${String(install.commit).slice(0, 12)} · ${install.root}`; }
    catch (error) { return `ARIS 설치 문제: ${error instanceof Error ? error.message : String(error)}`; }
  };
  const describe = () => `**Dialogue ${state.enabled ? "AUTO (ON)" : "OFF"}**\n\nRouter: \`${ROUTER.model}\` · ${ROUTER.reasoning}\n${SELECTABLE_ROLES.map(role => `${ROLES[role].label} — ${ROLES[role].duty}: \`${state[role]}\` · ${ROLES[role].reasoning}`).join("\n")}\nWorker: \`${WORKER_AGENT}\` · 검토자: \`${REVIEWER_AGENT}\` · ${installSummary()} · /dialogue skills`;

  pi.registerCommand("dialogue", {
    description: "Terra 라우팅: Astra 단독 / Fable Brain → Opus Worker + Astra 독립 검토",
    getArgumentCompletions(prefix) {
      return ["models", "skills", "flow", "on", "off", "status", "stop", ...SELECTABLE_ROLES, "help"]
        .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    async handler(args, ctx) {
      if (!isMain(ctx)) return;
      const [action = state.enabled ? "off" : "on", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "help") { card(HELP, { phase: "status" }); return; }
      if (action === "stop") {
        cancel("/dialogue stop");
        await handoffTail;
        if (execution?.sessionId === ctx.sessionManager.getSessionId()) {
          const run = execution.run;
          endFlow(run, "cancelled", "사용자가 /dialogue stop으로 중단했습니다.");
          execution = undefined;
          if (!ctx.isIdle()) await ctx.abort();
        }
        return;
      }
      if (action === "status") {
        card(`${describe()}\n\n${active ? "라우팅·검토 진행 중" : execution ? `${ROLES[execution.role].label} 응답 진행 중` : "대기 중"}\n\n${HELP}`, { phase: "status" });
        return;
      }
      if (action === "flow") {
        await showFlow(ctx);
        return;
      }
      if (action === "skills") {
        const { install, problem } = arisReadiness(pi, ctx, state, validateArisInstall);
        let catalog = [];
        if (install) {
          try { catalog = getArisCatalog(); }
          catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
        }
        card(`**ARIS 스킬 ${catalog.length}개 — ${problem ? `실행 불가: ${problem}` : "실행 준비 완료"}**\n\n${installSummary()}\nBrain Fable: ${state.fable} · ${ROLES.fable.reasoning}\nWorker ${WORKER_AGENT} · Opus: ${state.opus} · ${ROLES.opus.reasoning}\n검토자 ${REVIEWER_AGENT} · Astra: ${state.astra} · ${ROLES.astra.reasoning}\n\n${catalog.map(skill =>
          `- \`${skill.name}\`${skill.name === DEFAULT_REVIEW_SKILL ? " (검토 기본값)" : ""} — ${String(skill.description ?? "").replace(/\s+/g, " ").trim()}`
        ).join("\n")}\n\nTerra는 요청에 필요한 스킬 1–4개만 선택합니다. Fable이 스킬 원문에 따라 분석·아이디어·계획·최종 종합을 맡고, 필요한 실행만 native ${WORKER_AGENT}(Opus)에 위임합니다. 독립 검토는 native ${REVIEWER_AGENT}(Astra)가 수행하며 모델과 출력이 확인된 라운드만 검토로 인정합니다. 계획·아이디어 요청은 실행 권한을 추가하지 않습니다.`,
        { phase: "status", skills: catalog.map(skill => skill.name), available: !problem, problem, install });
        return;
      }
      if (active && action !== "off") {
        ctx.ui.notify("먼저 /dialogue stop으로 현재 라우팅·검토를 중단하세요.", "warning");
        return;
      }
      try {
        if (action === "on" || action === "off") {
          if (rest.length) throw new Error(HELP);
          if (action === "on") {
            assertModel(ctx, ROUTER.model, "router");
            assertModel(ctx, state.astra, "astra");
            validateArisInstall();
          } else cancel("대화 모드를 껐습니다.");
          state.enabled = action === "on";
        } else if (action === "models") {
          if (rest.length) throw new Error("/dialogue models");
          if (!await pickModels(ctx, SELECTABLE_ROLES)) return;
        } else if (SELECTABLE_ROLES.includes(action)) {
          if (rest.length === 0) {
            if (!await pickModels(ctx, [action])) return;
          } else {
            if (rest.length !== 1) throw new Error(`/dialogue ${action} [provider/model]`);
            assertModel(ctx, rest[0], action);
            state[action] = rest[0];
          }
        } else throw new Error(HELP);
        persist(ctx);
        card(`${describe()}\n\n${state.enabled ? `Terra가 경로와 필요한 ARIS 스킬을 선택합니다. 일반 작업은 Astra 단독, 검토·연구 요청은 Fable Brain이 이끌며 Opus Worker가 실행하고 Astra가 독립 검토합니다. 실행·검토 단계에 추가 사용량이 발생합니다. /dialogue off로 해제합니다.` : "자동 라우팅을 끕니다. 현재 세션 모델은 유지하며 /model로 변경할 수 있습니다."}`, { phase: "status" });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
