export const retailerConfigs = [
  {
    id: "mediamarkt",
    displayName: "MediaMarkt",
    domains: ["mediamarkt.de"],
    aliases: ["mediamarkt", "media markt", "madiamarkt"],
    group: "media_saturn"
  },
  {
    id: "saturn",
    displayName: "Saturn",
    domains: ["saturn.de"],
    aliases: ["saturn"],
    group: "media_saturn"
  },
  {
    id: "edeka",
    displayName: "EDEKA",
    domains: ["edeka.de"],
    aliases: ["edeka", "edika"],
    group: "supermarket"
  },
  {
    id: "asian_grocery",
    displayName: "Asian grocery stores in Munich",
    domains: [],
    aliases: [
      "asian grocery",
      "asian supermarket",
      "asia supermarket",
      "asia markt",
      "asiamarkt",
      "asian market",
      "亚洲超市",
      "亚洲商店",
      "亚超",
      "亚州超市"
    ],
    group: "asian_grocery",
    openDiscovery: true
  },
  {
    id: "rossmann",
    displayName: "ROSSMANN",
    domains: ["rossmann.de"],
    aliases: ["rossmann"],
    group: "drugstore"
  },
  {
    id: "rewe",
    displayName: "REWE",
    domains: ["rewe.de"],
    aliases: ["rewe"],
    group: "supermarket"
  },
  {
    id: "penny",
    displayName: "PENNY",
    domains: ["penny.de"],
    aliases: ["penny"],
    group: "supermarket"
  },
  {
    id: "lidl",
    displayName: "Lidl",
    domains: ["lidl.de"],
    aliases: ["lidl", "idle"],
    group: "supermarket"
  },
  {
    id: "aldi",
    displayName: "ALDI SUED",
    domains: ["aldi-sued.de"],
    aliases: ["aldi", "aldi sued", "aldi sud", "aldi süd"],
    group: "supermarket"
  },
  {
    id: "ikea",
    displayName: "IKEA",
    domains: ["ikea.com/de/de"],
    aliases: ["ikea"],
    group: "ikea"
  }
];

export const allRetailerId = "all_supported";

export const supportedRetailerIds = [allRetailerId, ...retailerConfigs.map((retailer) => retailer.id)];

export const supportedRetailLookupTypes = ["price", "availability", "product_info", "price_and_availability"];

const retailerAliases = new Map(
  retailerConfigs.flatMap((retailer) => [
    [retailer.id, retailer.id],
    [retailer.displayName.toLowerCase(), retailer.id],
    ...retailer.aliases.map((alias) => [alias.toLowerCase(), retailer.id])
  ])
);

export function normalizeRetailerIds(value) {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [allRetailerId];
  const normalized = rawValues.map(normalizeRetailerId).filter(Boolean);

  if (normalized.length === 0 || normalized.includes(allRetailerId)) {
    return [allRetailerId];
  }

  return [...new Set(normalized)];
}

export function normalizeRetailerIdsForProduct(value, productQuery) {
  const normalizedRetailers = normalizeRetailerIds(value);

  if (!normalizedRetailers.includes(allRetailerId)) {
    return normalizedRetailers;
  }

  return inferRetailerIdsForProductQuery(productQuery) || normalizedRetailers;
}

export function normalizeRetailLookupType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return supportedRetailLookupTypes.includes(normalized) ? normalized : "price_and_availability";
}

export function findRetailerIdsInText(text) {
  const lowerText = String(text || "").toLowerCase();
  const matches = retailerConfigs
    .filter((retailer) =>
      [retailer.id, retailer.displayName.toLowerCase(), ...retailer.aliases].some((alias) =>
        lowerText.includes(alias.toLowerCase())
      )
    )
    .map((retailer) => retailer.id);

  if (matches.length) {
    return [...new Set(matches)];
  }

  return inferRetailerIdsForProductQuery(text) || [allRetailerId];
}

export function inferRetailerIdsForProductQuery(text) {
  if (looksLikeAsianGroceryQuery(text)) {
    return ["asian_grocery"];
  }

  return looksLikeConsumerElectronicsQuery(text) ? ["mediamarkt", "saturn"] : null;
}

export function looksLikeConsumerElectronicsQuery(text) {
  return /(ipad|iphone|apple\s*pencil|pencil\s*(?:2|.*2代)|macbook|laptop|notebook|tablet|smartphone|headphone|earbud|airpods|电脑|平板|手机|耳机|电子|电器)/i.test(
    String(text || "")
  );
}

export function looksLikeAsianGroceryQuery(text) {
  return /(asian\s*(grocery|supermarket|market)|asia\s*(markt|market|supermarket)|asiamarkt|亚洲超市|亚洲商店|亚超|亚州超市|肉松|pork\s*floss|rousong|meat\s*floss|flossy\s*pork)/i.test(
    String(text || "")
  );
}

export function expandRetailerIds(retailerIds) {
  const normalized = normalizeRetailerIds(retailerIds);
  return normalized.includes(allRetailerId)
    ? retailerConfigs
    : retailerConfigs.filter((retailer) => normalized.includes(retailer.id));
}

export function formatRetailerNames(retailerIds) {
  return expandRetailerIds(retailerIds)
    .map((retailer) => retailer.displayName)
    .join(", ");
}

function normalizeRetailerId(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized || normalized === allRetailerId || normalized === "all") {
    return allRetailerId;
  }

  return retailerAliases.get(normalized) || null;
}
