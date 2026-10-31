import { rentalContext } from "../../fixtures/ai/to-be/rental-benchmark";
import type { DiscoveryInput } from "../../src/lib/discovery";
import type { ToBeInput } from "../../src/lib/ai/to-be";

/** Fictional equipment-hire discovery input accepted by the To-Be stage. */
export function fixture(): ToBeInput {
  const descriptions = [
    "The coordinator copies accepted quotation quantities into a spreadsheet and maintains one date for the entire order.",
    "The stores clerk records returned assets on paper and emails billing a consolidated return note.",
    "The billing clerk calculates monthly hire in a spreadsheet and manually removes previously billed installation charges.",
  ];
  const discovery: DiscoveryInput = {
    schemaVersion: 1, variantName: "Fictional equipment hire", targetRelease: null,
    sources: rentalContext.sources.map((source, i) => ({ ...source, title: `Workshop ${i + 1}`, revision: "v1",
      text: `  ${descriptions[i]}\r\n${source.text}  ` })),
    asIsSteps: rentalContext.asIsSteps.map((step, i) => ({
      ...step, sequence: i + 1, actor: ["Rental coordinator", "Stores clerk", "Billing clerk"][i]!, system: "Manual records",
      trigger: ["Accepted quotation", "Physical return", "Monthly billing date"][i]!, description: descriptions[i]!,
      inputs: ["Current process record"], outputs: ["Updated manual record"], controls: [], exceptions: [],
      evidence: { sourceId: `SRC-${i + 1}`, quote: descriptions[i]! },
    })),
    requirements: rentalContext.requirements.map(({ id, asIsStepId, critical, sourceId, quote }) =>
      ({ id, asIsStepId, critical, kind: "TO_BE_REQUIREMENT", statement: quote, evidence: { sourceId, quote } })),
    conflicts: structuredClone(rentalContext.conflicts),
    openQuestions: [{ id: "IQ-1", question: "Which timezone governs the actual return timestamp?", owner: "Rental operations lead" }],
  };
  return { targetProduct: "S4HANA_CLOUD_PRIVATE", discovery };
}

/** Adds answered company-context fields to a To-Be input, each quoting a new interview-answers source. */
export function withCompanyContext(input: ToBeInput, answers: Record<string, string>): ToBeInput {
  const entries = Object.entries(answers);
  const source = { id: "SRC-CTX", title: "Interview answers", revision: "v1", locator: "Fictional interview", text: entries.map(([, value]) => value).join("\n\n") };
  return { ...input, discovery: { ...input.discovery, sources: [...input.discovery.sources, source],
    companyContext: entries.map(([fieldId, value]) => ({ fieldId: fieldId as never, label: `Label for ${fieldId}`, value, evidence: { sourceId: source.id, quote: value } })) } };
}
