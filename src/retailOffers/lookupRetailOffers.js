import { GoogleGenAI } from "@google/genai";
import { normalizeRetailerIds, expandRetailerIds, formatRetailerNames } from "../retailerConfig.js";
import { fetchText } from "../retail/utils/fetchWithTimeout.js";
import { dedupeSources } from "../retail/utils/dedupeResults.js";
import { buildMapPlacesFromChannels } from "../retail/utils/mapPlaces.js";

const defaultLocation = "Munich, Germany";
const defaultOffersModel = "gemini-2.5-flash";
const placesTextSearchUrl = "https://places.googleapis.com/v1/places:searchText";
const munichCenter = {
  latitude: 48.137154,
  longitude: 11.576124
};
const browserHeaders = {
  "user-agent":
    process.env.RETAIL_OFFICIAL_USER_AGENT ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "de-DE,de;q=0.9,en;q=0.8"
};
const mediaSaturnOfferConfigs = {
  mediamarkt: {
    provider: "mediamarkt_official_offers",
    storeNamePattern: /media\s*markt/i,
    domainPattern: /mediamarkt\.de/i,
    officialOfferPages: [
      "https://www.mediamarkt.de/de/campaign/angebote-aktionen",
      "https://www.mediamarkt.de/de/specials"
    ],
    offerTerms: ["MediaMarkt München Angebote", "MediaMarkt Aktionen", "MediaMarkt Angebote Aktionen"]
  },
  saturn: {
    provider: "saturn_official_offers",
    storeNamePattern: /saturn/i,
    domainPattern: /saturn\.de/i,
    officialOfferPages: [
      "https://www.saturn.de/de/campaign/angebote-aktionen",
      "https://www.saturn.de/de/specials"
    ],
    offerTerms: ["Saturn München Angebote", "Saturn Aktionen", "Saturn Angebote Aktionen"]
  }
};

export async function lookupRetailOffers(args) {
  const request = normalizeOfferRequest(args);
  const primaryResults = await lookupPrimaryOfferResults(request);

  if (!process.env.GEMINI_API_KEY) {
    return combineOfferResults({
      request,
      primaryResults,
      groundingResult: null,
      groundingUnavailableMessage:
        "Google grounding fallback was skipped because GEMINI_API_KEY is not configured."
    });
  }

  const groundingResult = shouldUseGroundingFallback(primaryResults)
    ? await runOffersGrounding(request, primaryResults)
    : null;

  return combineOfferResults({
    request,
    primaryResults,
    groundingResult
  });
}

function normalizeOfferRequest(args) {
  const retailers = normalizeRetailerIds(args.retailers || args.retailer || "edeka");

  return {
    retailers,
    retailerNames: formatRetailerNames(retailers),
    retailerDomains: expandRetailerIds(retailers).flatMap((retailer) => retailer.domains),
    location: String(args.location || defaultLocation).trim(),
    period: String(args.period || "current_week").trim(),
    requestedDate: args.date || new Date().toISOString().slice(0, 10)
  };
}

async function lookupPrimaryOfferResults(request) {
  const retailers = expandRetailerIds(request.retailers);
  const results = [];

  for (const retailer of retailers) {
    if (retailer.id === "edeka") {
      results.push(await lookupEdekaOffers(request, retailer));
    } else if (mediaSaturnOfferConfigs[retailer.id]) {
      results.push(await lookupMediaSaturnOffers(request, retailer));
    }
  }

  return results;
}

async function lookupEdekaOffers(request, retailer) {
  const stores = await discoverEdekaStores(request);
  const officialPages = await collectEdekaOfferPages(stores);
  const parsedOffers = officialPages.flatMap((page) => page.parsedOffers || []);

  return {
    ok: stores.length > 0 || officialPages.length > 0,
    channel: "official_offer_discovery",
    provider: "edeka_official_offers",
    retailerId: retailer.id,
    retailer: retailer.displayName,
    status: parsedOffers.length ? "official_offer_pages_parsed" : "official_offer_pages_collected",
    request,
    stores,
    officialOfferPages: officialPages,
    offers: parsedOffers,
    sources: buildOfferPageSources(stores, officialPages),
    candidateQueries: buildEdekaOfferQueries(stores),
    priceFound: parsedOffers.some((offer) => Number.isFinite(offer.price)),
    offerFound: parsedOffers.length > 0,
    fallbackRecommended: true,
    retrievedAt: new Date().toISOString(),
    answer: `EDEKA official offer discovery found ${stores.length} Munich store candidate(s) and ${officialPages.length} official offer/prospect page candidate(s).`
  };
}

async function lookupMediaSaturnOffers(request, retailer) {
  const config = mediaSaturnOfferConfigs[retailer.id];
  const stores = await discoverRetailerStores(request, retailer, config);
  const officialPages = await collectGenericOfferPages({
    stores,
    basePages: config.officialOfferPages,
    domainPattern: config.domainPattern
  });
  const parsedOffers = officialPages.flatMap((page) => page.parsedOffers || []);

  return {
    ok: stores.length > 0 || officialPages.length > 0,
    channel: "official_offer_discovery",
    provider: config.provider,
    retailerId: retailer.id,
    retailer: retailer.displayName,
    status: parsedOffers.length ? "official_offer_pages_parsed" : "official_offer_pages_collected",
    request,
    stores,
    officialOfferPages: officialPages,
    offers: parsedOffers,
    sources: buildOfferPageSources(stores, officialPages),
    candidateQueries: buildGenericOfferQueries(retailer, stores, config),
    priceFound: parsedOffers.some((offer) => Number.isFinite(offer.price)),
    offerFound: parsedOffers.length > 0,
    fallbackRecommended: true,
    retrievedAt: new Date().toISOString(),
    answer: `${retailer.displayName} official offer discovery found ${stores.length} Munich store candidate(s) and ${officialPages.length} official offer/action page candidate(s).`
  };
}

async function discoverEdekaStores(request) {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return [];
  }

  const queries = [
    `EDEKA ${request.location}`,
    `EDEKA Angebote ${request.location}`,
    `EDEKA supermarket ${request.location}`
  ];
  const results = await Promise.all(queries.map((query) => searchGooglePlacesText(query).catch(() => [])));

  return mergeStores(results.flat())
    .filter((store) => /edeka/i.test(store.name || store.websiteUri || ""))
    .slice(0, 20);
}

async function discoverRetailerStores(request, retailer, config) {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return [];
  }

  const queries = [
    `${retailer.displayName} ${request.location}`,
    `${retailer.displayName} store ${request.location}`,
    `${retailer.displayName} Angebote ${request.location}`
  ];
  const results = await Promise.all(queries.map((query) => searchGooglePlacesText(query).catch(() => [])));

  return mergeStores(results.flat())
    .filter((store) => config.storeNamePattern.test(store.name || store.websiteUri || ""))
    .slice(0, 20);
}

async function searchGooglePlacesText(textQuery) {
  const response = await fetch(placesTextSearchUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.websiteUri,places.nationalPhoneNumber,places.businessStatus,places.types"
    },
    body: JSON.stringify({
      textQuery,
      languageCode: "de",
      regionCode: "DE",
      locationBias: {
        circle: {
          center: munichCenter,
          radius: 20000
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Google Places Text Search failed: HTTP ${response.status}`);
  }

  const payload = await response.json();

  return (payload.places || []).map((place) => ({
    placeId: place.id || null,
    name: place.displayName?.text || null,
    address: place.formattedAddress || null,
    latitude: place.location?.latitude || null,
    longitude: place.location?.longitude || null,
    location: place.location || null,
    websiteUri: place.websiteUri || null,
    phone: place.nationalPhoneNumber || null,
    googleMapsUri: place.googleMapsUri || null,
    businessStatus: place.businessStatus || null,
    types: place.types || [],
    discoveryQuery: textQuery,
    source: "google_places"
  }));
}

async function collectEdekaOfferPages(stores) {
  const candidates = [
    "https://www.edeka.de/eh/angebote.jsp",
    ...stores.flatMap((store) => buildEdekaOfferLinkCandidates(store))
  ];
  const uniqueCandidates = [...new Set(candidates)].slice(0, 30);
  const pages = await mapWithConcurrency(uniqueCandidates, 6, fetchOfficialOfferPageSafely);
  const linkedUris = [
    ...new Set(
      pages
        .flatMap((page) => page.offerLinks || [])
        .filter((uri) => uri && !uniqueCandidates.includes(uri))
    )
  ].slice(0, Math.max(0, 40 - pages.length));
  const linkedPages = await mapWithConcurrency(linkedUris, 6, fetchOfficialOfferPageSafely);

  return [...pages, ...linkedPages].filter((page) => page.ok || page.status !== "fetch_failed");
}

async function collectGenericOfferPages({ stores, basePages, domainPattern }) {
  const candidates = [
    ...basePages,
    ...stores.flatMap((store) => buildGenericOfferLinkCandidates(store, domainPattern))
  ];
  const uniqueCandidates = [...new Set(candidates)].slice(0, 28);
  const pages = await mapWithConcurrency(uniqueCandidates, 6, fetchOfficialOfferPageSafely);
  const linkedUris = [
    ...new Set(
      pages
        .flatMap((page) => page.offerLinks || [])
        .filter((uri) => uri && !uniqueCandidates.includes(uri) && domainPattern.test(uri))
    )
  ].slice(0, Math.max(0, 40 - pages.length));
  const linkedPages = await mapWithConcurrency(linkedUris, 6, fetchOfficialOfferPageSafely);

  return [...pages, ...linkedPages].filter((page) => page.ok || page.status !== "fetch_failed");
}

async function fetchOfficialOfferPageSafely(uri) {
  return fetchOfficialOfferPage(uri).catch((error) => ({
    uri,
    ok: false,
    status: "fetch_failed",
    error: error.message,
    parsedOffers: []
  }));
}

async function fetchOfficialOfferPage(uri) {
  const response = await fetchText(uri, {
    headers: browserHeaders
  });
  const title = extractTitle(response.text);

  return {
    uri,
    ok: response.ok,
    status: response.ok ? "fetched" : `http_${response.status}`,
    title,
    offerLinks: extractOfferLinks(response.text, uri).slice(0, 8),
    parsedOffers: parsePriceSnippets(response.text, uri, title).slice(0, 12)
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return results;
}

function buildGenericOfferLinkCandidates(store, domainPattern) {
  if (!store.websiteUri || !domainPattern.test(store.websiteUri)) {
    return [];
  }

  const candidates = [store.websiteUri];

  try {
    const url = new URL(store.websiteUri);
    candidates.push(new URL("/de/campaign/angebote-aktionen", url.origin).toString());
    candidates.push(new URL("/de/specials", url.origin).toString());
  } catch {
    return candidates;
  }

  return candidates;
}

function buildEdekaOfferLinkCandidates(store) {
  if (!store.websiteUri || !/edeka\.de/i.test(store.websiteUri)) {
    return [];
  }

  const candidates = [store.websiteUri];

  try {
    const url = new URL(store.websiteUri);
    const path = url.pathname;

    if (path.endsWith("/index.jsp")) {
      candidates.push(new URL(path.replace(/index\.jsp$/, "angebote.jsp"), url.origin).toString());
      candidates.push(new URL(path.replace(/index\.jsp$/, "prospekt.jsp"), url.origin).toString());
    }

    if (path.endsWith("/")) {
      candidates.push(new URL("angebote/", url).toString());
      candidates.push(new URL("angebote.jsp", url).toString());
      candidates.push(new URL("prospekt.jsp", url).toString());
    }
  } catch {
    return candidates;
  }

  return candidates;
}

function extractOfferLinks(html, baseUri) {
  const links = [];
  const pattern = /href=["']([^"']+)["']/gi;
  let match = pattern.exec(String(html || ""));

  while (match) {
    const href = match[1];

    if (/(angebote|angebot|prospekt|aktion|aktionen|campaign|special|deals|sale|fundgrube|outlet)/i.test(href)) {
      try {
        const uri = new URL(href, baseUri).toString();

        if (/(edeka|mediamarkt|saturn)\.de/i.test(uri)) {
          links.push(uri);
        }
      } catch {
        // Ignore invalid links.
      }
    }

    match = pattern.exec(String(html || ""));
  }

  return [...new Set(links)];
}

function parsePriceSnippets(html, sourceUrl, sourceTitle) {
  const text = stripHtml(html).replace(/\s+/g, " ");
  const offers = [];
  const pricePattern = /(.{0,90}?)(\d{1,3}[,.]\d{2})\s*€/g;
  let match = pricePattern.exec(text);

  while (match) {
    const context = cleanupSnippet(match[1]);
    const price = Number.parseFloat(match[2].replace(",", "."));

    if (Number.isFinite(price) && context && !/cookie|datenschutz|liefer|versand|summe/i.test(context)) {
      offers.push({
        offerTitle: context.slice(-90),
        productName: context.slice(-90),
        price,
        currency: "EUR",
        sourceUrl,
        sourceTitle,
        confidence: "low"
      });
    }

    match = pricePattern.exec(text);
  }

  return offers;
}

async function runOffersGrounding(request, primaryResults) {
  const model = process.env.RETAIL_OFFERS_MODEL || process.env.GEMINI_MODEL || defaultOffersModel;
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });
  const groundingPrompt = buildOffersGroundingPrompt(request, primaryResults);
  const response = await ai.models.generateContent({
    model,
    contents: groundingPrompt,
    config: {
      temperature: 0,
      tools: [
        {
          googleSearch: {}
        }
      ]
    }
  });
  const rawEvidenceText = String(response.text || "").trim();
  const evidence = parseOfferEvidence(rawEvidenceText);
  const grounding = extractGroundingMetadata(response);

  return {
    ok: hasOfferEvidence(evidence),
    channel: "google_grounding",
    provider: "gemini_google_search_grounding",
    model,
    request,
    evidence,
    rawEvidenceText,
    answer: evidence.summary || "Grounded offer evidence lookup completed.",
    sources: grounding.sources,
    searchQueries: grounding.searchQueries,
    retrievedAt: new Date().toISOString(),
    debug: {
      groundingPrompt
    }
  };
}

function buildOffersGroundingPrompt(request, primaryResults) {
  const officialContext = primaryResults.map((result) => ({
    provider: result.provider,
    retailer: result.retailer,
    status: result.status,
    stores: (result.stores || []).slice(0, 20),
    officialOfferPages: (result.officialOfferPages || []).slice(0, 20),
    parsedOffers: (result.offers || []).slice(0, 20),
    candidateQueries: (result.candidateQueries || []).slice(0, 30)
  }));

  return `
You are a retail offers evidence extraction component.

Goal:
Find current or recent discounts/offers near ${request.location}.

Request:
- Date: ${request.requestedDate}
- Period: ${request.period}
- Retailer scope: ${request.retailerNames}
- Location: ${request.location}
- Official domains: ${request.retailerDomains.join(", ") || "unknown"}

Official/provider context already collected by the app:
${JSON.stringify(officialContext, null, 2)}

Search guidance:
- Use Google Search grounding.
- Prioritize official retailer pages, official store pages, Angebote/Aktionen pages, campaign pages, and prospect pages.
- If official pages are not parseable, use grounding to identify offer/prospect evidence and source URLs.
- Search German terms combining the retailer names with: München Angebote, Aktionen, Deals, Prospekt, Angebote der Woche, Markt Angebote.
- Do not invent products, prices, validity dates, or store-specific offers.
- Distinguish confirmed current offers from pages that only prove an offer/prospect page exists.

Return only valid JSON. Do not include markdown.
Use this schema:
{
  "summary": "Short factual summary.",
  "confirmedOffers": [
    {
      "retailer": "Retailer name",
      "storeName": "Store name if known",
      "address": "Store address if known",
      "offerTitle": "Offer/product name",
      "price": 0,
      "oldPrice": 0,
      "currency": "EUR",
      "discountText": "Discount wording if visible",
      "validFrom": "YYYY-MM-DD or unknown",
      "validTo": "YYYY-MM-DD or unknown",
      "sourceTitle": "Source title",
      "sourceUrl": "https://...",
      "confidence": "high | medium | low"
    }
  ],
  "officialOfferPages": [
    {
      "storeName": "Store name if known",
      "sourceTitle": "Official offer/prospect page",
      "sourceUrl": "https://...",
      "parsed": true,
      "confidence": "high | medium | low"
    }
  ],
  "notParsed": [
    {
      "storeName": "Store/page name",
      "sourceUrl": "https://...",
      "reason": "Why no offer items could be extracted"
    }
  ],
  "storesSearched": ["Store names searched"],
  "caveats": ["Important caveats about store-specificity, validity, or parsing."]
}
`.trim();
}

function combineOfferResults({ request, primaryResults = [], groundingResult, groundingUnavailableMessage }) {
  const channels = [...primaryResults, groundingResult].filter(Boolean);
  const sources = dedupeSources(channels.flatMap((channel) => channel.sources || []));
  const mapPlaces = buildMapPlacesFromChannels(channels);
  const searchQueries = [
    ...primaryResults.flatMap((result) => result.candidateQueries || []),
    ...(groundingResult?.searchQueries || [])
  ];
  const evidence = {
    providerChannels: primaryResults.map((result) => ({
      provider: result.provider,
      channel: result.channel,
      retailer: result.retailer,
      status: result.status,
      stores: result.stores || [],
      officialOfferPages: result.officialOfferPages || [],
      parsedOffers: result.offers || [],
      sources: result.sources || []
    })),
    grounded: groundingResult?.evidence || null,
    groundingRawText: groundingResult?.rawEvidenceText || null,
    groundingSources: groundingResult?.sources || [],
    groundingSearchQueries: groundingResult?.searchQueries || []
  };
  const ok = channels.some((channel) => channel.ok);
  const provider = groundingResult
    ? primaryResults.length
      ? "official_offers_then_google_grounding"
      : "gemini_google_search_grounding"
    : primaryResults.length
      ? "official_offers"
      : "unknown";
  const message = groundingUnavailableMessage
    ? `Retail offers lookup completed with no grounding: ${groundingUnavailableMessage}`
    : `Retail offers lookup tool completed: ${primaryResults.length} primary offer provider result(s)${groundingResult ? ", grounded evidence result" : ""}.`;

  return {
    ok,
    provider,
    request,
    message,
    answer: message,
    evidence,
    sources,
    mapPlaces,
    searchQueries,
    channels,
    retrievedAt: new Date().toISOString(),
    caveats: [
      "Official retailer pages are preferred when available.",
      "Offer availability and validity can differ by store and date.",
      "If official pages are not parseable, grounded evidence should be treated as web research rather than an inventory guarantee."
    ],
    requiresFinalSynthesis: true,
    debug: {
      primaryResults,
      groundingPrompt: groundingResult?.debug?.groundingPrompt || null
    }
  };
}

function shouldUseGroundingFallback(primaryResults) {
  if (process.env.RETAIL_SEARCH_GOOGLE_FALLBACK === "false") {
    return false;
  }

  return (
    !primaryResults.length ||
    primaryResults.some((result) => result.fallbackRecommended) ||
    primaryResults.every((result) => !(result.offers || []).length)
  );
}

function buildEdekaOfferQueries(stores) {
  return [
    "EDEKA München Angebote",
    "EDEKA München Prospekt",
    ...stores.slice(0, 12).map((store) => `"${store.name}" Angebote Prospekt`)
  ];
}

function buildGenericOfferQueries(retailer, stores, config) {
  return [
    ...config.offerTerms,
    `${retailer.displayName} München Prospekt`,
    `${retailer.displayName} München Deals`,
    ...stores.slice(0, 12).map((store) => `"${store.name}" Angebote Aktionen`)
  ];
}

function buildOfferPageSources(stores, officialPages) {
  const storeSources = stores
    .filter((store) => store.googleMapsUri || store.websiteUri)
    .slice(0, 12)
    .map((store, index) => ({
      index: index + 1,
      title: store.name,
      uri: store.websiteUri || store.googleMapsUri,
      channel: "store_discovery"
    }));
  const pageSources = officialPages
    .filter((page) => page.uri)
    .slice(0, 20)
    .map((page, index) => ({
      index: storeSources.length + index + 1,
      title: page.title || page.uri,
      uri: page.uri,
      channel: "official_offer_discovery"
    }));

  return [...storeSources, ...pageSources];
}

function parseOfferEvidence(rawText) {
  const fallbackEvidence = {
    summary: rawText || "No grounded offer evidence was returned.",
    confirmedOffers: [],
    officialOfferPages: [],
    notParsed: [],
    storesSearched: [],
    caveats: []
  };

  if (!rawText) {
    return fallbackEvidence;
  }

  try {
    const source = JSON.parse(stripJsonFence(rawText));

    return {
      summary: typeof source.summary === "string" ? source.summary : "",
      confirmedOffers: Array.isArray(source.confirmedOffers) ? source.confirmedOffers : [],
      officialOfferPages: Array.isArray(source.officialOfferPages) ? source.officialOfferPages : [],
      notParsed: Array.isArray(source.notParsed) ? source.notParsed : [],
      storesSearched: Array.isArray(source.storesSearched)
        ? source.storesSearched.map((store) => String(store || "").trim()).filter(Boolean)
        : [],
      caveats: Array.isArray(source.caveats)
        ? source.caveats.map((caveat) => String(caveat || "").trim()).filter(Boolean)
        : []
    };
  } catch {
    return fallbackEvidence;
  }
}

function hasOfferEvidence(evidence) {
  return Boolean(
    evidence.summary ||
      evidence.confirmedOffers.length ||
      evidence.officialOfferPages.length ||
      evidence.notParsed.length
  );
}

function extractGroundingMetadata(response) {
  const metadata = response.candidates?.[0]?.groundingMetadata || {};
  const sources = (metadata.groundingChunks || [])
    .map((chunk, index) => ({
      index: index + 1,
      title: chunk.web?.title || "Source",
      uri: chunk.web?.uri || null
    }))
    .filter((source) => source.uri);

  return {
    sources,
    searchQueries: metadata.webSearchQueries || []
  };
}

function mergeStores(stores) {
  const seen = new Set();
  const merged = [];

  for (const store of stores) {
    const key = store.placeId || `${normalizeKey(store.name)}|${normalizeKey(store.address)}`;

    if (!store.name || seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(store);
  }

  return merged;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanupSnippet(match[1]) : null;
}

function cleanupSnippet(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function stripJsonFence(rawText) {
  return String(rawText)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
