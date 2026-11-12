# Changelog

## 4.4.0 — 2026-11-12

- Terra now designs ordered execution Waves alongside routing: stage ID, title, bounded goal and parallelism. Main-only work uses an empty plan; the router selects useful topology rather than a fixed number of stages.
- Gate native task admission on the plan: reserve names/capacity before dispatch, require successful full public results before advancing, reject skipped/closed/mixed stages and automatic continuation after failure. Keep iterative skill rounds inside their stage.
- Execute all stages from the main session without changing recursion settings. Refuse recursive/eval agent bypasses; preserve ARIS model pinning, independent review and native result validation.
- Render planned versus observed execution stages separately, retain actual parent/depth in details, and preserve historical depth-based snapshots. Unexecuted stages cannot count as successful completion.
- Verify 81 targeted cases (78 initially, then 3 corrected existing fixtures/assertions). One live Terra decision designed four stages; actual TUI navigation, output details and narrow layout used explicitly synthetic worker events. No remote deployment or worker-model execution is implied.

## 4.3.1 — 2026-11-11

- Show all observed task/eval subagents, including generic agents, generated names and nested descendants. Bind child factories to admitted host job/session identities; retain real parent relationships and reject unrelated or stale run events.
- Track generic automatic delivery and full public results arriving after lifecycle completion. Preserve shared task context, pinned ARIS evidence checks and terminal failures. Use eval's reserved host spawn key when lifecycle events omit their parent tool-call ID.
- Adapt Wave cards to compact cards or one-line nodes before paging. Narrow displays show an all-node list; board PageUp/PageDown, range indicators and existing selection/detail keys make offscreen nodes reachable while the input widget stays bounded.
- Keep live public output updates without persisting a whole flow snapshot on every streamed token.
- Verify 69 flow/controller cases: 67 passed initially, then both corrected cases passed targeted reruns. Exercise 112 renderer dimensions/modes and a real OMP 18.18.8 TUI with synthetic 12-sibling and nested event replay; no paid workflow execution is implied.

## 4.3.0 — 2026-11-11

- Replace the tree-only flow with bounded Wave card columns and known-parent connectors. Wave means delegation depth, not chronological dependencies; planned/optional nodes remain outside observed completion counts.
- Open a full-screen keyboard explorer with `/dialogue flow`: select any node, inspect exact models/jobs/parents/timestamps/public task input and full output, scroll long details, and close without cancelling execution. Update the open view on live events and adapt to narrow terminals.
- Retain full public text and observed transition times in additive flow fields. Exclude private thinking/tool blocks, preserve old records without inventing evidence, and freeze interrupted history at its last known observation.
- Read a known native job's published output only when missing or explicitly refreshed; late reads cannot update a closed or replaced inspector. Keep native model validation, review evidence and existing cancellation semantics.
- Verify 61 flow/controller tests, 28 renderer dimensions and the actual OMP 18.18.8 TUI with synthetic events, long-output navigation, live failures and resizing. Fix a one-column wide-character overflow found by the renderer smoke. No new model inference or remote deployment.

## 4.2.1 — 2026-11-10

- Pin Astra to `max` for both ordinary work and native independent review, as requested. Keep Fable `high`, Opus `medium` and Terra `xhigh` unchanged.
- Require `max` support before enabling or executing Dialogue; do not downgrade reasoning or substitute another model.
- Verify ordinary-executor effort, native reviewer spawn enforcement, unsupported-effort rejection and observed reviewer effort in the targeted controller/runtime tests.

## 4.2.0 — 2026-11-10

- Use Fable 5.2/high as the ARIS Brain for analysis, ideas, work packets and final synthesis; delegate concrete execution to native `aris-worker` on Opus 5.5/medium. Keep Astra/high as the independent read-only reviewer and ordinary-work executor. Preserve Terra's model, xhigh effort and route policy.
- Add role-specific instructions grounded in provider guidance, a three-role atomic picker and `/dialogue fable`. Restore state v4; add Fable to older state and migrate the previous built-in Opus 4.6 selector to 5.5 while preserving custom selectors.
- Show Brain/Worker/reviewer responsibility and short model versions in Agent Flow; keep exact provider/model and native job details in expanded mode. Optional Worker and required planned review are not completion evidence. Validate observed Worker models and retain per-job state.
- Handle native `async-result` delivery as well as task/wait results. Associate only observed jobs and native model metadata, read their published output, retain review continuity and report unavailable results without claiming acceptance. Prevent late output reads from reviving stopped runs.
- Pass 60 targeted contract tests and, after the automatic-delivery fix, 37 controller tests including three new regressions. Real OMP 18.18.6 completes a synthetic Fable → Opus Worker → Astra review → Fable workflow. Verify the actual TUI and 24 render combinations at 20/40/80/120 columns. Preserve the initial incomplete-flow evidence; no real performance experiment or remote deployment.

## 4.1.0 — 2026-11-05

- Replace the bottom step list with a connected Terra → executor → delegated-job graph. Show required reviewer branches as planned before invocation; planned nodes do not count as observed evidence. Track each native job separately, including same-agent siblings and default tasks.
- Keep active/queued/failed nodes visible in compact mode, show failure diagnostics without expanding, and preserve model/job/public-output details in expanded mode. Fit Korean labels and explicit state badges at narrow widths.
- Fix false reviewer failures for long detached results delivered as `<preview full-output="agent://…">`: fetch the same job's published full output through the host resolver, validate the preview prefix, and deliver the entire review to the current executor and subsequent rounds. Preserve model, empty-output, read-failure, cancellation and stale-run checks; add no retry or model fallback. Keep quoted harness tags escaped in model-facing text without changing the stored public output.
- Accept native `<meta …/>` before short detached output and retain the actual read failure in REVIEW_UNAVAILABLE diagnostics. Late previews cannot erase a validated review's public summary.
- Verify 69 regression tests, a real OMP 18.16 native-resolver smoke with a 2,202-line/144,143-character synthetic published review, and the actual TUI. Check 72 compact/expanded render cases at 20/40/80/120 columns. No new model inference is claimed by this smoke.

## 4.0.1 — 2026-11-04

- Make Terra automatically choose ARIS for experiment/training/evaluation execution, batched or dependent jobs, monitoring and autonomous overnight improvement, even without naming ARIS or a skill. Resolve short follow-ups against recent context.
- Allow the appropriate internal loop or end-to-end pipeline for autonomous multi-stage work instead of always preferring a single-stage workflow. Preserve planning-only, negation, ordinary-edit and policy-edit boundaries; missing environment details remain ARIS prerequisites rather than a solo fallback.
- Keep existing execution permissions and native reviewer behavior unchanged. No scheduler, experiment or remote deployment is started by this configuration update.
- Verify ten real Terra xhigh routing scenarios and 58 regression tests. Remove a mock/prompt-wording test rather than pinning the new prompt text.

## 4.0.0 — 2026-11-04

- Replace the RH role-pairing pipeline with ARIS skill-driven Opus execution and a read-only native Astra reviewer. Preserve 27 retired agent definitions and the old pairing protocol outside active discovery; existing immutable 3.1.1 remains recoverable.
- Vendor 87 upstream base skills, shared references, helpers, templates and licenses at commit `2927b40b2ea37774de53763338c5e8f91a7601e6`. Ship the complete pack through the existing immutable official plugin installer, preserving executable helpers.
- Add `/dialogue skills`; block enabling and new requests when the pack is incomplete. Terra selects installed skills, whose full text is applied before dispatch. Remove `/dialogue agents` and the old generic panel/RH route contracts.
- Adapt reviewer transport to OMP native task without claiming upstream MCP/Copilot acceptance. Pin the reviewer to the selected Astra model; carry validated prior public rounds into subsequent tasks. Preserve user scope, cancellation, model selection and compaction behavior.
- Require resolved model identity and real output before a review counts. Handle detached wait `resultText` envelopes, including the native follow-up footer; lifecycle-only completion never substitutes for or invalidates a delivered result.
- Keep execution completion distinct from scientific validation. Preserve source skill text; optional external-service dependencies are not automatically installed.

## 3.1.1 — 2026-11-03

- Preserve shared context and every first-batch proposal task body in one frozen research packet before rewriting child assignments. Later calls cannot replace it or leak peer output into independent proposals.
- Keep native research tracking and the frozen packet across in-place session compaction. Continue cancelling pre-handoff consultations; session navigation, explicit stop and shutdown retain their invalidation behavior.
- Reproduce both regressions before the fix and pass all 63 tests afterward. A real OMP method-critic run with the packet moved into task bodies completed six native stages and Agent Flow 9/9; both children received identical complete assignments.
- Diagnose aica-1 read-only: the reported Opus interruption followed an explicit coordinator kill after input loss. A separate run lost tracking at compaction. Invalid structured output remains a failure; no automatic retry or fabricated completion was added. Remote deployment is not part of this fix.

## 3.1.0 — 2026-11-03

- Route scientific questions by research stage and available evidence while keeping ordinary research-software edits on the engineering path. Preserve explicit Astra/Opus request priority and the existing role/call budget.
- Require synthesis claims to retain `observed|inferred|proposed` status and limitations through ratification and final output. Model agreement and repeated use of the same source never imply empirical proof or replication.
- Replace string basis references with exact completed `{step_id, locator}` references; validate every entry, not just one matching substring. Require nonblank verdict reasons.
- Preserve evidence-grounded discriminating checks, including supporting and weakening outcomes, separately as unratified, unapproved, unexecuted proposals even when there is no consensus. Strengthen provenance, confound, leakage and comparison audits without expanding tool permissions.
- Pass 61 regression tests, four real Terra routing cases and a complete six-task paired method-critic run. Final output retained two classified accepted claims with limitations, five disagreements, three uncertainties and one proposed check.
- Internal synthesis schema changes require installing code and agent definitions together; no compatibility shim or reinterpretation of historical results.

## 3.0.1 — 2026-11-03

- Give explicit requests for simultaneous Astra/Opus work priority over the solo default, even for routine tasks and short follow-ups. Preserve research-role routing and distinguish policy edits, mentions and negations from execution requests.
- Verify six real Terra routing scenarios and all 59 existing regression tests. Keep the existing paired execution protocol unchanged.

## 3.0.0 — 2026-11-03

- Replace per-role model/effort pins and the separate GPT/Claude reviewer settings with two shared Astra/Opus selectors. Preserve existing Astra/Opus branch choices; remove obsolete commands and state keys.
- Let Terra choose 1–4 specialist roles, then execute every selected role independently on both models through native task. Freeze the common packet, enforce exact scheduled identities/models and require actual validated outputs before dependent stages.
- Cross-redteam both proposals, draft candidate claims with Astra and require explicit Opus accept/dispute verdicts. Preserve draft disagreements and uncertainties; support no agreement without inventing claims or forcing endless debate.
- Track role × model, peer review, draft and ratification separately in Agent Flow. Display validated detached-job summaries and distinguish execution completion from consensus.
- Pass 59 regression cases. Complete a real Terra → paired `rh-critic-method` → crossreviews → synthesis → agreement run: six valid native outputs on exactly three Astra and three Opus tasks, one final answer, no model-facing visualization messages.

## 2.2.0 — 2026-11-02

- Add a theme-aware, width-safe Agent Flow widget for Terra routing, solo execution, independent panel stages and selected research specialists; show agents, models, progress and public routing reasons.
- Add `/dialogue flow` to expand/collapse public output summaries and actual native job IDs. Keep completed/cancelled views visible and restore branch-local snapshots; historical running work becomes interrupted, not live.
- Track native pending/running/completed/failed/cancelled metadata, resolved models and efforts. Do not mistake dispatch, background waiting or uninvoked specialists for completion; reject stale-run updates and preserve terminal failure evidence.
- Keep visualization strictly UI-only: no extra model calls, queued messages, private thinking or tool arguments. Avoid sending completion cards during `agent_end`, which can otherwise trigger another model turn.
- Pass 44 regression tests. Verify real TUI solo/deep completion, explicit cancellation, reload restoration and honest native provider-capacity failure; do not report the failed specialist as a successful execution.

## 2.1.0 — 2026-11-02

- Import 24 active Research Harness specialist definitions, including separate overlap, method and experiment critics; retain their prompts, exact models, tool restrictions and output schemas.
- Normalize the source `thinking-level` header to OMP's `thinkingLevel` and opt each agent into structured output; record original source hashes in the routing catalog.
- Add Terra's `research` route with 1–4 distinct registered agent names. Astra prepares role-specific inputs, invokes native task specialists and synthesizes results without an extra general panel.
- Add `/dialogue agents`; stop before handoff when native task, a selected name, its authenticated model or required reasoning level is unavailable.
- Package `agents/` and the catalog in the immutable plugin installation. Do not copy the RH runtime, gate automation, experiments, global settings or credentials.
- Pass 35 regression tests. Verify discovery/readiness for all 24 roles and a real Terra → Astra → `rh-critic-method` xhigh → Astra completion.

## 2.0.0 — 2026-11-02

- Route each enabled, idle external request with exact `openai-codex/gpt-6.1-terra` at required `xhigh`; ordinary work goes directly to Astra, while ideas and high-level reviews use the panel.
- Replace alternating rounds with independent same-input GPT/Claude proposals, independent cross-redteams, Astra synthesis and a normal-session Opus final review/output. There is no extra executor after Opus.
- Add Astra/Opus role selectors and four-role atomic model menus. Migrate 1.x session choices to version-2 state; remove the obsolete `turns` setting and command.
- Select the actual session executor through the public model API without changing global defaults. Preserve native tools and steering; serialize model transitions against replacement requests and session navigation.
- Abort sibling consultations on failure; reject invalid router responses, unsupported required effort and wrong model lineages without fallback. Verify 33 regression cases and real routing, file execution, staged review and TUI cancellation.

## 1.1.0 — 2026-11-02

- Add `/dialogue models` to select authenticated Claude and GPT models from role-specific menus, with the current model shown first.
- Open a single-role picker with `/dialogue claude` or `/dialogue gpt`; keep exact provider/model arguments supported.
- Commit paired selections together and retain existing settings on cancellation, unavailable models, stale session responses or concurrent setting changes.
- Keep existing session-state compatibility and preserve the separately configured main OMP model.

## 1.0.0 — 2026-11-02

- Add opt-in `/dialogue` mode with authenticated Claude↔GPT alternating consultation and one handoff to the existing OMP executor.
- Stream visible responses above the editor; persist speaker-labeled turns in the current session without exposing private reasoning.
- Preserve per-session mode, exact model choices and bounded turn count; keep new sessions and subagents opt-out.
- Cancel on Escape, explicit stop, replacement input, session navigation and shutdown; fail closed on provider/model errors and incomplete output.
- Exclude unsuccessful consultation from executor context and bound shared recent-history text.
- Install through official plugin linking into independent content-addressed user directories; leave upstream code, global settings and credentials unpatched.
