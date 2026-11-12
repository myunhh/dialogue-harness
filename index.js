import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { registerDialogue } from "./controller.js";
import { runModelTurn } from "./transport.js";
import { createFlowView } from "./flow-view.js";
import { getArisCatalog, loadArisSkills, validateArisInstall } from "./aris-skills.js";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Read a subagent's published final output through the host's own `agent://` resolver, exactly as
 * the `read` tool would, but whole: no line paging. Only a published document counts; the handler's
 * progress view of a still-running agent, a superseded output or a JSON-path value is refused.
 */
export async function readAgentOutput(id, ctx) {
  if (!AGENT_ID.test(id)) throw new Error(`agent id 형식이 올바르지 않음: ${id}`);
  const resource = await InternalUrlRouter.instance().resolve(`agent://${id}`, {
    cwd: ctx.cwd,
    sessionFile: ctx.sessionManager.getSessionFile?.() ?? undefined,
    sessionId: ctx.sessionManager.getSessionId(),
  });
  const notes = Array.isArray(resource.notes) ? resource.notes : [];
  if (!resource.sourcePath || resource.shape === "value" || notes.length) {
    throw new Error(`agent://${id}: 게시된 최종 출력이 아님${notes.length ? ` (${notes.join("; ")})` : ""}`);
  }
  return resource.content;
}

export default function agentDialogue(pi) {
  registerDialogue(pi, runModelTurn, createFlowView, { getArisCatalog, loadArisSkills, validateArisInstall }, readAgentOutput);
}
