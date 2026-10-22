export const when = (value: string | null) => (value ? value.slice(0, 16).replace("T", " ") + " UTC" : "Never");
export const usd = (value: number) => `≈ $${value.toFixed(2)} (estimate)`;
