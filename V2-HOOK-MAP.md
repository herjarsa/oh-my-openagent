# Phase 0 gate — V1 → V2 mapping table

Sources: `packages/omo-opencode/src/plugin-interface.ts` (12 handlers) +
`src/testing/create-plugin-module.ts` (+2) @ beta.90; `@opencode/plugin@2.0.16`
tarball (`dist/promise/*.d.ts`); official v2 plugin docs; proven bridge in
`omo-meta-governor@0.50.1` `src/v2/` (verified loading on this machine's
2.0.16 server).

Statuses: **DIRECT** = same pattern as meta-governor (copy + adapt) ·
**ADAPT** = V2 target exists, needs new adapter code · **GAP** = no V2
equivalent found, needs design or explicit defer · **SKIP** = not needed.

## Handlers (`createPluginInterface`)

| # | V1 handler | V2 target | Status | Notes |
|---|---|---|---|---|
| 1 | `tool` (12–38 ToolDefinitions) | `ctx.tool.transform` → `editor.add` | DIRECT | Needs zod→JSON-Schema conversion (same as MG `v2-tools.ts`). Config-gated tools (team/monitor/goal/hashline) re-evaluated per setup; `reload()` after config change. |
| 2 | `tool.definition` | `ctx.tool.transform` → `editor.update` | DIRECT | MG bridges description write-back; parameter-schema mutations apply in place. Ours is `todo-description-override` — same shape. |
| 3 | `tool.execute.before` | `ctx.tool.hook("execute.before")` | DIRECT | Live-view pattern (`output.args` getter/setter → `e.input`); rethrow preserves block semantics. |
| 4 | `tool.execute.after` | `ctx.tool.hook("execute.after")` | DIRECT | Completed/error → V1 `(input, outputView)` view; never throw (guarded). |
| 5 | `experimental.chat.system.transform` | `ctx.session.hook("context")` (system part) | DIRECT | String-backed view over text SystemParts, positional write-back (MG proven). Covers ultrawork injection, rules-injector, keyword-detector, status injectors. |
| 6 | `experimental.chat.messages.transform` | same `context` hook (messages part) | DIRECT | V1-shaped VIEW copy (never push V1 objects into host array); appended messages translated to V2 assistant messages. Covers context-injector, pair-validator, mailbox injector. |
| 7 | `experimental.session.compacting` | `ctx.session.hook("compaction")` | DIRECT | `output.context[]` lines → text SystemParts; `prompt` override has no V2 field → fold to system (best-effort, logged). Covers compaction-context-injector + todo-preserver. |
| 8 | `chat.message` (first-message gate, keyword detect, session setup) | `ctx.session.hook("prompt")` | ADAPT | `prompt.text/files/agents/skills` mutable draft + `delivery`. First-message variant logic portable; verify `sessionID`/`agent` availability matches V1 `input` fields. |
| 9 | `chat.params` (model fallback, variant, think mode, effort) | `ctx.session.hook("context")` (`options`) + `retry` | ADAPT | `options` mutable per call; model itself is readonly in context. Proactive fallback (variant/effort/temperature) → options; reactive fallback (provider errors) → `retry` hook (`event.decision`). Split the current handler accordingly. |
| 10 | `chat.headers` (Copilot `x-initiator`) | `ctx.session.hook("model.request")` (`headers`) | DIRECT | Trivial draft mutation, provider-scopable. |
| 11 | `command.execute.before` (slash interception) | — | GAP | MG explicitly skipped: no V2 hook, `CommandEditor` has `add` only. OMO's own commands (goal, refactor, ulw-execute…) can re-register via `editor.add` with wrapped `execute`. Interception of *foreign* commands likely impossible → defer or WONT-PORT per command. |
| 12 | `event` (session lifecycle, team events ×4, openclaw dispatch, fallback) | `ctx.event.subscribe` (AsyncIterable) | ADAPT | Event catalog (`V2EventEncoded`) lives outside the plugin SDK — enumerate from docs/API before coding. Team wake-hints + openclaw need dispatch via `ctx.session.prompt` (exists ✓). Must avoid double-delivery (MG skipped its event hook as redundant — ours is NOT redundant, it carries session/team lifecycle). |
| 13 | `experimental.compaction.autocontinue` | — | GAP | MG skipped (no equivalent). OMO auto-resume after compaction needs a design (poll `session.wait`? event-watch?) or explicit deferral. |
| 14 | `config` (6-phase pipeline) | `provider/agent/tool/skill/command/mcp/model` transforms | ADAPT | **Top risk.** No `config` domain. Each phase maps to a transform: providers→`provider.transform`, agents→(see gap below), tools→`tool.transform`, MCPs→`mcp.transform` (`set`/`update`), commands→`command.transform`, models→`model.transform`. The pipeline currently runs as ONE handler with ordering guarantees; V2 replays transforms per-domain in registration order — phase ordering must be re-established explicitly in `setup()`. |
| 15 | `tool` map disposal / `dispose` | setup `Cleanup` return | DIRECT | Dispose V2 registrations first, then V1 dispose (MG order). |

## Cross-cutting gaps (ranked)

1. **Agent registration — CLOSED 2026-09-25 (proven live on 2.0.16).**
   `editor.update(id, def)` acts as **upsert**: a new id is created and shows
   up in server-level `debug agents` (`spike-probe-nonexistent` verified).
   File-based agents (`.opencode/agents/*.md`) ALSO work (`spike-file`
   verified). Chosen path: **update-upsert from `setup()`** — no disk state,
   and disposing our transform registration rebuilds the registry without our
   agents (free cleanup). Phase 1 PROVEN end-to-end 2026-09-25: `sisyphus`
   upserted from live `omo.jsonc` appears in server-level `debug agents`
   with `model: {providerID: "opencode-go", id: "muse-spark-1.3-contributor"}`.
   Full V2-shaped definitions (system/permissions/steps) remain Phase 4 work.
2. **`config` pipeline ordering** (see #14). Spike with providers+models first
   (smallest state), then agents/tools/MCPs.
3. **Per-session skill-embedded MCPs.** V2 `mcp.transform` `set()` looks global;
   OMO keys Tier-3 clients per `${sessionID}:${skill}:${server}`. Check
   session-scoping support or accept global-with-namespacing.
4. **`chat.params` model switching.** If context-hook `model` is readonly and
   `retry` only covers failures, proactive model override needs another path
   (`switchModel`? model transforms?). Spike during Phase 2.
5. **TUI sidebar** (`tui.sidebar.enabled`) → separate `./tui` export surface.
   Defer to Phase 5; server plugin must load without it.
6. **V2 API churn.** 2.0.16 is early V2 (`experimental.ws.*` may move). Pin
   `@opencode/plugin@2.0.16`; re-verify `agent.d.ts` on every SDK bump.

## Explicit non-goals for the port
- `experimental.provider.small_model`, permission flows OMO doesn't use.
- Chasing upstream betas (pinned beta.90 per `V2-PORT.md`).

## Phase 1 entry criteria (all must hold)
- [x] Agent-registration spike green (gap #1 closed: `editor.update` upsert proven live; file-based fallback proven).
- [x] `config` phase → transform mapping drafted per phase (gap #2, table row #14).
- [x] Dual-export scaffold compiles against both SDKs (`@opencode-ai/plugin`
      1.18.31 + `@opencode/plugin` 2.0.16) with zero changes to V1 behavior.

## Phase 1 exit (2026-09-25, all green live on 2.0.16)
- `plugin list`: ID `oh-my-openagent` registered (local probe build).
- `debug agents`: `sisyphus` present with live `omo.jsonc` model.
- `translate-agent.test.ts` 4/4, `tsgo --noEmit` clean, V1 export-shape test green.
- Trap found: editor path requires `Model.Ref` `{providerID, id}` — the docs'
  expanded `{providerID, model}` form is rejected server-side.

## Phase 2a exit (2026-09-25, live on 2.0.16)
- Full V1 factory boots inside V2 `setup()` with the adapted client:
  all 15 hook keys present, zero factory failures.
- `tool.execute.before/after` bridged (2 registrations); setup ready.
- V1 hooks execute live code paths (degraded `todo`/`status` stubs hit by
  background polling — logged, harmless; real mapping is Phase 2b work).
  Note: `status` is polled in a hot loop — the real port must quiet that log.
- No NEW `failed to load plugin` lines (only the pre-existing V1 globals).
- `sisyphus` still visible in `debug agents` after restart.

## Phase 2b exit (2026-09-25, live on 2.0.16)
- `chat.message` → `session.prompt` hook bridged (`v2_bridge_chat_registered`;
  pure view builders unit-tested).
- `event` → `event.subscribe` loop bridged (`v2_bridge_event_subscribed`);
  V2→V1 type map covers created/deleted/idle/status/execution.failed→error/
  message.content.updated→message.updated; `message.removed` has NO V2
  equivalent (dropped + counted). Abort on cleanup; per-event guards.
- Degraded `todo`/`status`/`toast` logs quieted (first + every 50th).
- 16/16 plugin-v2 tests green, `tsgo` clean, no new failed-load lines.

## Phase 2c exit (2026-09-25, live on 2.0.16)
- `chat.params` → `context` hook (live options view + scalar write-back).
- system+messages transforms → shared `context` hook; `compacting` hook;
  `tool.definition` via `tool.transform`; `chat.headers` → `model.request`.
- Setup ready with 7 bridges, zero bridge failures; full V2 event
  vocabulary enumerated via first-only drop logs.
- 20/20 plugin-v2 tests green, `tsgo` clean, `sisyphus` visible post-restart.

## Phase 4 exit (2026-09-25, live on 2.0.16)
- Full V1 agent factory (`createBuiltinAgents`) + stage-2 assembly
  (`buildPrometheusAgentConfig`, `createSisyphusJuniorAgentWithOverrides`)
  run in `setup()`; all resolved agents upserted with description, mode,
  model (`Model.Ref`), color, steps, system prompt and deny-rules.
- Server-level `debug agents`: **10 OMO agents** (all except hephaestus,
  gated by the user's own muse-spark chain — V1 logs the identical skip).
- 26/26 plugin-v2 tests green, `tsgo` clean.

## Phase 3 exit (2026-09-25, live on 2.0.16)
- Full V1 tool map registered via `tool.transform`: **27/27, 0 failures**
  (`v2_toolmap_registered`). zod→JSON Schema through `z.toJSONSchema`;
  execute adapted (V1 context from V2 signal + setup directory; `ask()`
  throws descriptive unsupported; failures surface as error content).
- 24/24 plugin-v2 tests green, `tsgo` clean, `sisyphus` visible, no new
  failed-load lines. Execution smoke (real tool call) deferred — needs a
  live session with token cost; structural registration is proven.
