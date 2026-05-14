export function normalizeAvailability(value) {
  const text = String(value || "").trim();
  return text || null;
}
