export const SUPPORT_EMAIL = "suyash@voxdonna.com";

/** Failures a retry cannot fix: the workspace owner has to reach us. */
const ACCOUNT_BLOCKED = new Set(["TRIAL_EXPIRED", "ORG_SUSPENDED"]);
/** Failures on our side where retrying later may work, but the person should also have a way to reach us. */
const NEEDS_SUPPORT = new Set([...ACCOUNT_BLOCKED, "AI_PROVIDER_CREDIT"]);

export const isAccountBlocked = (code?: string | null) => Boolean(code && ACCOUNT_BLOCKED.has(code));
export const needsSupport = (code?: string | null) => Boolean(code && NEEDS_SUPPORT.has(code));

export function SupportLink() {
  return <a href={`mailto:${SUPPORT_EMAIL}`}>Email {SUPPORT_EMAIL}</a>;
}
