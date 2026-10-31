import { z } from "zod";

export const text = z.string().trim().min(1).max(8000);
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const ids = z.array(id).max(200);
export const texts = z.array(text).min(1).max(100);
export const list = <T extends z.ZodType>(schema: T) => z.array(schema).max(200);
export const FIT_TYPES = ["STANDARD", "CONFIGURATION", "EXTENSION", "INTEGRATION", "MANUAL", "LICENSE_DEPENDENT"] as const;

/** What a register row rests on, and the SAP basis of a row that names a SAP capability. */
export const trace = { requirementIds: ids, contextFieldIds: ids, stepIds: ids };
export const basis = { referenceIds: ids, needsValidation: z.boolean(), validationReason: text.nullable() };

/** How a To-Be step is performed (reference standard checklist 7) and the phase it goes live in (checklist 14). */
export const STEP_TYPES = ["IN_SYSTEM_MANUAL", "AUTOMATIC", "OUTSIDE_SYSTEM", "DECISION", "INTEGRATION"] as const;
export const FIRST_PHASE = "Phase 1";
/** "Phase 1" is the go-live scope; "Phase 2", "Phase 3" ... and "Deferred" are later, and then the step states its interim process. */
export const phase = z.string().trim().regex(/^(Phase [1-9]\d?|Deferred)$/);
