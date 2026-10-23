import { z } from "zod";

export const text = z.string().trim().min(1).max(8000);
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const ids = z.array(id).max(200);
export const texts = z.array(text).min(1).max(100);
export const list = <T extends z.ZodType>(schema: T) => z.array(schema).max(200);
export const FIT_TYPES = ["STANDARD", "CONFIGURATION", "EXTENSION", "INTEGRATION", "MANUAL", "LICENSE_DEPENDENT"] as const;
