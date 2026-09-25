# V2 port — QA evidence (Phases 0–5)

Branch: `feat/opencode-v2-port` (base: upstream `v5.0.0-beta.90`).
Target host: OpenCode `2.0.16` (SDK `@opencode/plugin@2.0.16`), Windows 11.
Live probe: local path plugin in a Temp scratch project re-exporting
`packages/omo-opencode/src/plugin-v2/index.ts`; user config is the live
`~/.omo/omo.jsonc`. The 1.18 CLI install (published `beta.90` cache) was
never touched — no V1 regression surface.

## Unit gates (per phase, all green at push time)

| Phase | Suite | Result |
|---|---|---|
| 1 | `plugin-v2/translate-agent.test.ts` | 4/4 |
| 2a | + `v1-input.test.ts`, `v1-client.test.ts` | 9/9 |
| 2b | + `hook-bridge-chat.test.ts`, `hook-bridge-events.test.ts` | 16/16 |
| 2c | (no new test files; bridges covered by above) | 16/16 |
| 3 | + `tool-bridge-register.test.ts` | 24/24 |
| 4 | (translator extension covered in translate tests) | 26/26 |
| 5 | + `mcp-bridge-register.test.ts` | 28/28 |

Typecheck: `tsgo --noEmit -p packages/omo-opencode/tsconfig.json` clean at
every commit. V1 `index.export-shape.test.ts` green (V1 entry untouched).

## Live gates (2.0.16 server, `service restart` + `debug agents` + `plugin list`)

- `plugin list`: ID `oh-my-openagent` registered (local probe); the global
  V1 `oh-my-openagent@beta` keeps failing with the pre-existing
  `effect`/`setup` schema error (unchanged, expected).
- `debug agents`: 10 OMO agents
  (atlas, explore, librarian, metis, momus, multimodal-looker, oracle,
  prometheus, sisyphus, sisyphus-junior) + 6 builtins. hephaestus absent by
  user config (muse-spark chain fails the GPT-family gate — V1 logs the
  identical skip on 1.18, see `oh-my-opencode.log` "unsupported Hephaestus
  model"). Full parity by construction (same factory, same config).
- Setup log markers observed (Temp spike log): `v2_setup_start`,
  `v2_factory_booted` (all 15 hook keys), `v2_bridge_{before,after,params,
  context,compaction,tooldef,headers,chat}_registered`,
  `v2_bridge_event_subscribed`, `v2_setup_ready` with 7 bridges.
- `v2_tools_registered` count 27 failed 0, with full name inventory
  (12 always-on + team×12 + look_at, interactive_bash, edit; goal/monitor/
  task_* correctly absent per config gates).
- `v2_mcp_registered` per location config (e.g. websearch/grep_app/lsp;
  user-disabled context7 honored).
- `v2_agent_upserted` / `v2_agents_upserted` with names (8 factory + 2
  assembly).
- Traps found live: (1) agent editor has no `add` — `update()` upserts;
  (2) agent model must be `Model.Ref` `{providerID, id}` — the docs'
  `{providerID, model}` form is rejected server-side.
- No NEW `failed to load plugin` lines at any phase (only pre-existing V1
  globals).

## Hot-loop observation
`session.status` is polled in a tight loop by V1 background machinery; the
degraded stub is quieted (first + every 50th). The real port should map it
or keep the throttle.

## Explicitly deferred (with reasons in V2-HOOK-MAP.md)
Builtin slash `commands` (add-only editor, no interception surface),
Tier-3 per-session skill MCPs (V2 scope looks global), TUI sidebar
(separate `./tui` surface), `doctor` (CLI-side), tool execution smoke
(needs a live session with token cost — structural registration proven).

## NOT upstream-ready
Spike markers remain: hardcoded Temp log path, `SPIKE_LOG` file logger,
probe-only `omo-v2-probe` wiring, degraded stubs. Upstream PR requires a
hardening pass (real logger, remove hardcoded paths, full package suite).
