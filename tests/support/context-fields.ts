import type { InterviewInput } from "../../src/lib/ai/discovery-interview";

/** Company-context catalog fields beyond the original ten; a test that drives a workspace to readiness must answer them too. */
export const CONTEXT_FIELD_IDS = ["operating_scale", "retained_systems", "process_overview", "legal_entities", "target_org_units",
  "modules_in_scope", "external_parties", "approval_rules", "localization_compliance", "kpi_baselines", "kpi_targets", "constraints",
  "timeline", "required_outputs"] as const;

/** The smallest valid interview turn for a stage-runner test double: it must ask while any gap is open. */
export const askFirstGap = (input: InterviewInput) => input.activeGaps.slice(0, 1).map(gap => ({ gapKey: gap.key,
  question: "What can you tell me about this topic in your own words?", whyItMatters: "It shapes the design that follows." }));
