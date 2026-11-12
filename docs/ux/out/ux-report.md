# UX report: gogo-fpga

**verdict: pass** (pass 30, fail 0, unknown 0)

## Elements

- personas: 3
- jobs: 8
- journeys: 3 (17 stages)
- statecharts: 2
- surfaces: 5

## Top ODI opportunities

- `first_blink` — opportunity 15
- `understand_errors` — opportunity 15
- `ask_ai` — opportunity 12
- `assign_pins` — opportunity 12
- `flash_safely` — opportunity 12

## Game-design lens

- experience loops: 2 (avg length 4.5)
- feedback: 12 (text=6, visual=6)
- surfaces without feedback: openrouter, project_store, tang_nano, tool_workers
- onboard stages: 4, recover stages: 1

## Review lens (advisory)

- advisory records: 0 (malformed: 0)
- findings by severity: info=0, minor=0, major=0
- reconciliation: corroborated=0, contradicted=0, unverifiable=0
- images without a review record: 0
- intake records: 0 (declared 0, unobserved 24)
  - declared but never observed: ai_chat, ai_consent, ai_context_preview, ai_diff, ai_disconnect, board_select, build_progress, build_summary, editor, formal_run, openrouter_auth, pin_table, problem_list, project_list, save_status, sim_run, support_check, template_open, tool_download, usb_permission, waveform, write_progress, write_result, zip_export

## Liaison lens

- requests: 0 (answered 0, open 0, mismatched 0)
- states: open=0, answered=0, mismatched=0, stale=0, broken=0, blocked=0, circular=0
- response statuses: accepted=0, in_progress=0, done=0, rejected=0, deferred=0, needs_info=0
- open user questions: 0
- rejected/deferred high-risk requests: none
- orphan responses: 0, malformed files: 0

## Innovation lens

- underserved jobs: first_blink, understand_errors
- appropriate jobs: ask_ai, assign_pins, flash_safely, iterate_design
- overserved jobs: keep_projects, verify_before_write
- uncovered underserved jobs: none
- bold proposals: 0 (blocked: none)
- core experience: ブラウザーを開くだけで、書いた回路が手元の Tang Nano で動く

## Checks

- [pass] `statechart.design_flow.single_initial` — initial states: ['editing']
- [pass] `statechart.design_flow.states_defined`
- [pass] `statechart.design_flow.reachability`
- [pass] `statechart.design_flow.no_dead_end`
- [pass] `statechart.design_flow.deterministic`
- [pass] `statechart.design_flow.state_surface_declared`
- [pass] `statechart.ai_connection.single_initial` — initial states: ['disconnected']
- [pass] `statechart.ai_connection.states_defined`
- [pass] `statechart.ai_connection.reachability`
- [pass] `statechart.ai_connection.no_dead_end`
- [pass] `statechart.ai_connection.deterministic`
- [pass] `statechart.ai_connection.state_surface_declared`
- [pass] `journey.first_session.surfaces_declared`
- [pass] `journey.first_session.pain_points_recorded`
- [pass] `journey.daily_work.surfaces_declared`
- [pass] `journey.daily_work.pain_points_recorded`
- [pass] `journey.ai_help.surfaces_declared`
- [pass] `journey.ai_help.pain_points_recorded`
- [pass] `journey.onboarding_present` — onboard stages: arrive, choose_board, start_template, connect_ai
- [pass] `jobs.three_dimensions`
- [pass] `opportunity.coverage`
- [pass] `opportunity.stage_links`
- [pass] `feedback.surface_declared`
- [pass] `feedback.trigger_known`
- [pass] `feedback.latency_budget`
- [pass] `hig.target_size` — no undersized controls
- [pass] `hig.contrast` — no low-contrast controls
- [pass] `loop.steps_known`
- [pass] `loop.closes`
- [pass] `core_experience.non_empty`
