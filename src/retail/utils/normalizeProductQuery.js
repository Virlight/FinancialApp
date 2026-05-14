export function normalizeProductQuery(value) {
  return String(value || "").trim();
}

export function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function uniqueTerms(terms, limit = 8) {
  return [...new Set(terms.map((term) => String(term || "").trim()).filter(Boolean))].slice(0, limit);
}
