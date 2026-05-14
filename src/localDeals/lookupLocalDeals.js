import { GoogleGenAI } from "@google/genai";
import { fetchText } from "../retail/utils/fetchWithTimeout.js";
import { dedupeSources } from "../retail/utils/dedupeResults.js";
import { buildMapPlacesFromChannels } from "../retail/utils/mapPlaces.js";

const defaultLocation = "Munich, Germany";
const defaultDealsModel = "gemini-2.5-flash";
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
const knownMerchantConfigs = [
  {
    id: "mcdonalds",
    displayName: "McDonald's",
    aliases: ["mcdonalds", "mcdonald's", "mcdonald", "麦当劳", "麦當勞"],
    domainPattern: /mcdonalds\.(com|de)/i,
    officialDealPages: [
      "https://www.mcdonalds.com/de/de-de/angebote.html",
      "https://www.mcdonalds.com/de/de-de/app.html"
    ],
    searchTerms: ["McDonald's München Angebote", "McDonald's App Coupons Deutschland", "McDonald's Gutscheine München"]
  },
  {
    id: "burger_king",
    displayName: "Burger King",
    aliases: ["burger king", "汉堡王", "漢堡王"],
    domainPattern: /burgerking\.de/i,
    officialDealPages: ["https://www.burgerking.de/coupons"],
    searchTerms: ["Burger King München Coupons", "Burger King Gutscheine München"]
  },
  {
    id: "kfc",
    displayName: "KFC",
    aliases: ["kfc", "肯德基"],
    domainPattern: /kfc\.de/i,
    officialDealPages: ["https://www.kfc.de/angebote"],
    searchTerms: ["KFC München Angebote", "KFC Gutscheine München"]
  },
  {
    id: "subway",
    displayName: "Subway",
    aliases: ["subway", "赛百味", "賽百味"],
    domainPattern: /subway\.com|subway-sandwiches\.de/i,
    officialDealPages: [],
    searchTerms: ["Subway München Angebote", "Subway Gutscheine München"]
  },
  {
    id: "starbucks",
    displayName: "Starbucks",
    aliases: ["starbucks", "星巴克"],
    domainPattern: /starbucks\.de|starbucks\.com/i,
    officialDealPages: [],
    searchTerms: ["Starbucks München Angebote", "Starbucks Rewards Deutschland"]
  }
];

export async function lookupLocalDeals(args = {}, options = {}) {
  const request = normalizeLocalDealRequest(args);

  emitProgress(options, {
    stage: "official_page_fetching",
    message: `Checking local deal sources for ${request.merchantQuery}.`
  });
  throwIfAborted(options.signal);

  const primaryResult = await lookupPrimaryLocalDeals(request, options);
  const primaryResults = [primaryResult];

  emitProgress(options, {
    stage: "places_search_done",
    message: primaryResult.mapPlaces.length
      ? `Found ${primaryResult.mapPlaces.length} nearby place candidate(s).`
      : "Local place discovery completed with no mapped places.",
    data: {
      productQuery: request.productQuery || request.merchantQuery,
      merchantQuery: request.merchantQuery,
      mapPlaces: primaryResult.mapPlaces,
      places: primaryResult.stores,
      candidateQueries: primaryResult.candidateQueries
    }
  });
  throwIfAborted(options.signal);

  if (!process.env.GEMINI_API_KEY) {
    return combineLocalDealResults({
      request,
      primaryResults,
      groundingResult: null,
      groundingUnavailableMessage:
        "Google grounding fallback was skipped because GEMINI_API_KEY is not configured."
    });
  }

  emitProgress(options, {
    stage: "grounding_started",
    message: `Running Google Search grounding for ${request.merchantQuery} deals.`
  });
  throwIfAborted(options.signal);

  const groundingResult = await runLocalDealsGrounding(request, primaryResults);

  return combineLocalDealResults({
    request,
    primaryResults,
    groundingResult
  });
}

function normalizeLocalDealRequest(args) {
  const merchantQuery = normalizeText(args.merchantQuery || args.merchant || args.storeName || args.productQuery) || "local merchant";
  const merchantConfig = findKnownMerchantConfig(merchantQuery);
  const productQuery = normalizeText(args.productQuery || args.itemName || "");

  return {
    merchantQuery: merchantConfig?.displayName || merchantQuery,
    rawMerchantQuery: merchantQuery,
    merchantId: merchantConfig?.id || null,
    merchantAliases: merchantConfig?.aliases || [merchantQuery],
    productQuery,
    category: normalizeText(args.category) || "food",
    location: normalizeText(args.location) || defaultLocation,
    period: normalizeText(args.period) || "current_week",
    requestedDate: args.date || new Date().toISOString().slice(0, 10),
    knownMerchant: merchantConfig
  };
}

async function lookupPrimaryLocalDeals(request, options) {
  const stores = await discoverLocalMerchantPlaces(request, options);
  const officialPages = await collectLocalDealPages(request, stores, options);
  const parsedDeals = officialPages.flatMap((page) => page.parsedDeals || []);
  const mapPlaces = buildMapPlacesFromChannels([
    {
      provider: "google_places_text_search",
      stores,
      candidateStores: stores
    }
  ]);

  return {
    ok: stores.length > 0 || officialPages.length > 0,
    channel: "local_deal_discovery",
    provider: "local_places_and_official_pages",
    merchant: request.merchantQuery,
    request,
    stores,
    mapPlaces,
    officialDealPages: officialPages,
    deals: parsedDeals,
    sources: buildLocalDealSources(stores, officialPages),
    candidateQueries: buildLocalDealQueries(request),
    dealFound: parsedDeals.length > 0,
    fallbackRecommended: true,
    retrievedAt: new Date().toISOString(),
    answer: `Local deal discovery found ${stores.length} place candidate(s) and ${officialPages.length} official/deal page candidate(s) for ${request.merchantQuery}.`
  };
}

async function discoverLocalMerchantPlaces(request, options) {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return [];
  }

  const fetcher = options.fetcher || fetch;
  const queries = buildLocalDealQueries(request).slice(0, 4);
  const results = await Promise.all(
    queries.map((query) =>
      searchGooglePlacesText(query, {
        fetcher,
        signal: options.signal
      }).catch(() => [])
    )
  );

  return mergeStores(results.flat())
    .filter((store) => placeMatchesMerchant(request, store))
    .slice(0, 20);
}

function buildLocalDealQueries(request) {
  const merchant = request.merchantQuery;
  const rawMerchant = request.rawMerchantQuery;

  return [
    `${merchant} ${request.location}`,
    `${merchant} restaurant ${request.location}`,
    `${merchant} Angebote ${request.location}`,
    `${merchant} coupons ${request.location}`,
    rawMerchant && rawMerchant !== merchant ? `${rawMerchant} ${request.location}` : null,
    ...(request.knownMerchant?.searchTerms || [])
  ].filter(Boolean);
}

async function searchGooglePlacesText(textQuery, options) {
  const response = await options.fetcher(placesTextSearchUrl, {
    method: "POST",
    signal: options.signal,
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

async function collectLocalDealPages(request, stores, options) {
  const candidates = [
    ...(request.knownMerchant?.officialDealPages || []),
    ...stores.flatMap((store) => buildDealLinkCandidates(request, store))
  ];
  const uniqueCandidates = [...new Set(candidates)].slice(0, 20);
  const pages = await mapWithConcurrency(uniqueCandidates, 5, (uri) =>
    fetchDealPageSafely(uri, options)
  );
  const linkedUris = [
    ...new Set(
      pages
        .flatMap((page) => page.dealLinks || [])
        .filter((uri) => uri && !uniqueCandidates.includes(uri))
    )
  ].slice(0, Math.max(0, 30 - pages.length));
  const linkedPages = await mapWithConcurrency(linkedUris, 5, (uri) =>
    fetchDealPageSafely(uri, options)
  );

  return [...pages, ...linkedPages].filter((page) => page.ok || page.status !== "fetch_failed");
}

function buildDealLinkCandidates(request, store) {
  if (!store.websiteUri) {
    return [];
  }

  if (request.knownMerchant?.domainPattern && !request.knownMerchant.domainPattern.test(store.websiteUri)) {
    return [store.websiteUri];
  }

  const candidates = [store.websiteUri];

  try {
    const url = new URL(store.websiteUri);

    for (const path of ["/angebote", "/angebote.html", "/coupons", "/gutscheine", "/deals", "/app"]) {
      candidates.push(new URL(path, url.origin).toString());
    }
  } catch {
    return candidates;
  }

  return candidates;
}

async function fetchDealPageSafely(uri, options) {
  return fetchDealPage(uri, options).catch((error) => ({
    uri,
    ok: false,
    status: "fetch_failed",
    error: error.message,
    parsedDeals: []
  }));
}

async function fetchDealPage(uri, options = {}) {
  const response = await fetchText(uri, {
    fetcher: options.fetcher,
    signal: options.signal,
    headers: browserHeaders
  });
  const title = extractTitle(response.text);

  return {
    uri,
    ok: response.ok,
    status: response.ok ? "fetched" : `http_${response.status}`,
    title,
    dealLinks: extractDealLinks(response.text, uri).slice(0, 8),
    parsedDeals: parseDealSnippets(response.text, uri, title).slice(0, 12)
  };
}

async function runLocalDealsGrounding(request, primaryResults) {
  const model = process.env.LOCAL_DEALS_MODEL || process.env.GEMINI_MODEL || defaultDealsModel;
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });
  const groundingPrompt = buildLocalDealsGroundingPrompt(request, primaryResults);
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
  const evidence = parseLocalDealEvidence(rawEvidenceText);
  const grounding = extractGroundingMetadata(response);

  return {
    ok: hasLocalDealEvidence(evidence),
    channel: "google_grounding",
    provider: "gemini_google_search_grounding",
    model,
    request,
    evidence,
    rawEvidenceText,
    answer: evidence.summary || "Grounded local deal evidence lookup completed.",
    sources: grounding.sources,
    searchQueries: grounding.searchQueries,
    retrievedAt: new Date().toISOString(),
    debug: {
      groundingPrompt
    }
  };
}

function buildLocalDealsGroundingPrompt(request, primaryResults) {
  const primaryContext = primaryResults.map((result) => ({
    provider: result.provider,
    merchant: result.merchant,
    stores: (result.stores || []).slice(0, 20),
    officialDealPages: (result.officialDealPages || []).slice(0, 20),
    parsedDeals: (result.deals || []).slice(0, 20),
    candidateQueries: (result.candidateQueries || []).slice(0, 30)
  }));

  return `
You are a local merchant discount evidence extraction component.

Goal:
Find current or recent discounts, coupons, app offers, meal deals, or promotions near ${request.location}.

Request:
- Date: ${request.requestedDate}
- Period: ${request.period}
- Merchant/brand: ${request.merchantQuery}
- Product or meal context: ${request.productQuery || "not specified"}
- Category: ${request.category}
- Location: ${request.location}

Official/place context already collected by the app:
${JSON.stringify(primaryContext, null, 2)}

Search guidance:
- Use Google Search grounding.
- Prioritize official merchant pages, official app/coupon pages, store pages, and official social/offer pages.
- For food chains, also search German terms: Angebote, Gutscheine, Coupons, App, Aktion, Menü, München.
- Do not invent exact prices, coupon terms, validity windows, or store-specific availability.
- Distinguish confirmed current offers from generic app/coupon pages and from no confirmed offer.
- If the best evidence is an app-only offer page without visible exact prices, say that clearly.

Return only valid JSON. Do not include markdown.
Use this schema:
{
  "summary": "Short factual summary.",
  "confirmedDeals": [
    {
      "merchant": "Merchant name",
      "storeName": "Store name if known",
      "address": "Store address if known",
      "dealTitle": "Deal/coupon/offer name",
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
  "officialDealPages": [
    {
      "merchant": "Merchant name",
      "sourceTitle": "Official app/coupon/offer page",
      "sourceUrl": "https://...",
      "parsed": true,
      "confidence": "high | medium | low"
    }
  ],
  "notConfirmed": [
    {
      "merchant": "Merchant/page name",
      "sourceUrl": "https://...",
      "reason": "Why no current exact discount could be confirmed"
    }
  ],
  "storesSearched": ["Store names searched"],
  "caveats": ["Important caveats about app-only coupons, store-specificity, validity, or parsing."]
}
`.trim();
}

function combineLocalDealResults({ request, primaryResults = [], groundingResult, groundingUnavailableMessage }) {
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
      merchant: result.merchant,
      stores: result.stores || [],
      officialDealPages: result.officialDealPages || [],
      parsedDeals: result.deals || [],
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
      ? "local_places_then_google_grounding"
      : "gemini_google_search_grounding"
    : primaryResults.length
      ? "local_places_and_official_pages"
      : "unknown";
  const message = groundingUnavailableMessage
    ? `Local deal lookup completed with no grounding: ${groundingUnavailableMessage}`
    : `Local deal lookup completed: ${primaryResults.length} primary provider result(s)${groundingResult ? ", grounded evidence result" : ""}.`;

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
      "Official merchant pages are preferred when available.",
      "Restaurant offers can be app-only, personalized, time-limited, or store-specific.",
      "Grounded evidence is not a guarantee that a nearby store will honor the offer."
    ],
    requiresFinalSynthesis: true,
    debug: {
      primaryResults,
      groundingPrompt: groundingResult?.debug?.groundingPrompt || null
    }
  };
}

function findKnownMerchantConfig(text) {
  const normalized = normalizeMerchantText(text);

  return knownMerchantConfigs.find((config) =>
    config.aliases.some((alias) => normalized.includes(normalizeMerchantText(alias)))
  );
}

export function extractKnownMerchantName(text) {
  const config = findKnownMerchantConfig(text);

  return config?.displayName || null;
}

export function looksLikeFoodMerchant(text) {
  return Boolean(
    findKnownMerchantConfig(text) ||
      /(restaurant|cafe|café|burger|pizza|sushi|ramen|döner|kebab|bakery|bäckerei|餐厅|饭店|咖啡|汉堡|披萨|寿司|拉面|烤肉|面包店|套餐)/i.test(
        text
      )
  );
}

function placeMatchesMerchant(request, place) {
  if (!request.knownMerchant) {
    return true;
  }

  const haystack = normalizeMerchantText(`${place.name || ""} ${place.websiteUri || ""}`);

  return request.knownMerchant.aliases.some((alias) =>
    haystack.includes(normalizeMerchantText(alias))
  );
}

function buildLocalDealSources(stores, pages) {
  const storeSources = stores
    .filter((store) => store.googleMapsUri || store.websiteUri)
    .slice(0, 12)
    .map((store, index) => ({
      index: index + 1,
      title: store.name,
      uri: store.websiteUri || store.googleMapsUri,
      channel: "store_discovery"
    }));
  const pageSources = pages
    .filter((page) => page.uri)
    .slice(0, 20)
    .map((page, index) => ({
      index: storeSources.length + index + 1,
      title: page.title || page.uri,
      uri: page.uri,
      channel: "deal_page_discovery"
    }));

  return [...storeSources, ...pageSources];
}

function extractDealLinks(html, baseUri) {
  const links = [];
  const pattern = /href=["']([^"']+)["']/gi;
  let match = pattern.exec(String(html || ""));

  while (match) {
    const href = match[1];

    if (/(angebot|angebote|coupon|coupons|gutschein|gutscheine|deal|deals|aktion|aktionen|app|reward|sale)/i.test(href)) {
      try {
        links.push(new URL(href, baseUri).toString());
      } catch {
        // Ignore invalid links.
      }
    }

    match = pattern.exec(String(html || ""));
  }

  return [...new Set(links)];
}

function parseDealSnippets(html, sourceUrl, sourceTitle) {
  const text = stripHtml(html).replace(/\s+/g, " ");
  const deals = [];
  const pricePattern = /(.{0,100}?)(\d{1,3}[,.]\d{2})\s*€/g;
  let match = pricePattern.exec(text);

  while (match) {
    const context = cleanupSnippet(match[1]);
    const price = Number.parseFloat(match[2].replace(",", "."));

    if (Number.isFinite(price) && context && !/cookie|datenschutz|liefer|versand|summe/i.test(context)) {
      deals.push({
        dealTitle: context.slice(-100),
        price,
        currency: "EUR",
        sourceUrl,
        sourceTitle,
        confidence: "low"
      });
    }

    match = pricePattern.exec(text);
  }

  return deals;
}

function parseLocalDealEvidence(rawText) {
  const fallbackEvidence = {
    summary: rawText || "No grounded local deal evidence was returned.",
    confirmedDeals: [],
    officialDealPages: [],
    notConfirmed: [],
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
      confirmedDeals: Array.isArray(source.confirmedDeals) ? source.confirmedDeals : [],
      officialDealPages: Array.isArray(source.officialDealPages) ? source.officialDealPages : [],
      notConfirmed: Array.isArray(source.notConfirmed) ? source.notConfirmed : [],
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

function hasLocalDealEvidence(evidence) {
  return Boolean(
    evidence.summary ||
      evidence.confirmedDeals.length ||
      evidence.officialDealPages.length ||
      evidence.notConfirmed.length
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

function normalizeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeMerchantText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\s+/g, "");
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function emitProgress(options, event) {
  if (typeof options.onProgress === "function") {
    options.onProgress(event);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new Error("Local deal lookup was cancelled.");
  }
}
