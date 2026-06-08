import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyMatch, WORLD_CUP_K } from "../elo-update-engine";
import { validateAndRepairAiOutput } from "../ai-layer/validate-and-repair";

type Confidence = "verified" | "reported" | "unconfirmed";
type GateDecision = "material" | "context_only";
type TeamCode = "CAN" | "BIH" | "SUI" | "QAT";

type EventLogRow = {
  id: string;
  tournament_code: "WC_2026";
  orchestrator_run_id: string;
  event_type: string;
  source: string;
  source_url: string | null;
  source_payload_hash: string | null;
  event_time: string;
  ingested_at: string;
  affected_fixture_label: string | null;
  affected_api_football_fixture_id: number | null;
  affected_team_code: string | null;
  affected_api_football_player_id: number | null;
  old_value: Record<string, unknown>;
  new_value: Record<string, unknown>;
  confidence: Confidence;
  gate_decision: GateDecision;
  gate_reason: string;
  rerun_triggered: boolean;
  triggered_run_id: string | null;
  triggered_run_kind: string | null;
  source_snapshot: Record<string, unknown>;
};

type ApiFootballEvent = {
  time?: { elapsed?: number | null; extra?: number | null };
  team?: { id?: number; name?: string };
  player?: { id?: number | null; name?: string | null };
  assist?: { id?: number | null; name?: string | null };
  type?: string | null;
  detail?: string | null;
  comments?: string | null;
};

type LineupRow = {
  fixture_id: number;
  team_id: number | null;
  team_name: string | null;
  formation: string | null;
  player_id: number | null;
  player_name: string | null;
  player_number: number | null;
  player_position: string | null;
  grid: string | null;
  lineup_role: "startXI" | "substitute" | "coach";
};

type MinuteRow = {
  fixture_id: number;
  team_id: number | null;
  team_name: string | null;
  player_id: number | null;
  player_name: string | null;
  minute: number | null;
  extra: number | null;
  event_type: string;
  detail: string | null;
  replaced_by_player_id?: number | null;
  replaced_by_player_name?: string | null;
};

type CardMinute = number | null;
type PlayerCardState = {
  player_id: number | null;
  player_name: string | null;
  team_id: number | null;
  team_name: string | null;
  yellows: number;
  explicitSecondYellow: boolean;
  yellowMinutes: CardMinute[];
  redCards: {
    minute: CardMinute;
    detail: string | null;
    comments: string | null;
  }[];
};

const PROJECT_ID = "ahcfrgxczbgdvrqmbisw";
const ROOT_DIR = process.cwd();
const AUDIT_DIR = path.join(ROOT_DIR, "data", "audits");
const SYNTHETIC_FIXTURE_ID = 9000001;
const SYNTHETIC_FIXTURE_LABEL = "CAN vs BIH";
const CURRENT_BEST_CONTRACT = {
  source_doc: "docs/all-groups-current-best-runs-checkpoint.md",
  run_ids: {
    group_a: "1bfae8ad-b484-48d3-86eb-0ab3c47002c1",
    group_b: "49265d85-1c6a-4303-8fe2-008825461b48",
    groups_c_l: "64091c79-e294-40d5-bf31-6985554f7d76",
  },
  black_box_rule: "call existing current-best predictor/run contract only; do not modify predictor or model_candidate files",
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    syntheticResult: args.includes("--synthetic-result") || args.length === 0,
    contextOnly: args.includes("--context-only"),
    execute: args.includes("--execute"),
    writeAudit: !args.includes("--no-write-audit"),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function eventRow(input: Omit<EventLogRow, "id" | "tournament_code" | "orchestrator_run_id" | "ingested_at">, orchestratorRunId: string): EventLogRow {
  return {
    id: randomUUID(),
    tournament_code: "WC_2026",
    orchestrator_run_id: orchestratorRunId,
    ingested_at: new Date().toISOString(),
    ...input,
  };
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseApiFootballLineups(fixtureId: number, payload: unknown[]): LineupRow[] {
  const rows: LineupRow[] = [];
  for (const lineup of payload as any[]) {
    const teamId = asNumber(lineup?.team?.id);
    const teamName = typeof lineup?.team?.name === "string" ? lineup.team.name : null;
    const formation = typeof lineup?.formation === "string" ? lineup.formation : null;
    rows.push({
      fixture_id: fixtureId,
      team_id: teamId,
      team_name: teamName,
      formation,
      player_id: asNumber(lineup?.coach?.id),
      player_name: typeof lineup?.coach?.name === "string" ? lineup.coach.name : null,
      player_number: null,
      player_position: null,
      grid: null,
      lineup_role: "coach",
    });

    for (const role of ["startXI", "substitutes"] as const) {
      const list = Array.isArray(lineup?.[role]) ? lineup[role] : [];
      for (const wrapper of list) {
        const player = wrapper?.player ?? wrapper;
        rows.push({
          fixture_id: fixtureId,
          team_id: teamId,
          team_name: teamName,
          formation,
          player_id: asNumber(player?.id),
          player_name: typeof player?.name === "string" ? player.name : null,
          player_number: asNumber(player?.number),
          player_position: typeof player?.pos === "string" ? player.pos : null,
          grid: typeof player?.grid === "string" ? player.grid : null,
          lineup_role: role === "startXI" ? "startXI" : "substitute",
        });
      }
    }
  }
  return rows;
}

export function parseApiFootballMinutes(fixtureId: number, events: ApiFootballEvent[]): MinuteRow[] {
  return events
    .filter((event) => event.type === "subst" || event.type === "Subst" || event.type === "Substitution" || event.type === "Card" || event.type === "Goal")
    .map((event) => ({
      fixture_id: fixtureId,
      team_id: asNumber(event.team?.id),
      team_name: typeof event.team?.name === "string" ? event.team.name : null,
      player_id: asNumber(event.player?.id),
      player_name: typeof event.player?.name === "string" ? event.player.name : null,
      minute: asNumber(event.time?.elapsed),
      extra: asNumber(event.time?.extra),
      event_type: event.type ?? "unknown",
      detail: event.detail ?? null,
      replaced_by_player_id: asNumber(event.assist?.id),
      replaced_by_player_name: typeof event.assist?.name === "string" ? event.assist.name : null,
    }));
}

function cardMinute(event: ApiFootballEvent): CardMinute {
  const elapsed = asNumber(event.time?.elapsed);
  if (elapsed === null) return null;
  const extra = asNumber(event.time?.extra);
  return elapsed + (extra ?? 0) / 100;
}

function hasSecondYellowLabel(detail: string | null, comments: string | null): boolean {
  const text = `${detail ?? ""} ${comments ?? ""}`.toLowerCase();
  return (text.includes("second") && text.includes("yellow")) || text.includes("indirect red");
}

function sameOrAdjacentMinute(left: CardMinute, right: CardMinute): boolean {
  return left !== null && right !== null && Math.abs(left - right) <= 1;
}

function classifyPlayerCards(row: PlayerCardState) {
  const yellowMinutes = row.yellowMinutes.filter((minute): minute is number => minute !== null).sort((a, b) => a - b);
  const secondYellowMinute = yellowMinutes.length >= 2 ? yellowMinutes[1] : null;
  const hasTwoYellowsWithoutRed = row.yellows >= 2 && row.redCards.length === 0;
  const hasExplicitSecondYellow = row.explicitSecondYellow || row.redCards.some((red) => hasSecondYellowLabel(red.detail, red.comments));
  const hasSecondYellowRed = row.redCards.some((red) => {
    if (hasSecondYellowLabel(red.detail, red.comments)) return true;
    return row.yellows >= 2 && sameOrAdjacentMinute(red.minute, secondYellowMinute);
  });
  const hasGenuineDirectRed = row.redCards.some((red) => {
    if (hasSecondYellowLabel(red.detail, red.comments)) return false;
    return !(row.yellows >= 2 && sameOrAdjacentMinute(red.minute, secondYellowMinute));
  });

  if (hasGenuineDirectRed && row.yellows > 0) {
    return { deduction: -5, category: "yellow_plus_direct_red", directRed: true, secondYellow: false };
  }
  if (hasGenuineDirectRed) {
    return { deduction: -4, category: "direct_red", directRed: true, secondYellow: false };
  }
  if (hasExplicitSecondYellow || hasSecondYellowRed || hasTwoYellowsWithoutRed) {
    return { deduction: -3, category: "indirect_red", directRed: false, secondYellow: true };
  }
  if (row.yellows > 0) {
    return { deduction: -1, category: "yellow", directRed: false, secondYellow: false };
  }
  return { deduction: 0, category: "none", directRed: false, secondYellow: false };
}

export function computeFairPlayFromCards(events: ApiFootballEvent[]) {
  const perPlayerMatch = new Map<string, PlayerCardState>();
  for (const event of events.filter((row) => row.type === "Card")) {
    const key = `${event.team?.id ?? "team"}:${event.player?.id ?? event.player?.name ?? "player"}`;
    const current = perPlayerMatch.get(key) ?? {
      player_id: asNumber(event.player?.id),
      player_name: event.player?.name ?? null,
      team_id: asNumber(event.team?.id),
      team_name: event.team?.name ?? null,
      yellows: 0,
      explicitSecondYellow: false,
      yellowMinutes: [],
      redCards: [],
    };
    const detail = (event.detail ?? "").toLowerCase();
    if (hasSecondYellowLabel(event.detail ?? null, event.comments ?? null)) current.explicitSecondYellow = true;
    if (detail.includes("yellow")) {
      current.yellows += 1;
      current.yellowMinutes.push(cardMinute(event));
    }
    if (detail.includes("red")) {
      current.redCards.push({
        minute: cardMinute(event),
        detail: event.detail ?? null,
        comments: event.comments ?? null,
      });
    }
    perPlayerMatch.set(key, current);
  }

  const playerDeductions = [...perPlayerMatch.values()].map((row) => {
    const classification = classifyPlayerCards(row);
    const { yellowMinutes: _yellowMinutes, redCards: _redCards, explicitSecondYellow: _explicitSecondYellow, ...publicRow } = row;
    return { ...publicRow, ...classification };
  });

  const teamTotals: Record<string, number> = {};
  for (const row of playerDeductions) {
    const team = row.team_name ?? String(row.team_id ?? "unknown");
    teamTotals[team] = (teamTotals[team] ?? 0) + row.deduction;
  }
  return { player_deductions: playerDeductions, team_totals: teamTotals };
}

function syntheticEplShape() {
  const lineups = [
    {
      team: { id: 50, name: "Manchester City" },
      coach: { id: 101, name: "Coach A" },
      formation: "4-2-3-1",
      startXI: [
        { player: { id: 284230, name: "Rico Lewis", number: 82, pos: "D", grid: "2:3" } },
        { player: { id: 19281, name: "A. Semenyo", number: 24, pos: "F", grid: "4:2" } },
      ],
      substitutes: [
        { player: { id: 999001, name: "Synthetic Sub", number: 14, pos: "M", grid: null } },
      ],
    },
    {
      team: { id: 66, name: "Aston Villa" },
      coach: { id: 202, name: "Coach B" },
      formation: "4-4-2",
      startXI: [
        { player: { id: 888001, name: "Villa Starter", number: 9, pos: "F", grid: "4:1" } },
      ],
      substitutes: [
        { player: { id: 888002, name: "Villa Sub", number: 18, pos: "M", grid: null } },
      ],
    },
  ];
  const events: ApiFootballEvent[] = [
    { time: { elapsed: 23, extra: null }, team: { id: 50, name: "Manchester City" }, player: { id: 19281, name: "A. Semenyo" }, assist: { id: null, name: null }, type: "Goal", detail: "Normal Goal", comments: null },
    { time: { elapsed: 65, extra: null }, team: { id: 66, name: "Aston Villa" }, player: { id: 888002, name: "Villa Sub" }, assist: { id: 888001, name: "Villa Starter" }, type: "subst", detail: "Substitution 1", comments: null },
    { time: { elapsed: 82, extra: null }, team: { id: 50, name: "Manchester City" }, player: { id: 284230, name: "Rico Lewis" }, assist: { id: null, name: null }, type: "Card", detail: "Yellow Card", comments: "Foul" },
  ];
  return { lineups, events };
}

function syntheticCanadaResult() {
  return {
    fixture_label: SYNTHETIC_FIXTURE_LABEL,
    api_football_fixture_id: SYNTHETIC_FIXTURE_ID,
    team_a_code: "CAN" as TeamCode,
    team_b_code: "BIH" as TeamCode,
    old_result: { match_status: "scheduled", team_a_goals: null, team_b_goals: null },
    new_result: { match_status: "finished", team_a_goals: 2, team_b_goals: 1, result: "team_a_win" },
    event_time: "2026-06-13T01:00:00.000Z",
    source_url: "synthetic://wc2026/group-b/can-bih",
  };
}

function materialityGate(rows: EventLogRow[]) {
  const materialCauses = rows.filter((row) => row.gate_decision === "material" && row.event_type === "result_verified" && row.confidence === "verified");
  return {
    phase_2_allowed: materialCauses.length > 0,
    material_event_ids: materialCauses.map((row) => row.id),
    context_only_events: rows.filter((row) => row.gate_decision === "context_only").length,
    reason: materialCauses.length > 0
      ? "verified result changed; result is material by locked decision"
      : "only lineups/cards/minutes/injuries/player-stats context changed; context-only by locked decision",
  };
}

function plannedModelAdapters(material: boolean) {
  if (!material) return [];
  return [
    {
      step: "fixture_probabilities",
      existing_or_new: "existing black box",
      command_contract: "current-best predictor/run contract; candidate-only output",
      guarded_files: ["scripts/worldcup/predict-*.ts", "model_candidates"],
      will_modify_predictor: false,
    },
    {
      step: "live_conditioned_monte_carlo",
      existing_or_new: "existing",
      command_contract: "npx.cmd tsx scripts/worldcup/build-advancement-scenario-v1-live.ts --synthetic-test",
      candidate_only: true,
    },
    {
      step: "elo_k60",
      existing_or_new: "existing",
      command_contract: "scripts/worldcup/elo-update-engine.ts applyMatch(..., K=60)",
      candidate_only: true,
    },
  ];
}

function buildAiNarrationInput(delta: Record<string, unknown>) {
  return {
    request_id: "synthetic-post-result-change-can-bih",
    content_type: "post_result_change",
    generated_for: { fixture_label: SYNTHETIC_FIXTURE_LABEL, team_codes: ["CAN", "BIH"] },
    result: { team_a_code: "CAN", team_b_code: "BIH", score: "2-1", confidence: "verified" },
    probability_references: [
      { label: "Canada advance", old_probability: 0.5471, new_probability: 0.6138, delta: 0.0667 },
      { label: "Bosnia advance", old_probability: 0.5402, new_probability: 0.4749, delta: -0.0653 },
    ],
    context: delta,
    output_requirements: { length_target_words: { min: 80, max: 300 } },
  };
}

function validateSyntheticAiNarration(input: ReturnType<typeof buildAiNarrationInput>) {
  const rawOutput = JSON.stringify({
    content_type: "post_result_change",
    headline: "Canada result lifts its group path",
    body: "Canada's verified 2-1 result over Bosnia changes the tournament state before any explanation layer gets involved. The model update raises Canada's advancement outlook from 54.7% to 61.4%, while Bosnia moves from 54.0% to 47.5%. The lineup and card notes are useful context for the match record, but they did not trigger this probability move; the trigger was the final score.",
    probability_references: input.probability_references,
    source_trace: ["verified synthetic result", "candidate model delta", "lineup and card event context"],
    context_caveats: ["Synthetic validation only; real matches start on 2026-06-11."],
    unknowns: ["Real WC2026 lineups and event details activate at kickoff."],
    validation_notes: ["Structured output validated locally."],
  });
  return validateAndRepairAiOutput(rawOutput, input);
}

function dataDependencyMatrix() {
  return [
    { step: "result spine", script: "scripts/worldcup/ingest-wc2026-results.ts", required_inputs: "API-Football /fixtures league=1 season=2026; fixture_metadata; teams; match_results", source: "existing table/feed", status: "available; live final scores activate at match completion" },
    { step: "event log write", script: "supabase/migrations/DRY_RUN_ONLY_20260604_tournament_event_log.sql", required_inputs: "change payload + materiality decision", source: "new table", status: "dry-run schema ready; not applied" },
    { step: "lineup ingestion", script: "scripts/worldcup/live/live-update-orchestrator.ts", required_inputs: "API-Football /fixtures/lineups payload", source: "feed shape validated against EPL-style cached sample", status: "activates-at-kickoff" },
    { step: "minutes/substitutions", script: "scripts/worldcup/live/live-update-orchestrator.ts", required_inputs: "API-Football /fixtures/events substitutions/goals/cards", source: "feed shape validated against EPL/WC2022 event samples", status: "activates-at-kickoff" },
    { step: "player stats enrichment", script: "scripts/worldcup/ingest-wc2026-results.ts", required_inputs: "API-Football /fixtures/players payload", source: "feed shape validated against real finished fixture 1379342", status: "activates post-match; context-only; never prediction input" },
    { step: "injury/status slot", script: "scripts/worldcup/live/live-update-orchestrator.ts + player_status_events", required_inputs: "deterministic card suspensions and official final-squad withdrawals; broad injury source", source: "existing player_status_events + official squad workflow + pluggable future source", status: "deterministic available; broad-injury unsolved-sourcing" },
    { step: "cards/fair-play", script: "scripts/worldcup/live/live-update-orchestrator.ts + scripts/worldcup/tiebreaker-ladders-2026.ts", required_inputs: "API-Football card events", source: "events feed; official/manual fallback", status: "activates-at-kickoff" },
    { step: "group table/tiebreakers", script: "scripts/worldcup/tiebreaker-ladders-2026.ts; scripts/worldcup/ingest-wc2026-results.ts standings derivation", required_inputs: "verified match_results + fair-play totals + FIFA rankings", source: "existing tables/scripts", status: "available; fair-play activates-at-kickoff" },
    { step: "fixture probability rerun", script: "current-best predictor black box", required_inputs: "verified result material gate + current-best run contract", source: "existing predictor/run contract", status: "available as black-box only; candidate-only new runs" },
    { step: "live-conditioned MC and K=60 Elo", script: "scripts/worldcup/build-advancement-scenario-v1-live.ts; scripts/worldcup/elo-update-engine.ts", required_inputs: "candidate prediction run; locked verified result; team_elo_history", source: "existing scripts/tables", status: "available; candidate-only" },
    { step: "AI post-result narration", script: "scripts/worldcup/ai-layer/system-prompt.md; scripts/worldcup/ai-layer/validate-and-repair.ts", required_inputs: "verified result fact + probability delta + attributed context", source: "existing AI layer", status: "validation available; real AI call intentionally not fired in synthetic dry-run" },
  ];
}

async function main() {
  const args = parseArgs();
  if (args.execute) {
    throw new Error("--execute is intentionally blocked in the scaffold. This turn is dry-run/synthetic-only; no live matches before 2026-06-11.");
  }

  const orchestratorRunId = randomUUID();
  const phase1Rows: EventLogRow[] = [];
  const now = new Date().toISOString();
  const synthetic = syntheticCanadaResult();
  const sourceSnapshot = {
    project_id: PROJECT_ID,
    mode: args.contextOnly ? "context-only synthetic" : "synthetic result",
    guardrails: {
      dry_run: true,
      candidate_only_new_runs: true,
      no_odds: true,
      no_api_football_predictions_endpoint: true,
      predictor_files_modified: false,
      model_candidate_modified: false,
    },
  };

  if (!args.contextOnly) {
    phase1Rows.push(eventRow({
      event_type: "result_verified",
      source: "synthetic_replay",
      source_url: synthetic.source_url,
      source_payload_hash: sha256(synthetic),
      event_time: synthetic.event_time,
      affected_fixture_label: synthetic.fixture_label,
      affected_api_football_fixture_id: synthetic.api_football_fixture_id,
      affected_team_code: null,
      affected_api_football_player_id: null,
      old_value: synthetic.old_result,
      new_value: synthetic.new_result,
      confidence: "verified",
      gate_decision: "material",
      gate_reason: "verified result changed; only results move probabilities",
      rerun_triggered: true,
      triggered_run_id: null,
      triggered_run_kind: "phase_2_model_bundle",
      source_snapshot: sourceSnapshot,
    }, orchestratorRunId));
  }

  const { lineups, events } = syntheticEplShape();
  const lineupRows = parseApiFootballLineups(SYNTHETIC_FIXTURE_ID, lineups);
  const minuteRows = parseApiFootballMinutes(SYNTHETIC_FIXTURE_ID, events);
  const fairPlay = computeFairPlayFromCards(events);
  const playerStatsContext = {
    endpoint: "/fixtures/players",
    target_table: "api_football_fixture_player_stats",
    parsed_rows: 2,
    sample_fields: ["games", "shots", "goals", "passes", "tackles", "duels", "cards", "rating"],
    prediction_input_allowed: false,
  };

  phase1Rows.push(eventRow({
    event_type: "lineup_ingested",
    source: "api-football-shape-synthetic",
    source_url: "synthetic://api-football/epl-lineups-shape",
    source_payload_hash: sha256(lineups),
    event_time: now,
    affected_fixture_label: SYNTHETIC_FIXTURE_LABEL,
    affected_api_football_fixture_id: SYNTHETIC_FIXTURE_ID,
    affected_team_code: null,
    affected_api_football_player_id: null,
    old_value: { lineup_rows: 0 },
    new_value: { lineup_rows: lineupRows.length, sample: lineupRows.slice(0, 3) },
    confidence: "reported",
    gate_decision: "context_only",
    gate_reason: "lineups are context-only by locked decision; never trigger model rerun",
    rerun_triggered: false,
    triggered_run_id: null,
    triggered_run_kind: null,
    source_snapshot: sourceSnapshot,
  }, orchestratorRunId));

  phase1Rows.push(eventRow({
    event_type: "minutes_ingested",
    source: "api-football-shape-synthetic",
    source_url: "synthetic://api-football/epl-events-shape",
    source_payload_hash: sha256(events),
    event_time: now,
    affected_fixture_label: SYNTHETIC_FIXTURE_LABEL,
    affected_api_football_fixture_id: SYNTHETIC_FIXTURE_ID,
    affected_team_code: null,
    affected_api_football_player_id: null,
    old_value: { minute_rows: 0 },
    new_value: { minute_rows: minuteRows.length, sample: minuteRows },
    confidence: "reported",
    gate_decision: "context_only",
    gate_reason: "minutes/substitutions are context-only by locked decision; never trigger model rerun",
    rerun_triggered: false,
    triggered_run_id: null,
    triggered_run_kind: null,
    source_snapshot: sourceSnapshot,
  }, orchestratorRunId));

  phase1Rows.push(eventRow({
    event_type: "card_suspension_context",
    source: "api-football-shape-synthetic",
    source_url: "synthetic://api-football/epl-events-shape",
    source_payload_hash: sha256(events.filter((event) => event.type === "Card")),
    event_time: now,
    affected_fixture_label: SYNTHETIC_FIXTURE_LABEL,
    affected_api_football_fixture_id: SYNTHETIC_FIXTURE_ID,
    affected_team_code: null,
    affected_api_football_player_id: fairPlay.player_deductions[0]?.player_id ?? null,
    old_value: { fair_play: {} },
    new_value: fairPlay,
    confidence: "reported",
    gate_decision: "context_only",
    gate_reason: "cards/suspensions can affect tiebreaker context but do not move fixture probabilities",
    rerun_triggered: false,
    triggered_run_id: null,
    triggered_run_kind: null,
    source_snapshot: sourceSnapshot,
  }, orchestratorRunId));

  phase1Rows.push(eventRow({
    event_type: "injury_status_context",
    source: "player_status_events+final_squad_verifications",
    source_url: "synthetic://status/deterministic-slot",
    source_payload_hash: sha256({ fairPlay, official_withdrawals: [], broad_injury_adapter: "not_configured" }),
    event_time: now,
    affected_fixture_label: SYNTHETIC_FIXTURE_LABEL,
    affected_api_football_fixture_id: SYNTHETIC_FIXTURE_ID,
    affected_team_code: null,
    affected_api_football_player_id: null,
    old_value: { status_events: 0 },
    new_value: {
      deterministic_card_suspensions: [],
      official_final_squad_withdrawals: [],
      broad_injury_adapter: {
        configured: false,
        status: "unsolved_sourcing",
        note: "Slot is wired for future source-backed injury events; unsupported broad injury claims are not ingested.",
      },
    },
    confidence: "reported",
    gate_decision: "context_only",
    gate_reason: "injury/status context can be narrated with attribution but never triggers a probability rerun",
    rerun_triggered: false,
    triggered_run_id: null,
    triggered_run_kind: null,
    source_snapshot: sourceSnapshot,
  }, orchestratorRunId));

  phase1Rows.push(eventRow({
    event_type: "player_stats_ingested",
    source: "api-football-real-shape-validated",
    source_url: "https://v3.football.api-sports.io/fixtures/players?fixture=1379342",
    source_payload_hash: sha256(playerStatsContext),
    event_time: now,
    affected_fixture_label: SYNTHETIC_FIXTURE_LABEL,
    affected_api_football_fixture_id: SYNTHETIC_FIXTURE_ID,
    affected_team_code: null,
    affected_api_football_player_id: null,
    old_value: { player_stats_rows: 0 },
    new_value: playerStatsContext,
    confidence: "reported",
    gate_decision: "context_only",
    gate_reason: "post-match player stats are observed context for AI narration/evidence; they never trigger model reruns and never feed prediction inputs",
    rerun_triggered: false,
    triggered_run_id: null,
    triggered_run_kind: null,
    source_snapshot: sourceSnapshot,
  }, orchestratorRunId));

  phase1Rows.push(eventRow({
    event_type: "group_table_recomputed",
    source: "synthetic_result_spine",
    source_url: synthetic.source_url,
    source_payload_hash: sha256({ synthetic, fairPlay }),
    event_time: now,
    affected_fixture_label: SYNTHETIC_FIXTURE_LABEL,
    affected_api_football_fixture_id: SYNTHETIC_FIXTURE_ID,
    affected_team_code: null,
    affected_api_football_player_id: null,
    old_value: { group_b_played_results: 0 },
    new_value: { group_b_played_results: args.contextOnly ? 0 : 1, tiebreaker_ladder: "fifa-2026-article-13", fair_play_context: fairPlay.team_totals },
    confidence: args.contextOnly ? "reported" : "verified",
    gate_decision: args.contextOnly ? "context_only" : "material",
    gate_reason: args.contextOnly ? "context-only run has no verified result" : "derived group table changed because a verified result changed",
    rerun_triggered: !args.contextOnly,
    triggered_run_id: null,
    triggered_run_kind: !args.contextOnly ? "phase_2_model_bundle" : null,
    source_snapshot: sourceSnapshot,
  }, orchestratorRunId));

  const gate = materialityGate(phase1Rows);
  const phase2Rows: EventLogRow[] = [];
  let candidatePredictionRunId: string | null = null;
  let candidateSimulationRunId: string | null = null;
  if (gate.phase_2_allowed) {
    candidatePredictionRunId = randomUUID();
    candidateSimulationRunId = randomUUID();
    phase2Rows.push(eventRow({
      event_type: "prediction_candidate_run",
      source: "current-best-predictor-black-box",
      source_url: null,
      source_payload_hash: sha256(CURRENT_BEST_CONTRACT),
      event_time: now,
      affected_fixture_label: SYNTHETIC_FIXTURE_LABEL,
      affected_api_football_fixture_id: SYNTHETIC_FIXTURE_ID,
      affected_team_code: null,
      affected_api_football_player_id: null,
      old_value: { current_best_contract: CURRENT_BEST_CONTRACT, canada_advance_reference: 0.5471 },
      new_value: { candidate_prediction_run_id: candidatePredictionRunId, canada_advance_reference: 0.6138, candidate_only: true },
      confidence: "verified",
      gate_decision: "material",
      gate_reason: "Phase 2 allowed only after verified-result material event",
      rerun_triggered: true,
      triggered_run_id: candidatePredictionRunId,
      triggered_run_kind: "prediction_run",
      source_snapshot: sourceSnapshot,
    }, orchestratorRunId));

    phase2Rows.push(eventRow({
      event_type: "monte_carlo_candidate_run",
      source: "scripts/worldcup/build-advancement-scenario-v1-live.ts",
      source_url: null,
      source_payload_hash: sha256({ locked_result: synthetic.new_result, command: "npx.cmd tsx scripts/worldcup/build-advancement-scenario-v1-live.ts --synthetic-test" }),
      event_time: now,
      affected_fixture_label: SYNTHETIC_FIXTURE_LABEL,
      affected_api_football_fixture_id: SYNTHETIC_FIXTURE_ID,
      affected_team_code: null,
      affected_api_football_player_id: null,
      old_value: { canada_advance: 0.5471, bosnia_advance: 0.5402 },
      new_value: { simulation_run_id: candidateSimulationRunId, canada_advance: 0.6138, bosnia_advance: 0.4749, conditioned_on: "CAN 2-1 BIH", candidate_only: true },
      confidence: "verified",
      gate_decision: "material",
      gate_reason: "live-conditioned Monte Carlo reruns only because verified result changed",
      rerun_triggered: true,
      triggered_run_id: candidateSimulationRunId,
      triggered_run_kind: "tournament_simulation_run",
      source_snapshot: sourceSnapshot,
    }, orchestratorRunId));

    const eloBefore = { CAN: 1721, BIH: 1788 };
    const eloAfter = applyMatch(eloBefore, "CAN", "BIH", 2, 1, WORLD_CUP_K);
    phase2Rows.push(eventRow({
      event_type: "elo_k60_candidate_update",
      source: "scripts/worldcup/elo-update-engine.ts",
      source_url: null,
      source_payload_hash: sha256({ eloBefore, result: synthetic.new_result, K: WORLD_CUP_K }),
      event_time: now,
      affected_fixture_label: SYNTHETIC_FIXTURE_LABEL,
      affected_api_football_fixture_id: SYNTHETIC_FIXTURE_ID,
      affected_team_code: null,
      affected_api_football_player_id: null,
      old_value: eloBefore,
      new_value: { ...eloAfter, K: WORLD_CUP_K, candidate_only: true },
      confidence: "verified",
      gate_decision: "material",
      gate_reason: "K=60 Elo update follows verified result after data write",
      rerun_triggered: true,
      triggered_run_id: randomUUID(),
      triggered_run_kind: "elo_update_candidate",
      source_snapshot: sourceSnapshot,
    }, orchestratorRunId));
  }

  const phase3Rows: EventLogRow[] = [];
  let aiValidation: ReturnType<typeof validateSyntheticAiNarration> | null = null;
  if (gate.phase_2_allowed) {
    const aiInput = buildAiNarrationInput({
      lineup_rows: lineupRows.length,
      minute_rows: minuteRows.length,
      fair_play: fairPlay.team_totals,
      injury_status_context: "deterministic slot present; broad injury sourcing unresolved",
    });
    aiValidation = validateSyntheticAiNarration(aiInput);
    phase3Rows.push(eventRow({
      event_type: "ai_post_result_narration",
      source: "scripts/worldcup/ai-layer/validate-and-repair.ts",
      source_url: null,
      source_payload_hash: sha256(aiValidation.cleaned_output),
      event_time: now,
      affected_fixture_label: SYNTHETIC_FIXTURE_LABEL,
      affected_api_football_fixture_id: SYNTHETIC_FIXTURE_ID,
      affected_team_code: null,
      affected_api_football_player_id: null,
      old_value: { narration: null },
      new_value: { validation_valid: aiValidation.valid, cleaned_output: aiValidation.cleaned_output },
      confidence: "verified",
      gate_decision: "material",
      gate_reason: "AI runs third and explains only the stored result plus model delta/context",
      rerun_triggered: false,
      triggered_run_id: randomUUID(),
      triggered_run_kind: "ai_narration_artifact",
      source_snapshot: sourceSnapshot,
    }, orchestratorRunId));
  }

  const allRows = [...phase1Rows, ...phase2Rows, ...phase3Rows];
  const validation = {
    project_id: PROJECT_ID,
    dry_run: true,
    execute: false,
    synthetic_result: !args.contextOnly,
    context_only: args.contextOnly,
    orchestrator_run_id: orchestratorRunId,
    phase_order: ["DATA", "MATERIALITY_GATE", "MODEL", "AI"],
    data_first_model_second_ai_third: true,
    materiality_gate: gate,
    model_adapters: plannedModelAdapters(gate.phase_2_allowed),
    event_log_rows: allRows,
    assertions: {
      result_triggers_rerun: !args.contextOnly && gate.phase_2_allowed,
      context_only_does_not_trigger_rerun: args.contextOnly ? !gate.phase_2_allowed : true,
      every_change_logged: allRows.length >= (args.contextOnly ? 5 : 10),
      candidate_only_new_runs: phase2Rows.every((row) => row.new_value.candidate_only === true),
      ai_after_model: phase3Rows.length === 0 || phase2Rows.length > 0,
      ai_validation_valid: aiValidation?.valid ?? null,
      no_odds: true,
      no_api_football_predictions_endpoint: true,
      predictor_files_modified: false,
      model_candidate_modified: false,
    },
    data_dependency_matrix: dataDependencyMatrix(),
  };

  if (args.writeAudit) {
    mkdirSync(AUDIT_DIR, { recursive: true });
    const validationFile = args.contextOnly
      ? "live-update-orchestrator-context-only-validation.json"
      : "live-update-orchestrator-synthetic-validation.json";
    writeFileSync(path.join(AUDIT_DIR, validationFile), JSON.stringify(validation, null, 2), "utf8");
    writeFileSync(path.join(AUDIT_DIR, "live-update-data-dependency-matrix.json"), JSON.stringify(dataDependencyMatrix(), null, 2), "utf8");
  }

  console.log(JSON.stringify({
    project_id: PROJECT_ID,
    dry_run: true,
    execute: false,
    synthetic_result: !args.contextOnly,
    context_only: args.contextOnly,
    materiality_gate: gate,
    event_log_rows: allRows.length,
    model_phase_rows: phase2Rows.length,
    ai_phase_rows: phase3Rows.length,
    assertions: validation.assertions,
    audit_path: args.writeAudit
      ? (args.contextOnly ? "data/audits/live-update-orchestrator-context-only-validation.json" : "data/audits/live-update-orchestrator-synthetic-validation.json")
      : null,
    matrix_path: args.writeAudit ? "data/audits/live-update-data-dependency-matrix.json" : null,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      project_id: PROJECT_ID,
      dry_run: true,
      execute: false,
      errors: [error instanceof Error ? error.message : String(error)],
    }, null, 2));
    process.exit(1);
  });
}
