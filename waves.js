// Terra plans execution stages, not recursive agent depth. The main session owns every barrier.
export const MAX_WAVES = 12;
export const MAX_WAVE_PARALLEL = 4;
const ID = /^[A-Z][A-Za-z0-9]{0,15}$/;
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function parseWaves(value) {
  if (!Array.isArray(value) || value.length > MAX_WAVES) throw new Error(`Terra must supply waves: an array of 0–${MAX_WAVES} execution stages; no request was executed.`);
  const ids = new Set();
  return value.map(wave => {
    if (!wave || typeof wave.id !== "string" || !ID.test(wave.id) || ids.has(wave.id) || !text(wave.title, 120) || !text(wave.goal, 1000) ||
      !Number.isInteger(wave.parallel) || wave.parallel < 1 || wave.parallel > MAX_WAVE_PARALLEL) {
      throw new Error("Invalid Terra Wave: unique CamelCase id (1–16 chars), title, goal and parallel (1–4) required; no request was executed.");
    }
    ids.add(wave.id);
    return { id: wave.id, title: wave.title.trim(), goal: wave.goal.trim(), parallel: wave.parallel };
  });
}

export function waveRows(flow, index) {
  return flow.rows.filter(row => row.wave === index + 2 && row.jobIds.length > 0);
}

export function waveComplete(flow, index) {
  const rows = waveRows(flow, index);
  return rows.length > 0 && rows.every(row => row.state === "completed" && row.jobs.length > 0 && typeof row.output === "string" && row.output.trim() &&
    row.jobs.every(job => job.state === "completed" && job.resultReceived === true));
}

export function unfinishedWaves(flow) {
  return (flow.waves ?? []).filter((_wave, index) => !waveComplete(flow, index)).map(wave => wave.id);
}

/** Validate the whole batch before the controller reserves names/capacity or advances a stage. */
export function prepareWaveCall(flow, input) {
  if (!flow.waves?.length) throw new Error("Terra selected main-session work without delegated Waves; do not spawn subagents.");
  if (!input || typeof input !== "object" || Array.isArray(input) || (input.tasks !== undefined && !Array.isArray(input.tasks))) throw new Error("Wave task input must be an object with an optional tasks array.");
  const batch = Array.isArray(input.tasks);
  const items = batch ? input.tasks : [input];
  if (!items.length) throw new Error("A Wave task batch must not be empty.");
  const active = flow.activeWave ?? 0;
  let nextName = flow.nextWaveTask ?? 1;
  const names = new Set(flow.rows.flatMap(row => row.jobIds));
  let selected;
  const tasks = items.map(item => {
    if (!item || typeof item !== "object" || !text(item.task, 1000000)) throw new Error("Each Wave task must contain a work packet.");
    let name = item.name;
    if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name))) throw new Error("Wave task names must be 1–32 letters, digits, underscores or hyphens, starting with a letter.");
    const prefix = name?.includes("__") ? name.split("__", 1)[0] : undefined;
    const index = prefix ? flow.waves.findIndex(wave => wave.id === prefix) : active;
    if (index < 0) throw new Error(`Unknown Terra Wave prefix: ${prefix}`);
    if (selected !== undefined && selected !== index) throw new Error("One task batch may contain only one Wave; wait for its results before starting the next.");
    selected = index;
    const wave = flow.waves[index];
    if (!name) {
      do { name = `${wave.id}__Task${nextName++}`; } while (names.has(name));
    }
    if (names.has(name)) throw new Error(`Wave task name already used: ${name}. Use a new name for another round.`);
    names.add(name);
    return { ...item, name, task: `${item.task}\n\n## Terra Wave ${index + 2}: ${wave.title}\n계획 목표: ${wave.goal}\n위 작업 패킷만 실행하세요. 다음 Wave와 모든 추가 에이전트 호출은 메인 세션이 담당합니다. 재위임, 외부 에이전트 대체 호출, 재귀 한도·설정 변경은 하지 마세요. 실제 산출물·공개 결과·실패를 메인 세션에 반환하세요.` };
  });
  if (selected < active) throw new Error("This Terra Wave is closed; later stages have already started.");
  if (selected > active + 1) throw new Error("Terra Waves cannot be skipped; execute the next planned stage.");
  if (selected > active && !waveComplete(flow, active)) throw new Error(`Wave ${active + 2} must finish successfully with full public results before Wave ${selected + 2} starts.`);
  const rows = waveRows(flow, selected);
  if (rows.some(row => ["failed", "cancelled", "interrupted", "skipped"].includes(row.state))) throw new Error("This Terra Wave has a failed or interrupted task; do not retry or advance automatically.");
  const live = rows.filter(row => row.state !== "completed" || row.jobs.some(job => !job.resultReceived)).length;
  if (live + tasks.length > flow.waves[selected].parallel) throw new Error(`Wave ${selected + 2} permits at most ${flow.waves[selected].parallel} concurrent tasks; wait for existing results.`);
  return { input: batch ? { ...input, tasks } : tasks[0], index: selected, nextName };
}

export function waveHandoff(waves) {
  return `## Terra 실행 Wave 계약\nWave 0=Terra 라우팅, Wave 1=당신(메인)의 조정·최종 답변, Wave 2부터=Terra가 정한 실행 단계입니다. Wave는 재귀 깊이가 아닙니다.\n${waves.length ? waves.map((wave, index) => `- Wave ${index + 2} [${wave.id}] ${wave.title}: ${wave.goal} (동시 최대 ${wave.parallel}개)`).join("\n") : "- 위임 Wave 없음: 직접 처리하고 서브에이전트를 호출하지 마세요."}\n1. 각 Wave의 구체 작업 패킷과 실제 파일·명령은 근거를 확인한 뒤 당신이 작성합니다. 같은 Wave의 독립 작업은 native task 한 배치로 병렬 실행하고, 의존하는 작업은 결과를 받은 뒤 실행합니다. 기존 역할·모델·스킬·사용자 권한 제약은 그대로 적용됩니다.\n2. 작업 이름은 <Wave ID>__<작업명> (총 32자 이하)을 사용하세요. 예: ${waves[0]?.id ?? "Inspect"}__Read. 이름에 접두사가 없으면 현재 Wave에 속합니다. 다음 Wave 접두사로 시작하는 첫 task가 단계 전환이며, 앞 Wave의 모든 작업이 성공하고 공개 결과 전문을 받은 뒤에만 허용됩니다. 실패·취소·미수신 결과를 성공으로 간주하거나 Wave를 건너뛰지 마세요.\n3. 모든 Wave의 task는 당신이 직접 호출하세요. 자식의 자식, eval agent()/workpool, 외부 에이전트 서비스로 우회하지 마세요. 자식에게는 재위임 금지를 전달합니다. 호스트 재귀 한도·전역 설정을 바꾸지 않습니다.\n4. 반복 검토·내부 루프는 해당 Wave 안에서 사용자·스킬의 종료 조건에 따라 새 이름으로 반복합니다. 종료한 Wave는 다시 열지 않습니다. 각 계획 Wave에서 실제 작업 결과가 최소 하나 필요하며, 실행되지 않은 Wave를 완료했다고 말하지 마세요. 이 계획은 추가 비용·설치·배포·수정 권한이 아닙니다.`;
}
