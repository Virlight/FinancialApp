export function extractJsonLdPayloads(html) {
  const scripts = [];
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match = pattern.exec(String(html || ""));

  while (match) {
    const rawJson = match[1].trim();

    if (rawJson) {
      scripts.push(rawJson);
    }

    match = pattern.exec(String(html || ""));
  }

  return scripts
    .map((rawJson) => {
      try {
        return JSON.parse(rawJson);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function findProductsInJsonLd(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(findProductsInJsonLd);
  }

  if (typeof value !== "object") {
    return [];
  }

  const type = Array.isArray(value["@type"]) ? value["@type"].join(" ") : value["@type"];

  if (String(type || "").toLowerCase().includes("product")) {
    return [value];
  }

  if (Array.isArray(value.itemListElement)) {
    return value.itemListElement.flatMap((entry) => findProductsInJsonLd(entry.item || entry));
  }

  if (value.item) {
    return findProductsInJsonLd(value.item);
  }

  return [];
}
