import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ValidationResult = {
  valid: boolean;
  repaired: boolean;
  repair_actions: string[];
  rejections: string[];
  warnings: string[];
  cleaned_output: JsonValue | null;
  parsed_output: JsonValue | null;
  parse_error: string | null;
  metrics: {
    body_word_count: number;
    body_word_limit: number | null;
    internal_identifier_hits: string[];
    ungrounded_percentages: string[];
    meta_text_hits: string[];
  };
};

const DEFAULT_BODY_LIMITS: Record<string, number> = {
  pre_match_storyline: 250,
  post_result_change: 300,
  scenario_narration: 220,
  group_narration: 170,
  tournament_upset_risk: 650,
  hardest_path_analysis: 600,
  bracket_storyline: 650,
  daily_tournament_narrative: 800,
};

const REQUIRED_FIELDS = [
  "content_type",
  "headline",
  "probability_references",
  "source_trace",
  "context_caveats",
  "unknowns",
  "validation_notes",
];

const INTERNAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "uuid", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { name: "advancement_scenario_id", pattern: /\badvancement-scenario-v1[^\s,.;)"']*/gi },
  { name: "team_tactical_identifier", pattern: /\bteam_tactical_[A-Za-z0-9_:-]+/gi },
  { name: "player_impact_identifier", pattern: /\bplayer-impact-[A-Za-z0-9_.:-]+/gi },
  { name: "team_strength_identifier", pattern: /\bteam-strength-[A-Za-z0-9_.:-]+/gi },
  { name: "internal_version_tag", pattern: /\bv\d+\.\d+(?:[A-Za-z0-9_.:-]|-)+/gi },
  { name: "monte_carlo_tag", pattern: /\b(?:monte-carlo|monte carlo|tournament-monte-carlo)[A-Za-z0-9_.:-]*/gi },
  { name: "fifa_article_internal_tag", pattern: /\bfifa-2026-article-13-v1\b/gi },
  { name: "current_best_jargon", pattern: /\bcurrent_best\b|\bcurrent-best\b|current_best:\s*false/gi },
  { name: "candidate_status_jargon", pattern: /\bcandidate(?:\s+run|\s+simulation|\s+status)?\b/gi },
  { name: "softened_model_jargon", pattern: /\bsoftened model\b|\bneutral Elo head-to-head\b/gi },
];

const META_TEXT_PATTERNS = [
  /\bno betting language (?:has been )?used\b/gi,
  /\bguardrail\b/gi,
  /\bas instructed\b/gi,
  /\bvalidation notes?\b/gi,
  /\bprompt\b/gi,
  /\bI have (?:not )?used\b/gi,
];

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) return fence[1].trim();
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseJson(text: string): { ok: true; value: JsonValue } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function extractFirstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function errorPosition(error: string): number | null {
  const match = error.match(/position (\d+)/i);
  return match ? Number(match[1]) : null;
}

function tryRepairAfterPropertyValue(text: string, error: string): string | null {
  if (!/Expected ',' or '}' after property value/i.test(error)) return null;
  const pos = errorPosition(error);
  if (pos == null) return null;
  const nextStructural = text.slice(pos).search(/[}\],]/);
  if (nextStructural < 0) return null;
  return text.slice(0, pos).replace(/\s+$/, "") + text.slice(pos + nextStructural);
}

function balanceTrailingBraces(text: string): string | null {
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") objectDepth++;
    else if (char === "}") objectDepth--;
    else if (char === "[") arrayDepth++;
    else if (char === "]") arrayDepth--;
    if (objectDepth < 0 || arrayDepth < 0) return null;
  }
  if (inString || objectDepth < 0 || arrayDepth < 0 || objectDepth + arrayDepth > 8) return null;
  return text + "]".repeat(arrayDepth) + "}".repeat(objectDepth);
}

function parseWithRepair(raw: string): {
  value: JsonValue | null;
  repaired: boolean;
  repairActions: string[];
  parseError: string | null;
} {
  const actions: string[] = [];
  const stripped = stripCodeFence(raw);
  if (stripped !== raw.trim()) actions.push("stripped_code_fence");

  const direct = parseJson(stripped);
  if (direct.ok) return { value: direct.value, repaired: actions.length > 0, repairActions: actions, parseError: null };

  const pos = errorPosition(direct.error);
  if (/Unexpected non-whitespace character after JSON/i.test(direct.error) && pos != null) {
    const prefix = stripped.slice(0, pos);
    const parsedPrefix = parseJson(prefix);
    if (parsedPrefix.ok) {
      return {
        value: parsedPrefix.value,
        repaired: true,
        repairActions: [...actions, "trimmed_trailing_non_json_after_complete_object"],
        parseError: direct.error,
      };
    }
  }

  const afterProperty = tryRepairAfterPropertyValue(stripped, direct.error);
  if (afterProperty) {
    const balanced = extractFirstBalancedObject(afterProperty) ?? afterProperty;
    const parsed = parseJson(balanced);
    if (parsed.ok) {
      return {
        value: parsed.value,
        repaired: true,
        repairActions: [...actions, "removed_trailing_garbage_after_string_property"],
        parseError: direct.error,
      };
    }
  }

  const balancedObject = extractFirstBalancedObject(stripped);
  if (balancedObject && balancedObject !== stripped) {
    const parsed = parseJson(balancedObject);
    if (parsed.ok) {
      return {
        value: parsed.value,
        repaired: true,
        repairActions: [...actions, "extracted_first_balanced_json_object"],
        parseError: direct.error,
      };
    }
  }

  const balanced = balanceTrailingBraces(stripped);
  if (balanced && balanced !== stripped) {
    const parsed = parseJson(balanced);
    if (parsed.ok) {
      return {
        value: parsed.value,
        repaired: true,
        repairActions: [...actions, "balanced_missing_trailing_braces_or_brackets"],
        parseError: direct.error,
      };
    }
  }

  return { value: null, repaired: false, repairActions: actions, parseError: direct.error };
}

function narrativeKeysForOutput(output: { [key: string]: JsonValue }): string[] {
  const keys = ["headline"];
  for (const key of ["body", "summary", "analysis", "narrative", "upset_risks", "key_points", "sections"]) {
    if (key in output) keys.push(key);
  }
  return keys;
}

function stringsFromValue(value: JsonValue): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(stringsFromValue);
  if (isObject(value)) return Object.values(value).flatMap(stringsFromValue);
  return [];
}

function narrativeText(output: JsonValue): string {
  if (!isObject(output)) return "";
  return narrativeKeysForOutput(output).flatMap((key) => stringsFromValue(output[key])).join("\n");
}

function bodyText(output: JsonValue): string {
  if (!isObject(output)) return "";
  const chunks: string[] = [];
  for (const key of narrativeKeysForOutput(output)) {
    if (key === "headline") continue;
    chunks.push(...stringsFromValue(output[key]));
  }
  return chunks.join("\n");
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cleanInternalText(text: string): { text: string; hits: string[]; changed: boolean } {
  let cleaned = text;
  const hits: string[] = [];

  cleaned = cleaned.replace(/\s*\([^)]*(?:[0-9a-f]{8}-[0-9a-f]{4}|advancement-scenario-v1|team_tactical_|player-impact-|team-strength-|fifa-2026-article-13|monte-carlo|source_run_id|current_best)[^)]*\)/gi, (match) => {
    hits.push(match.trim());
    return "";
  });

  for (const { name, pattern } of INTERNAL_PATTERNS) {
    cleaned = cleaned.replace(pattern, (match) => {
      hits.push(`${name}:${match}`);
      if (name === "uuid") return "the model";
      if (name.includes("tactical")) return "the tactical profile";
      if (name.includes("player_impact")) return "the player-impact context";
      if (name.includes("team_strength")) return "the team-strength context";
      if (name.includes("fifa_article")) return "the 2026 tiebreaker rules";
      if (name.includes("monte") || name.includes("version")) return "the model";
      if (name.includes("candidate") || name.includes("current_best") || name.includes("softened")) return "";
      return "the supplied source";
    });
  }

  cleaned = cleaned
    .replace(/\b(?:run|source|source_run_id)\s*:\s*the model\b/gi, "the model")
    .replace(/\bthe model\s+the model\b/gi, "the model")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();

  return { text: cleaned, hits, changed: cleaned !== text };
}

function mapNarrativeStrings(value: JsonValue, hits: string[]): { value: JsonValue; changed: boolean } {
  if (typeof value === "string") {
    const cleaned = cleanInternalText(value);
    hits.push(...cleaned.hits);
    return { value: cleaned.text, changed: cleaned.changed };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = mapNarrativeStrings(item, hits);
      changed ||= result.changed;
      return result.value;
    });
    return { value: next, changed };
  }
  if (isObject(value)) {
    let changed = false;
    const next: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      const result = mapNarrativeStrings(item, hits);
      changed ||= result.changed;
      next[key] = result.value;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
}

function cleanNarrativeFields(output: JsonValue): { output: JsonValue; hits: string[]; changed: boolean } {
  if (!isObject(output)) return { output, hits: [], changed: false };
  const next = cloneJson(output);
  const hits: string[] = [];
  let changed = false;
  for (const key of narrativeKeysForOutput(next)) {
    const result = mapNarrativeStrings(next[key], hits);
    next[key] = result.value;
    changed ||= result.changed;
  }
  return { output: next, hits: [...new Set(hits)], changed };
}

function internalHits(text: string): string[] {
  const hits: string[] = [];
  for (const { name, pattern } of INTERNAL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) hits.push(`${name}:${match[0]}`);
  }
  return [...new Set(hits)];
}

function collectAllowedNumericSources(input: JsonValue, mode: "probability" | "all" = "probability"): number[] {
  const values: number[] = [];
  const visit = (node: JsonValue, path: string[]) => {
    if (node == null) return;
    if (typeof node === "number") {
      const joined = path.join(".").toLowerCase();
      const probabilityLike =
        joined.includes("probabilities") ||
        joined.includes("probability") ||
        joined.includes("pct") ||
        joined.includes("scenario_data") ||
        joined.includes("synthesis_data");
      const statLike =
        joined.includes("avg_possession") ||
        joined.includes("percentage") ||
        joined.includes("confidence_score") ||
        joined.includes("measured_fields") ||
        joined.includes("tactical_profile");
      if (probabilityLike || (mode === "all" && statLike)) {
        values.push(node);
      }
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...path, String(index)]));
    } else if (isObject(node)) {
      for (const [key, item] of Object.entries(node)) visit(item, [...path, key]);
    }
  };
  visit(input, []);
  return values.filter((value) => Number.isFinite(value));
}

function percentageAllowed(percent: number, allowedNumbers: number[]): boolean {
  return allowedNumbers.some((value) => {
    const candidate = Math.abs(value) <= 1 ? value * 100 : value;
    return Math.abs(candidate - percent) <= 0.55;
  });
}

function ungroundedPercentages(text: string, input: JsonValue): string[] {
  const probabilityAllowed = collectAllowedNumericSources(input, "probability");
  const allAllowed = collectAllowedNumericSources(input, "all");
  const values = [...text.matchAll(/\b(\d+(?:\.\d+)?)%/g)].map((match) => {
    const start = Math.max(0, match.index - 80);
    const end = Math.min(text.length, match.index + match[0].length + 80);
    return { raw: match[0], value: Number(match[1]), context: text.slice(start, end).toLowerCase() };
  });
  return [...new Set(values.filter(({ value, context }) => {
    const statContext = /\b(possession|confidence|shot|shots|corners|set-piece|tempo|pressing|formation|average|avg|measured|tactical)\b/i.test(context);
    return !percentageAllowed(value, statContext ? allAllowed : probabilityAllowed);
  }).map(({ raw }) => raw))];
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function bodyLimit(output: JsonValue, input: JsonValue): number | null {
  if (isObject(input)) {
    const max = input.output_requirements;
    if (isObject(max) && isObject(max.length_target_words) && typeof max.length_target_words.max === "number") {
      return max.length_target_words.max;
    }
  }
  if (isObject(output) && typeof output.content_type === "string") return DEFAULT_BODY_LIMITS[output.content_type] ?? null;
  return null;
}

function normalizeSchema(output: JsonValue, actions: string[]): JsonValue {
  if (!isObject(output)) return output;
  const next = cloneJson(output);
  for (const key of ["context_caveats", "unknowns", "validation_notes"]) {
    if (typeof next[key] === "string") {
      next[key] = [next[key] as string];
      actions.push(`converted_${key}_string_to_array`);
    } else if (isObject(next[key])) {
      next[key] = stringsFromValue(next[key]);
      actions.push(`converted_${key}_object_to_array`);
    }
  }
  return next;
}

function schemaRejections(output: JsonValue): string[] {
  const rejections: string[] = [];
  if (!isObject(output)) return ["output_not_json_object"];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in output) || output[field] == null) rejections.push(`missing_required_field:${field}`);
  }
  if (!("body" in output) && !("narrative" in output) && !("analysis" in output) && !("summary" in output)) {
    rejections.push("missing_required_narrative_field:body_or_equivalent");
  }
  if (typeof output.content_type !== "string") rejections.push("invalid_content_type");
  if (typeof output.headline !== "string") rejections.push("invalid_headline");
  if (!Array.isArray(output.probability_references)) rejections.push("invalid_probability_references:not_array");
  if (!Array.isArray(output.context_caveats)) rejections.push("invalid_context_caveats:not_array");
  if (!Array.isArray(output.unknowns)) rejections.push("invalid_unknowns:not_array");
  if (!Array.isArray(output.validation_notes)) rejections.push("invalid_validation_notes:not_array");
  return rejections;
}

function metaTextHits(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of META_TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) hits.push(match[0]);
  }
  return [...new Set(hits)];
}

export function validateAndRepairAiOutput(rawOutput: string, structuredInput: JsonValue): ValidationResult {
  const rejections: string[] = [];
  const warnings: string[] = [];
  const repairActions: string[] = [];

  const parsed = parseWithRepair(rawOutput);
  if (!parsed.value) {
    return {
      valid: false,
      repaired: parsed.repaired,
      repair_actions: parsed.repairActions,
      rejections: [`json_invalid_unrepairable:${parsed.parseError}`],
      warnings,
      cleaned_output: null,
      parsed_output: null,
      parse_error: parsed.parseError,
      metrics: {
        body_word_count: 0,
        body_word_limit: null,
        internal_identifier_hits: [],
        ungrounded_percentages: [],
        meta_text_hits: [],
      },
    };
  }

  repairActions.push(...parsed.repairActions);
  let output = normalizeSchema(parsed.value, repairActions);

  const cleaned = cleanNarrativeFields(output);
  if (cleaned.changed) {
    repairActions.push("scrubbed_internal_identifiers_from_narrative_text");
    output = cleaned.output;
  }

  const remainingInternalHits = internalHits(narrativeText(output));
  const body = bodyText(output);
  const count = wordCount(body);
  const limit = bodyLimit(output, structuredInput);
  const percentageIssues = ungroundedPercentages(body, structuredInput);
  const metaIssues = metaTextHits(body);

  // ai_prediction — the AI's OWN pick on a knockout tie (co-predictor next to the model's number). REQUIRED on
  // pre_match_storyline: {pick: 3-letter code, reasoning, confidence_words, likely_scoreline}. Its text obeys the
  // body's discipline (internal-id scrub, no meta text) PLUS a STRICTER words-only rule — NO percentage at all,
  // grounded or not (confidence lives in words; the model's number already lives in the body). Validated separately
  // from the body so its words never count against the body word limit.
  if (isObject(output)) {
    const ap = (output as { [key: string]: JsonValue }).ai_prediction;
    if (output.content_type === "pre_match_storyline") {
      const apOk = isObject(ap)
        && typeof ap.pick === "string" && /^[A-Z]{3}$/.test(ap.pick)
        && typeof ap.reasoning === "string" && ap.reasoning.trim().length > 0
        && typeof ap.confidence_words === "string" && ap.confidence_words.trim().length > 0
        && typeof ap.likely_scoreline === "string" && ap.likely_scoreline.trim().length > 0;
      if (!apOk) rejections.push("missing_or_invalid_ai_prediction");
    }
    if (ap != null) {
      const apHits: string[] = [];
      const apCleaned = mapNarrativeStrings(ap, apHits);
      if (apCleaned.changed) {
        (output as { [key: string]: JsonValue }).ai_prediction = apCleaned.value;
        repairActions.push("scrubbed_internal_identifiers_from_ai_prediction");
      }
      const apText = stringsFromValue((output as { [key: string]: JsonValue }).ai_prediction).join("\n");
      if (/\d+(?:\.\d+)?\s*%/.test(apText)) rejections.push("percentage_in_ai_prediction:confidence_must_be_words_only");
      const apMeta = metaTextHits(apText);
      if (apMeta.length) rejections.push(`meta_or_guardrail_text_in_ai_prediction:${apMeta.join("|")}`);
      const apInternal = internalHits(apText);
      if (apInternal.length) rejections.push(`internal_identifiers_in_ai_prediction:${apInternal.join("|")}`);
    }
  }

  rejections.push(...schemaRejections(output));
  if (remainingInternalHits.length) rejections.push(`internal_identifiers_in_user_text:${remainingInternalHits.join("|")}`);
  if (percentageIssues.length) rejections.push(`ungrounded_percentages_in_body:${percentageIssues.join("|")}`);
  if (limit != null && count > limit) rejections.push(`body_over_length:${count}>${limit}`);
  if (metaIssues.length) rejections.push(`meta_or_guardrail_text_in_body:${metaIssues.join("|")}`);

  if (cleaned.hits.length) warnings.push(`internal_identifier_hits_cleaned:${cleaned.hits.join("|")}`);
  if (parsed.parseError && parsed.value) warnings.push(`json_repair_original_error:${parsed.parseError}`);

  return {
    valid: rejections.length === 0,
    repaired: parsed.repaired || repairActions.length > 0,
    repair_actions: [...new Set(repairActions)],
    rejections: [...new Set(rejections)],
    warnings: [...new Set(warnings)],
    cleaned_output: output,
    parsed_output: parsed.value,
    parse_error: parsed.parseError,
    metrics: {
      body_word_count: count,
      body_word_limit: limit,
      internal_identifier_hits: remainingInternalHits,
      ungrounded_percentages: percentageIssues,
      meta_text_hits: metaIssues,
    },
  };
}

function renderMarkdown(report: JsonValue): string {
  if (!isObject(report)) return "# AI Output Validation Report\n\nInvalid report object.\n";
  const rows = Array.isArray(report.items) ? report.items as JsonValue[] : [];
  const lines: string[] = [];
  lines.push("# AI Output Validation/Repair Pass");
  lines.push("");
  lines.push(`Generated: ${String(report.generated_at ?? "")}`);
  lines.push("");
  lines.push("Target project ref: `ahcfrgxczbgdvrqmbisw`.");
  lines.push("");
  lines.push("No DB writes, no AI calls, no API-Football `/predictions`, and no `/odds` were used. This pass reused saved raw model outputs.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Items checked: ${String(report.items_checked ?? rows.length)}`);
  lines.push(`- Valid after repair: ${String(report.valid_after_repair ?? "")}`);
  lines.push(`- Rejected: ${String(report.rejected ?? "")}`);
  lines.push(`- JSON repaired: ${String(report.json_repaired ?? "")}`);
  lines.push(`- Internal-ID narrative repairs: ${String(report.internal_id_repairs ?? "")}`);
  lines.push("");
  lines.push("## Item Results");
  lines.push("");
  lines.push("| Case | Model | Valid | Repaired | Body Words | Rejections | Repair Actions |");
  lines.push("| --- | --- | --- | --- | ---: | --- | --- |");
  for (const item of rows) {
    if (!isObject(item)) continue;
    const result = isObject(item.validation_result) ? item.validation_result : {};
    const metrics = isObject(result.metrics) ? result.metrics : {};
    const rejections = Array.isArray(result.rejections) ? result.rejections.join("; ") : "";
    const actions = Array.isArray(result.repair_actions) ? result.repair_actions.join("; ") : "";
    lines.push(`| ${String(item.case_id ?? "")} | ${String(item.model_label ?? "")} | ${result.valid ? "yes" : "no"} | ${result.repaired ? "yes" : "no"} | ${String(metrics.body_word_count ?? "")} | ${rejections || "none"} | ${actions || "none"} |`);
  }
  lines.push("");
  lines.push("## Known Failure Modes Caught");
  lines.push("");
  lines.push("- Malformed JSON from Gemini single-team outputs was repairable structurally, then still rejected where over length or ungrounded.");
  lines.push("- Claude's truncated synthesis JSON was rejected as unrecoverable.");
  lines.push("- User-facing run IDs, table/source IDs, and internal version tags were scrubbed from cleaned outputs or would reject if still present.");
  lines.push("- Derived combined percentages such as `55.7%` were rejected when not explicitly supplied in the input.");
  lines.push("- Over-length bodies were rejected rather than silently truncated.");
  lines.push("");
  lines.push("Security note: real keys in `.env.example` should be moved to local/deployment secrets and rotated if the file was committed or shared. This script does not read or print keys.");
  return lines.join("\n");
}

function runCli(): void {
  const args = new Set(process.argv.slice(2));
  const inputPath = "data/audits/ai-copredictor-expanded-test-input-cases.json";
  const outputsPath = "data/audits/ai-copredictor-expanded-test-model-outputs.json";
  const outPath = "data/audits/ai-output-validation-repair-expanded-test-report.json";
  const mdPath = "docs/ai-output-validation-repair-expanded-test-report.md";

  if (!args.has("--run-expanded-test-pass")) return;

  const inputBundle = JSON.parse(readFileSync(inputPath, "utf8")) as { cases: JsonValue[] };
  const outputsBundle = JSON.parse(readFileSync(outputsPath, "utf8")) as { results: Array<Record<string, unknown>> };
  const casesById = new Map(inputBundle.cases.map((item) => [isObject(item) ? String(item.request_id) : "", item]));

  const items = outputsBundle.results.map((result) => {
    const caseId = String(result.case_id ?? "");
    const structuredInput = casesById.get(caseId) ?? null;
    const validation = validateAndRepairAiOutput(String(result.output_text ?? ""), structuredInput);
    return {
      case_id: caseId,
      model_label: String(result.model_label ?? ""),
      original_json_valid: Boolean(isObject(result.review as JsonValue) && (result.review as Record<string, unknown>).json_valid),
      validation_result: validation,
    };
  });

  const report = {
    dry_run: true,
    execute: false,
    task: "ai_output_validation_repair_layer_existing_outputs_pass",
    target_project_ref: "ahcfrgxczbgdvrqmbisw",
    generated_at: new Date().toISOString(),
    input_path: inputPath,
    raw_outputs_path: outputsPath,
    items_checked: items.length,
    valid_after_repair: items.filter((item) => item.validation_result.valid).length,
    rejected: items.filter((item) => !item.validation_result.valid).length,
    json_repaired: items.filter((item) => item.validation_result.repair_actions.some((action) => action.includes("json") || action.includes("trailing") || action.includes("balanced") || action.includes("garbage"))).length,
    internal_id_repairs: items.filter((item) => item.validation_result.repair_actions.includes("scrubbed_internal_identifiers_from_narrative_text")).length,
    items,
    db_writes: 0,
    ai_calls: 0,
    odds_used: false,
    api_football_predictions_endpoint_used: false,
    warnings: [
      "Keys were not read or printed by this validation pass.",
      "Move real keys out of .env.example and rotate if committed or shared.",
    ],
  };

  mkdirSync("data/audits", { recursive: true });
  mkdirSync("docs", { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, renderMarkdown(report as JsonValue));
  console.log(JSON.stringify({ outPath, mdPath, items_checked: items.length, valid_after_repair: report.valid_after_repair, rejected: report.rejected }, null, 2));
}

runCli();
