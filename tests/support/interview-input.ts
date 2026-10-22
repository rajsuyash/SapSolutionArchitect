import type { InterviewInput } from "../../src/lib/ai/discovery-interview";

/** Fictional equipment-hire interview input accepted by the interview_turn stage. */
export const fixture = (): InterviewInput => ({
  schemaVersion: 1, contextRevision: 3, variantName: "Equipment hire",
  problemStatement: "Asset returns are recorded manually and delayed updates cause disputed invoices.",
  currentMessage: { id: "MSG-3", text: "The clerk records physical returns in the spreadsheet. The actual date is sometimes missing." },
  evidence: [{ id: "SRC-1", text: "The hire desk sends a paper return note to billing.\r\n" }],
  fields: [
    { id: "return-action", label: "Return action", value: null, status: "EMPTY" },
    { id: "return-system", label: "Return system", value: "Paper log", status: "KNOWN" },
    { id: "return-date", label: "Return date policy", value: null, status: "UNKNOWN" },
  ],
  activeGaps: [
    { key: "return-action-gap", fieldId: "return-action", detail: "How is return recorded?", priority: "IMPORTANT" },
    { key: "return-date-gap", fieldId: "return-date", detail: "What date stops charging?", priority: "CRITICAL" },
  ],
  closedGapKeys: ["known-actor-gap"],
  history: [{ role: "assistant", text: "Which clerk records the return?" },
    { role: "user", text: "The stores clerk." }],
});
