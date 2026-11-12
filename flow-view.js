// Data-only Terra execution Waves. Historical snapshots retain their observed delegation-depth layout.
// No model calls, timers or terminal controls from snapshot text enter this component.
import { theme as liveTheme, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";

const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])/g;
const ROLES = { router: "라우팅", solo: "단독", brain: "브레인", worker: "작업자", reviewer: "검토자" };
const STATES = {
  running: ["●", "accent", "실행 중"], completed: ["●", "success", "완료"],
  failed: ["!", "error", "실패"], cancelled: ["■", "warning", "취소"],
  interrupted: ["!", "warning", "중단"], skipped: ["−", "muted", "건너뜀"],
  planned: ["○", "dim", "예정"], optional: ["○", "dim", "필요 시"],
  unobserved: ["?", "warning", "미관측"], pending: ["○", "muted", "대기"],
};

function text(value) {
  if (typeof value !== "string") return "";
  return value.toWellFormed().replaceAll("\ufffd", "").replace(ANSI_RE, "")
    .replace(/\r\n?/g, "\n").replace(CONTROL_RE, "").replaceAll("\t", "  ");
}
function clean(value) { return text(value).replace(/\s+/g, " ").trim(); }
function state(node) { return STATES[node.row.state] ?? STATES.pending; }
function fit(value, width) { return truncateToWidth(value, Math.max(0, width), "", true); }
function shortModel(value) {
  const [selector, ...tail] = clean(value).split(" · ");
  const id = selector.replace(/^[^/\s]+\//, "").split("@")[0];
  const [base, effort] = id.split(":");
  const cap = word => word.charAt(0).toUpperCase() + word.slice(1);
  let name = base;
  let match;
  if ((match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(base))) name = `${cap(match[1])} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
  else if ((match = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)/i.exec(base))) name = `${cap(match[2])} ${match[1]}`;
  return [name, effort, ...tail].filter(Boolean).join(" ");
}
function name(node) {
  const row = node.row;
  return clean(row.name) || clean(row.taskName) ||
    (row.id !== "router" && row.id !== "final" ? clean(row.jobIds?.[0]) : "") ||
    clean(row.label) || clean(row.id) || "이름 미상";
}

// Only parentId and the documented legacy router -> final -> native relationship create edges.
// Broken/missing parents remain inspectable roots; cyclic links are not drawn as delegation.
function graph(snapshot) {
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const nodes = rows.filter(row => row && typeof row.id === "string")
    .map(row => ({ id: row.id, row, virtual: false, parent: undefined, depth: undefined }));
  function virtual(id, row) {
    const node = { id, row: { id, jobIds: [], jobs: [], ...row }, virtual: true, parent: undefined, depth: undefined };
    nodes.push(node);
    return node;
  }
  if (!nodes.some(node => node.id === "router")) virtual("router", {
    label: "요청 분류", role: "router", agent: "Terra", state: snapshot?.route === "pending" ? "planned" : "unobserved",
  });
  if (!nodes.some(node => node.id === "final")) virtual("final", {
    label: "실행 에이전트", parentId: "router", state: snapshot?.status === "running" ? "planned" : "unobserved",
  });
  for (const [index, wave] of (snapshot?.waves ?? []).entries()) {
    if (!rows.some(row => row.wave === index + 2)) virtual(`virtual:wave:${wave.id}`, {
      label: `${wave.id} · ${wave.title}`, wave: index + 2, task: wave.goal, parentId: null,
      state: snapshot.status === "running" ? "planned" : "unobserved",
    });
  }
  if (!snapshot?.waves && snapshot?.worker && snapshot.status === "running" && !rows.some(row => row.worker === true)) {
    virtual("virtual:worker", { label: `${clean(snapshot.worker.agent) || "aris-worker"} · 필요 시 위임`,
      role: "worker", parentId: "final", model: snapshot.worker.model, state: "optional" });
  }
  if (!snapshot?.waves && snapshot?.reviewer && snapshot.reviewRequired === true && !rows.some(row => row.review === true)) {
    virtual("virtual:reviewer", { label: `${clean(snapshot.reviewer.agent) || "aris-reviewer"} · 호출 대기`,
      role: "reviewer", parentId: "final", model: snapshot.reviewer.model,
      state: snapshot.status === "running" ? "planned" : "unobserved" });
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    const parentId = node.row.parentId === undefined
      ? node.id === "router" ? undefined : node.id === "final" ? "router" : "final"
      : node.row.parentId;
    node.parentId = parentId;
    if (typeof parentId === "string" && byId.has(parentId)) node.parent = byId.get(parentId);
  }
  function depth(node, visiting = new Set()) {
    if (node.depth !== undefined) return node.depth;
    if (visiting.has(node)) {
      node.parent = undefined;
      node.relationNote = "순환 parentId: 깊이를 확인할 수 없어 루트로 표시";
      return (node.depth = 0);
    }
    visiting.add(node);
    const parentDepth = node.parent ? depth(node.parent, visiting) : -1;
    if (node.depth === undefined) node.depth = parentDepth + 1;
    visiting.delete(node);
    return node.depth;
  }
  nodes.forEach(node => {
    depth(node);
    node.wave = Number.isInteger(node.row.wave) ? node.row.wave : node.depth;
  });
  const waves = [];
  for (const node of nodes) (waves[node.wave] ??= []).push(node);
  for (const node of nodes) node.predecessors = snapshot?.waves && node.wave >= 2
    ? waves[node.wave - 1] ?? [] : node.parent ? [node.parent] : [];
  return { nodes: waves.flat(), waves, byId };
}
function counts(nodes) {
  const observed = nodes.filter(node => !node.virtual);
  return { total: observed.length, done: observed.filter(node => node.row.state === "completed").length,
    live: observed.filter(node => node.row.state === "running").length,
    failed: observed.filter(node => node.row.state === "failed").length,
    virtual: nodes.length - observed.length };
}
function waveLabel(nodes, depth, width) {
  const n = counts(nodes);
  return width < 24
    ? `Wave ${depth} ${n.done}/${n.total}${n.live ? ` ▶${n.live}` : ""}${n.failed ? ` !${n.failed}` : ""}${n.virtual ? ` ○${n.virtual}` : ""}`
    : `Wave ${depth} · ${n.done}/${n.total} 완료${n.live ? ` · ${n.live} 실행` : ""}${n.failed ? ` · ${n.failed} 실패` : ""}${n.virtual ? ` · ○${n.virtual}` : ""}`;
}
function duration(row, snapshot) {
  if (!Number.isFinite(row.startedAt)) return "";
  const end = Number.isFinite(row.finishedAt) ? row.finishedAt : snapshot.updatedAt;
  if (!Number.isFinite(end)) return "";
  return `${Math.max(0, Math.floor((end - row.startedAt) / 1000))}s`;
}
function card(node, width, selected, uiTheme, snapshot) {
  const [symbol, color, label] = state(node);
  const border = selected ? "accent" : node.virtual ? "dim" : node.row.state === "failed" ? "error" : "borderMuted";
  const inner = Math.max(0, width - 4);
  const edge = value => uiTheme.fg(border, "│") + " " + fit(value, inner) + " " + uiTheme.fg(border, "│");
  const who = [ROLES[node.row.role] || clean(node.row.role), shortModel(node.row.model) || clean(node.row.agent)].filter(Boolean).join(" · ");
  const summary = clean(node.row.summary) || clean(node.row.task) || (node.virtual ? "가상 경로 · 실행 근거 아님" : "공개 요약 없음");
  return [
    uiTheme.fg(border, `┌${"─".repeat(Math.max(0, width - 2))}┐`),
    edge(uiTheme.fg(selected ? "accent" : color, `${selected ? "›" : symbol} ${name(node)}`)),
    edge(uiTheme.fg(color, `${label}${node.virtual ? " · 가상" : ""}${duration(node.row, snapshot) ? ` · ${duration(node.row, snapshot)}` : ""}`)),
    edge(uiTheme.fg("muted", who || "모델 미관측")),
    edge(uiTheme.fg(node.row.state === "failed" ? "error" : "dim", summary)),
    uiTheme.fg(border, `└${"─".repeat(Math.max(0, width - 2))}┘`),
  ];
}
function compactCard(node, width, selected, uiTheme, snapshot) {
  const [symbol, color, label] = state(node);
  return [
    fit(uiTheme.fg(selected ? "accent" : color, `${selected ? "›" : ""}${symbol} ${name(node)}`), width),
    fit(uiTheme.fg(color, `  ${label}${node.virtual ? " · 가상" : ""} · ${shortModel(node.row.model) || clean(node.row.agent) || "모델 미관측"}${duration(node.row, snapshot) ? ` · ${duration(node.row, snapshot)}` : ""}`), width),
    fit(uiTheme.fg("dim", `  ${clean(node.row.summary) || clean(node.row.task) || (node.virtual ? "가상 경로 · 실행 근거 아님" : "공개 요약 없음")}`), width),
  ];
}
function nodeLine(node, width, selected, uiTheme, showWave = false) {
  const [symbol, color, label] = state(node);
  return fit(uiTheme.fg(selected ? "accent" : color,
    `${selected ? "›" : ""}${symbol} ${showWave ? `W${node.wave} ` : ""}${label}${node.virtual ? " ○" : ""} · ${name(node)}`), width);
}
function wrap(value, width) {
  return text(value).split("\n").flatMap(line => line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]);
}

/**
 * @param {() => object | undefined} getSnapshot
 * @param {import("@oh-my-pi/pi-tui").Theme | undefined} theme
 * @param {{interactive?: boolean, getHeight?: () => number,
 * requestRender?: () => void, onClose?: () => void, readOutput?: (row: object) => Promise<string>}} options
 */
export function createFlowView(getSnapshot, theme, options = {}) {
  const interactive = options.interactive === true;
  let selectedId;
  let details = false;
  let scroll = 0;
  let detailLength = 0;
  let pageSize = 1;
  let columnStart = 0;
  let listOffset = 0;
  let boardMode = "list";
  let boardPageSize = 1;
  let closed = false;
  let loadToken = 0;
  let loaded;
  let loading = false;
  let loadError = "";
  const offsets = new Map();

  function current() {
    const snapshot = typeof getSnapshot === "function" ? getSnapshot() : undefined;
    const data = graph(snapshot);
    if (!data.byId.has(selectedId)) {
      selectedId = data.nodes.find(node => node.row.state === "failed")?.id ||
        data.nodes.find(node => node.row.state === "running")?.id || data.nodes[0]?.id;
      scroll = 0;
      loaded = undefined;
    }
    return { snapshot, ...data, selected: data.byId.get(selectedId) };
  }
  function repaint() { options.requestRender?.(); }
  function close() {
    if (closed) return;
    closed = true;
    loadToken++;
    options.onClose?.();
  }
  function readDetails(node, refresh = false) {
    const token = ++loadToken;
    loaded = undefined;
    loadError = "";
    loading = false;
    if (!node || node.virtual || !node.row.jobIds?.length || typeof options.readOutput !== "function") return;
    if (node.row.output && !refresh) return;
    loading = true;
    const originalOutput = node.row.output;
    // A reader failure is UI evidence only; never change the recorded run or public output.
    Promise.resolve().then(() => options.readOutput(node.row)).then(value => {
      if (closed || token !== loadToken) return;
      loaded = { id: node.id, originalOutput, value: text(value) };
    }).catch(error => {
      if (!closed && token === loadToken) loadError = clean(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!closed && token === loadToken) { loading = false; repaint(); }
    });
  }
  function select(node) {
    if (!node || node.id === selectedId) return;
    selectedId = node.id;
    scroll = 0;
    if (details) readDetails(node);
  }
  function bodyLines(data, width) {
    const { snapshot, selected: node } = data;
    if (!node) return ["관측된 노드 없음"];
    const row = node.row;
    const lines = [];
    const section = (title, value) => {
      if (!text(value)) return;
      if (lines.length) lines.push("");
      lines.push(`[${title}]`, ...wrap(value, width));
    };
    section("노드", `${name(node)}\nID: ${clean(node.id)}\nWave ${node.wave} · ${snapshot?.waves ? "Terra 실행 단계" : "위임 깊이"}${!node.virtual ? `\n실제 위임 깊이: ${node.depth}` : ""}\n상태: ${state(node)[2]} (${clean(row.state)})${node.virtual ? "\n예정 경로: 호출/완료 근거가 아닙니다." : ""}`);
    const planned = snapshot?.waves?.[node.wave - 2];
    if (planned) section("Terra Wave 계획", `${planned.id} · ${planned.title}\n${planned.goal}\n동시 최대 ${planned.parallel}개${node.wave > 2 ? ` · Wave ${node.wave - 1}의 성공·공개 결과 수신 후 시작` : ""}`);
    section("에이전트 / 모델", [clean(row.agent), clean(row.role), clean(row.model) || "정확한 모델 미관측"].filter(Boolean).join("\n"));
    section("실제 위임 관계", node.virtual ? "호출 전: 실제 부모 관계 미관측" : node.parent ? `${name(node.parent)} (${clean(node.parent.id)}) → ${name(node)} (${clean(node.id)})` : node.relationNote ||
      (node.parentId ? `부모 ${clean(node.parentId)} 미관측 · 관계를 그리지 않음` : "루트 · 관측된 부모 없음"));
    const timestamp = value => Number.isFinite(value) ? new Date(value).toISOString() : "미관측";
    section("관측 시각", `시작: ${timestamp(row.startedAt)}\n종료: ${timestamp(row.finishedAt)}`);
    if (row.jobIds?.length) section("Native 작업", row.jobIds.map(id => {
      const job = row.jobs?.find(item => item.id === id);
      return `${clean(id)}${job ? ` · ${clean(job.state)}${job.model ? ` · ${clean(job.model)}` : ""}` : ""}`;
    }).join("\n"));
    section("작업 / 공유 문맥", row.task);
    const result = loaded?.id === node.id && loaded.originalOutput === row.output && loaded.value ? loaded.value : row.output;
    section("공개 출력", result || "전체 공개 출력 미관측");
    if (row.summary && text(row.summary) !== text(result)) section("요약", row.summary);
    if (loading) section("출력 읽기", "게시된 Native 출력 읽는 중…");
    if (loadError) section("출력 읽기 오류", loadError);
    section("원본 사용자 요청", snapshot?.request);
    section("라우팅 이유", snapshot?.reason);
    section("실행 메모", snapshot?.note);
    return lines;
  }

  function renderDetails(data, width, height, uiTheme) {
    const title = uiTheme.fg("accent", `‹ Wave ${data.selected?.wave ?? 0} · ${data.selected ? name(data.selected) : "상세"}`);
    const body = bodyLines(data, width);
    pageSize = Math.max(1, height - 2);
    detailLength = body.length;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, body.length - pageSize)));
    const help = width < 32 ? "↑↓ Pg End Esc< qX"
      : width < 55 ? "↑↓/Pg Home/End Esc back q close"
      : `↑↓/PgUp/PgDn 스크롤 · Home/End 처음/끝 · Tab 다음 · Enter 재읽기 · Esc 카드 · q 닫기  ${scroll + 1}-${Math.min(body.length, scroll + pageSize)}/${body.length}`;
    if (height === 1) return [fit(body[scroll] || "", width)];
    if (height === 2) return [fit(body[scroll] || "", width), fit(uiTheme.fg("muted", help), width)];
    return [fit(title, width), ...body.slice(scroll, scroll + pageSize).map(line => fit(line, width)),
      ...Array(Math.max(0, pageSize - body.slice(scroll, scroll + pageSize).length)).fill(""), fit(uiTheme.fg("muted", help), width)].slice(0, height);
  }

  function renderBoard(data, width, height, uiTheme) {
    const { snapshot, waves, selected } = data;
    const n = counts(data.nodes);
    const status = clean(snapshot?.status) || "기록 없음";
    const header = width < 48
      ? `Flow ${n.done}/${n.total} ▶${n.live} !${n.failed} · ${status}`
      : `Agent Flow · ${status} · ${n.done}/${n.total} 완료${n.live ? ` · ${n.live} 실행` : ""}${n.failed ? ` · ${n.failed} 실패` : ""}`;
    const meaning = snapshot?.waves
      ? width < 48 ? "Wave=Terra 실행 단계 · ○예정" : "Wave = Terra 실행 단계 · W2+ 순차 · 연결=진행 순서 · 실제 부모는 상세"
      : width < 48 ? "Wave=위임 깊이 · ○가상" : "Wave = 위임 깊이 (이전 기록) · 연결=parentId · ○ 가상은 완료 집계 제외";
    const headerSize = height >= 7 ? 2 : height >= 4 ? 1 : 0;
    const footerSize = height >= 4 ? 2 : height >= 2 ? 1 : 0;
    const boardHeight = height - headerSize - footerSize;
    const out = [];
    if (headerSize) out.push(fit(uiTheme.bold(uiTheme.fg("accent", header)), width));
    if (headerSize > 1) out.push(fit(uiTheme.fg("dim", meaning), width));
    let visible = 0;
    let viewport = "";

    // Narrow and very short displays use one stable, all-node list, not one focus per wave.
    // The widget starts at the first node; only explicit inspector navigation moves a viewport.
    boardMode = width < 64 || boardHeight < 2 ? "list" : "waves";
    if (boardMode === "list") {
      boardPageSize = boardHeight;
      const index = data.nodes.findIndex(node => node.id === selectedId);
      if (interactive && index >= 0) {
        if (index < listOffset) listOffset = index;
        if (index >= listOffset + boardHeight) listOffset = index - boardHeight + 1;
      }
      listOffset = Math.max(0, Math.min(interactive ? listOffset : 0, Math.max(0, data.nodes.length - boardHeight)));
      const shown = data.nodes.slice(listOffset, listOffset + boardHeight);
      visible = shown.length;
      viewport = `노드 ${listOffset + 1}-${listOffset + visible}/${data.nodes.length}`;
      for (const node of shown) {
        const prefix = height === 1 ? `${listOffset + 1}/${data.nodes.length} ` : "";
        out.push(fit(prefix + nodeLine(node, Math.max(0, width - prefix.length), interactive && node.id === selectedId, uiTheme, true), width));
      }
    } else {
      const gap = 4;
      const capacity = Math.max(1, Math.floor((width + gap) / 22));
      const columnCount = Math.min(waves.length, capacity);
      if (interactive && selected) {
        if (selected.wave < columnStart) columnStart = selected.wave;
        if (selected.wave >= columnStart + columnCount) columnStart = selected.wave - columnCount + 1;
      }
      columnStart = Math.max(0, Math.min(interactive ? columnStart : 0, waves.length - columnCount));
      const cardWidth = Math.floor((width - gap * (columnCount - 1)) / columnCount);
      const largestWave = Math.max(...waves.slice(columnStart, columnStart + columnCount).map(nodes => nodes.length));
      // Prefer screenshot-like cards; shed metadata before hiding any names.
      const density = largestWave * 7 <= boardHeight ? "full"
        : 1 + largestWave * 3 <= boardHeight ? "compact" : "line";
      const stride = density === "full" ? 7 : density === "compact" ? 3 : 1;
      const maxCards = Math.max(1, Math.floor((boardHeight - 1 + (density === "full" ? 1 : 0)) / stride));
      boardPageSize = maxCards;
      const columns = [];
      const positions = new Map();
      for (let col = 0; col < columnCount; col++) {
        const depth = columnStart + col;
        const all = waves[depth];
        let offset = interactive ? offsets.get(depth) || 0 : 0;
        const index = all.findIndex(node => node.id === selectedId);
        if (interactive && index >= 0) {
          if (index < offset) offset = index;
          if (index >= offset + maxCards) offset = index - maxCards + 1;
        }
        offset = Math.max(0, Math.min(offset, Math.max(0, all.length - maxCards)));
        offsets.set(depth, offset);
        const shown = all.slice(offset, offset + maxCards);
        visible += shown.length;
        const label = shown.length < all.length
          ? `Wave ${depth} ${offset + 1}-${offset + shown.length}/${all.length} ↕`
          : waveLabel(all, depth, cardWidth);
        const lines = [fit(uiTheme.fg("muted", label), cardWidth)];
        for (const node of shown) {
          const active = interactive && node.id === selectedId;
          positions.set(node.id, { col, y: lines.length + (density === "full" ? 2 : 0) });
          if (density === "full") lines.push(...card(node, cardWidth, active, uiTheme, snapshot), " ".repeat(cardWidth));
          else if (density === "compact") lines.push(...compactCard(node, cardWidth, active, uiTheme, snapshot));
          else lines.push(nodeLine(node, cardWidth, active, uiTheme));
        }
        columns.push(lines);
      }
      viewport = `Wave ${columnStart}-${columnStart + columnCount - 1}/${waves.length} · 노드 ${visible}/${data.nodes.length}`;
      // Planned runs connect stage predecessors; legacy runs connect actual parents. Details retain both.
      const gutters = Array.from({ length: Math.max(0, columnCount - 1) }, () =>
        Array.from({ length: boardHeight }, () => Array(gap).fill(0)));
      const H = 1, V = 2;
      for (const node of data.nodes) for (const predecessor of node.predecessors) {
        const from = positions.get(predecessor.id), to = positions.get(node.id);
        if (!from || !to || to.col !== from.col + 1) continue;
        const cells = gutters[from.col];
        for (let x = 0; x <= 1; x++) if (cells[from.y]) cells[from.y][x] |= H;
        for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y++) if (cells[y]) cells[y][1] |= V;
        for (let x = 1; x < gap; x++) if (cells[to.y]) cells[to.y][x] |= H;
      }
      for (let y = 0; y < boardHeight; y++) {
        let line = "";
        for (let col = 0; col < columnCount; col++) {
          line += fit(columns[col][y] || "", cardWidth);
          if (col < columnCount - 1) line += uiTheme.fg("success", gutters[col][y].map(cell => cell === H ? "─" : cell === V ? "│" : cell ? "┼" : " ").join(""));
        }
        out.push(fit(line, width));
      }
    }
    while (out.length < height - footerSize) out.push("");
    const hidden = data.nodes.length - visible;
    const position = `${viewport}${hidden ? ` · 숨김 ${hidden}` : ""}${interactive && selected ? ` · › ${name(selected)}${selected.parent ? ` ← ${name(selected.parent)}` : ""}` : ""}`;
    const footer = interactive
      ? width < 32 ? "↑↓ Tab PgUp/Dn Enter q/Esc" : width < 64 ? "↑↓/Tab PgUp/Dn Home/End · Enter 상세 · q/Esc" : "↑↓ 같은 Wave · ←→ Wave · Tab/PgUp/PgDn · Home/End · Enter 상세 · Esc/q (실행 유지)"
      : "/dialogue flow · 모든 노드/전체 출력";
    if (footerSize > 1) out.push(fit(uiTheme.fg("muted", position), width));
    if (footerSize) out.push(fit(uiTheme.fg("dim", footerSize === 1
      ? `${interactive ? viewport : "/dialogue flow"}${hidden ? ` +${hidden}` : ""}${interactive ? " · PgUp/Dn Enter q/Esc" : ""}`
      : footer), width));
    return out.slice(0, height);
  }

  return {
    render(width) {
      if (closed) return [];
      width = Math.max(1, Math.floor(width) || 1);
      const data = current();
      if (!data.snapshot && !interactive) return [];
      const available = Math.max(1, Math.floor(options.getHeight?.() ?? process.stdout.rows ?? 24) || 1);
      const height = interactive ? available : Math.min(18, Math.max(1, Math.floor(available * 0.65)));
      return details ? renderDetails(data, width, height, theme ?? liveTheme) : renderBoard(data, width, height, theme ?? liveTheme);
    },
    invalidate() {}, // Every render reads the live snapshot, including in-place updates.
    handleInput(input) {
      if (!interactive || closed) return;
      const data = current();
      const is = key => matchesKey(input, key);
      if (is("q")) { close(); return; }
      if (is("escape")) {
        if (details) { details = false; loadToken++; loading = false; }
        else close();
        repaint();
        return;
      }
      if (is("enter")) {
        const refresh = details;
        if (!details) { details = true; scroll = 0; }
        readDetails(data.selected, refresh);
      } else if (is("tab") || is("shift+tab")) {
        const index = data.nodes.findIndex(node => node.id === selectedId);
        const step = is("shift+tab") ? -1 : 1;
        select(data.nodes[(index + step + data.nodes.length) % data.nodes.length]);
      } else if (details && (is("up") || is("down") || is("pageUp") || is("pageDown") || is("home") || is("end"))) {
        const delta = is("up") ? -1 : is("down") ? 1 : is("pageUp") ? -pageSize : pageSize;
        scroll = is("home") ? 0 : is("end") ? Math.max(0, detailLength - pageSize) : Math.max(0, Math.min(scroll + delta, Math.max(0, detailLength - pageSize)));
      } else if (data.selected && (is("left") || is("right"))) {
        const wave = data.waves[data.selected.wave + (is("left") ? -1 : 1)];
        if (wave?.length) {
          const index = data.waves[data.selected.wave].indexOf(data.selected);
          select(wave[Math.min(index, wave.length - 1)]);
        }
      } else if (data.selected && (is("pageUp") || is("pageDown"))) {
        const pool = boardMode === "list" ? data.nodes : data.waves[data.selected.wave];
        const index = pool.indexOf(data.selected);
        const step = is("pageUp") ? -1 : 1;
        if (boardMode === "waves" && (step < 0 ? index === 0 : index === pool.length - 1)) {
          const wave = data.waves[data.selected.wave + step];
          if (wave?.length) select(wave[step < 0 ? wave.length - 1 : 0]);
        } else {
          if (boardMode === "list") listOffset = Math.max(0, listOffset + step * boardPageSize);
          else offsets.set(data.selected.wave, Math.max(0, (offsets.get(data.selected.wave) || 0) + step * boardPageSize));
          select(pool[Math.max(0, Math.min(pool.length - 1, index + step * boardPageSize))]);
        }
      } else if (data.selected && (is("up") || is("down"))) {
        const pool = boardMode === "list" ? data.nodes : data.waves[data.selected.wave];
        const index = pool.indexOf(data.selected);
        select(pool[Math.max(0, Math.min(pool.length - 1, index + (is("up") ? -1 : 1)))]);
      } else if (is("home")) select(data.nodes[0]);
      else if (is("end")) select(data.nodes[data.nodes.length - 1]);
      repaint();
    },
    dispose() { closed = true; loadToken++; },
  };
}
