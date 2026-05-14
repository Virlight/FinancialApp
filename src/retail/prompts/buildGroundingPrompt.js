export function buildGroundingPrompt(request, primaryResults) {
  const siteFilters = request.retailerDomains.map((domain) => `site:${domain}`).join(" OR ");
  const usefulSearchConstraint = siteFilters
    ? `(${siteFilters}) "${request.productQuery}" "${request.location}" price availability store.`
    : `"${request.productQuery}" "${request.location}" price availability store.`;
  const candidateQueries = [
    ...new Set(primaryResults.flatMap((result) => result.candidateQueries || []))
  ];
  const candidateStores = mergeCandidateStores(primaryResults.flatMap((result) => result.candidateStores || result.stores || []));
  const candidateStoresText = candidateStores
    .slice(0, 20)
    .map((store) =>
      [
        store.name,
        store.address ? `address: ${store.address}` : null,
        store.websiteUri ? `website: ${store.websiteUri}` : null,
        store.phone ? `phone: ${store.phone}` : null,
        store.googleMapsUri ? `maps: ${store.googleMapsUri}` : null,
        store.source ? `source: ${store.source}` : null
      ]
        .filter(Boolean)
        .join(" | ")
    )
    .join("\n");
  const openDiscoveryGuidance = request.openDiscovery
    ? `
Open retailer discovery:
- This request is about a retailer category, not a fixed store list.
- The app has a two-step plan: first discover relevant stores in or near Munich, then look for product evidence on official pages, store pages, delivery pages, menus/catalogs, or credible local listings.
- Do not limit yourself to preconfigured domains. It is acceptable to include any Asian supermarket, Asia Markt, Chinese/Korean/Japanese/Vietnamese grocery, or international grocery in Munich if the source supports it.
- Search multilingual product terms when useful: 肉松, pork floss, rousong, meat floss, flossy pork, Schweinefleischflocken, Fleischwatte.
- Clearly separate verified product availability from likely leads. If a store is only a plausible place to ask, label it as a lead, not confirmed stock.
- Candidate stores from the app discovery step:
${candidateStoresText || "No candidate stores were found before grounding."}
${candidateQueries.length ? `- Useful discovery queries from the app: ${candidateQueries.join(" | ")}` : ""}
`.trim()
    : "";
  const primaryContext = primaryResults.length
    ? `
Official/provider lookup already performed by the app:
${JSON.stringify(
  primaryResults.map((result) => ({
    channel: result.channel,
    provider: result.provider,
    retailer: result.retailer,
    status: result.status,
    answer: result.answer,
    products: (result.products || []).slice(0, 5),
    priceFound: result.priceFound,
    availabilityFound: result.availabilityFound,
    officialSearchTerms: result.officialSearchTerms,
    candidateStores: (result.candidateStores || result.stores || []).slice(0, 12),
    candidateQueries: (result.candidateQueries || []).slice(0, 20)
  })),
  null,
  2
)}
`.trim()
    : "No official/provider lookup result was available before this Google fallback.";

  return `
You are a production retail product research component.

Goal:
Find current product information for physical stores near ${request.location}.

Request:
- Date: ${request.requestedDate}
- Retailer scope: ${request.retailerNames}
- Official retailer domains to prioritize: ${request.retailerDomains.join(", ")}
- Product query: ${request.productQuery}
- Lookup type: ${request.lookupType}

${primaryContext}

Search guidance:
- Use Google Search grounding.
- This is a fallback channel. Prefer official retailer pages and official store/product availability pages.
- If an official/provider lookup result is provided above, treat it as primary evidence and use Google only to fill missing price, offer, or store-specific availability.
- ${request.openDiscovery ? "Because this is an open discovery request, broaden beyond configured retailer domains when needed." : "Stay focused on the configured retailer scope."}
- If the product query is not German, also search the likely German retail term.
- Useful search constraint: ${usefulSearchConstraint}
- Also try German retail words such as Preis, Verfuegbarkeit, Markt, Filiale, Muenchen when useful.
- Do not scrape or infer from unrelated marketplaces.
- Do not invent exact prices, stock, or store availability.
- If exact Munich physical-store price is not visible, say that clearly and provide the best verified online or official source result.
- If no official source is found, say no official source was found.
- Clearly distinguish official retailer sources from third-party fallback sources.

${openDiscoveryGuidance}

Return only valid JSON. Do not include markdown.
Use this schema:
{
  "summary": "Short factual summary of what the evidence shows.",
  "confirmed": [
    {
      "storeName": "Retailer/store name",
      "storeType": "physical_store | online_store | delivery_platform | unknown",
      "productName": "Matched product name",
      "price": 0,
      "currency": "EUR",
      "availability": "available | unavailable | unknown",
      "storeSpecific": true,
      "sourceTitle": "Source title",
      "sourceUrl": "https://...",
      "evidenceText": "Short evidence note",
      "confidence": "high | medium | low"
    }
  ],
  "strongLeads": [
    {
      "storeName": "Store name",
      "reason": "Why this store is a strong lead, without claiming confirmed stock.",
      "sourceTitle": "Source title",
      "sourceUrl": "https://...",
      "confidence": "medium | low"
    }
  ],
  "onlineOnly": [
    {
      "storeName": "Online retailer",
      "productName": "Matched product name",
      "price": 0,
      "currency": "EUR",
      "sourceTitle": "Source title",
      "sourceUrl": "https://...",
      "confidence": "high | medium | low"
    }
  ],
  "notConfirmed": [
    {
      "storeName": "Store name",
      "reason": "Why product availability was not confirmed."
    }
  ],
  "searchedStores": ["Store names searched"],
  "caveats": ["Important caveats about online-only prices, stale pages, or missing store-specific stock."]
}
`.trim();
}

function mergeCandidateStores(stores) {
  const seen = new Set();
  const merged = [];

  for (const store of stores) {
    const key = store.placeId || `${normalizeStoreKey(store.name)}|${normalizeStoreKey(store.address || store.searchName)}`;

    if (!store.name || seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(store);
  }

  return merged;
}

function normalizeStoreKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
