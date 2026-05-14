import { extractJsonLdPayloads, findProductsInJsonLd } from "../parsers/jsonLdParser.js";
import { formatPrice } from "../parsers/priceParser.js";
import { fetchText, looksLikeAccessChallenge } from "../utils/fetchWithTimeout.js";
import { normalizeSearchText, uniqueTerms } from "../utils/normalizeProductQuery.js";
import { officialSource } from "./baseProvider.js";

const browserHeaders = {
  "user-agent":
    process.env.RETAIL_OFFICIAL_USER_AGENT ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "de-DE,de;q=0.9,en;q=0.8"
};

const mediaSaturnConfigs = {
  mediamarkt: {
    retailerId: "mediamarkt",
    displayName: "MediaMarkt",
    providerId: "mediamarkt_official_site",
    searchUrl: "https://www.mediamarkt.de/de/search.html"
  },
  saturn: {
    retailerId: "saturn",
    displayName: "Saturn",
    providerId: "saturn_official_site",
    searchUrl: "https://www.saturn.de/de/search.html"
  }
};

export const mediaSaturnProvider = {
  id: "media_saturn",

  supports(retailerId) {
    return Boolean(mediaSaturnConfigs[retailerId]);
  },

  async search(request, context = {}) {
    const config = mediaSaturnConfigs[context.retailer?.id || context.retailerId];
    return lookupMediaSaturnOfficialProduct(config, request, context);
  }
};

export function buildMediaSaturnSearchTerms(productQuery) {
  const raw = String(productQuery || "").trim();
  const normalized = normalizeSearchText(raw);
  const mappedTerms = [];
  const secondaryTerms = [];

  if (
    /apple\s*pencil|ipad\s*pencil|pencil\s*2|2nd\s*gen|second\s*gen|2\.\s*generation/.test(normalized) ||
    /2代/.test(raw)
  ) {
    mappedTerms.push("Apple Pencil 2", "Apple Pencil 2. Generation", "APPLE Pencil (2. Generation)");
  }

  if (/ipad|平板/.test(normalized) || /平板/.test(raw)) {
    secondaryTerms.push("iPad", "Apple iPad");
  }

  return uniqueTerms([...mappedTerms, raw, ...secondaryTerms], 6);
}

async function lookupMediaSaturnOfficialProduct(config, request, options = {}) {
  const searchTerms = buildMediaSaturnSearchTerms(request.productQuery);
  const searchedEndpoints = [];
  const termResults = [];
  let matchedTerm = null;
  let products = [];
  let blockedResponse = null;

  if (!config) {
    throw new Error("Missing MediaMarkt/Saturn retailer config.");
  }

  try {
    for (const term of searchTerms) {
      const endpoint = makeSearchUrl(config.searchUrl, term);
      const response = await fetchText(endpoint, {
        fetcher: options.fetcher,
        signal: options.signal,
        headers: browserHeaders
      });
      searchedEndpoints.push(endpoint);

      if (looksLikeAccessChallenge(response)) {
        blockedResponse = response;
        break;
      }

      const termProducts = extractMediaSaturnProducts(response.text, config, term);
      termResults.push({
        term,
        totalCount: termProducts.length
      });

      if (termProducts.length > 0) {
        matchedTerm = term;
        products = termProducts;
        break;
      }
    }
  } catch (error) {
    return failedMediaSaturnResult({
      config,
      request,
      searchTerms,
      searchedEndpoints,
      status: "official_lookup_failed",
      message: `${config.displayName} official lookup failed: ${error.message}`
    });
  }

  if (blockedResponse) {
    return failedMediaSaturnResult({
      config,
      request,
      searchTerms,
      searchedEndpoints,
      status: "official_access_blocked",
      message: `${config.displayName} official search page returned an access challenge.`,
      debug: {
        status: blockedResponse.status,
        cfMitigated: blockedResponse.headers?.["cf-mitigated"] || null
      }
    });
  }

  if (!products.length) {
    return {
      ok: false,
      channel: "official_direct",
      provider: config.providerId,
      retailerId: config.retailerId,
      retailer: config.displayName,
      status: "no_catalog_match",
      request,
      answer: `${config.displayName} 官方搜索页没有找到 "${request.productQuery}" 的商品结果。已尝试：${searchTerms
        .map((term) => `"${term}"`)
        .join(", ")}。`,
      products: [],
      officialSearchTerms: searchTerms,
      termResults,
      searchedEndpoints,
      sources: [officialSource(`${config.displayName} Suche`, makeSearchUrl(config.searchUrl, searchTerms[0]))],
      priceFound: false,
      availabilityFound: false,
      fallbackRecommended: true,
      retrievedAt: new Date().toISOString()
    };
  }

  const rankedProducts = products
    .map((product) => ({
      ...product,
      relevanceScore: scoreMediaSaturnProduct(product)
    }))
    .sort((left, right) => right.relevanceScore - left.relevanceScore);
  const priceFound = rankedProducts.some((product) => Number.isFinite(product.price));
  const availabilityFound = rankedProducts.some((product) => Boolean(product.availability));

  return {
    ok: true,
    channel: "official_direct",
    provider: config.providerId,
    retailerId: config.retailerId,
    retailer: config.displayName,
    status: "catalog_matches_found",
    request,
    answer: buildMediaSaturnAnswer(config, request, rankedProducts, matchedTerm),
    products: rankedProducts,
    officialSearchTerms: searchTerms,
    termResults,
    matchedTerm,
    matchedTotalCount: products.length,
    searchedEndpoints,
    sources: buildMediaSaturnSources(config, rankedProducts, matchedTerm || searchTerms[0]),
    priceFound,
    availabilityFound,
    fallbackRecommended: true,
    retrievedAt: new Date().toISOString()
  };
}

function makeSearchUrl(searchUrl, term) {
  const endpoint = new URL(searchUrl);
  endpoint.searchParams.set("query", term);
  return endpoint.toString();
}

function extractMediaSaturnProducts(html, config, matchedSearchTerm) {
  const payloads = extractJsonLdPayloads(html);
  const products = [];

  for (const payload of payloads) {
    for (const product of findProductsInJsonLd(payload)) {
      products.push(normalizeMediaSaturnProduct(product, config, matchedSearchTerm));
    }
  }

  return products.filter((product) => product.title || product.url);
}

function normalizeMediaSaturnProduct(product, config, matchedSearchTerm) {
  const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers || {};
  const price = Number.parseFloat(String(offer.price || "").replace(",", "."));
  const priceCurrency = offer.priceCurrency || "EUR";
  const title = String(product.name || "").trim();

  return {
    retailer: config.displayName,
    name: title,
    title,
    brand: inferBrand(title),
    url: offer.url || product.url || null,
    imageUrl: Array.isArray(product.image) ? product.image[0] : product.image || null,
    matchedSearchTerm,
    price: Number.isFinite(price) ? price : null,
    priceCurrency,
    priceDisplay: Number.isFinite(price) ? formatPrice(price, priceCurrency) : null,
    availability: offer.availability || null,
    storeSpecific: false
  };
}

function inferBrand(title) {
  const match = String(title || "").match(/^[A-Z0-9&.-]+/);
  return match ? match[0] : null;
}

function scoreMediaSaturnProduct(product) {
  const title = normalizeSearchText(product.title);
  let score = 0;

  if (/apple/.test(title)) score += 4;
  if (/pencil/.test(title)) score += 4;
  if (/2\s*generation|2\.generation|2\.\s*generation|2nd|second/.test(title)) score += 4;
  if (/eingabestift/.test(title)) score += 1;
  if (/1st|1\s*generation|1\.generation|first/.test(title)) score -= 6;
  if (/allgoodsbrand|cosyhomes|ersatzspitze|stylus|baseus|inf\b|engelmann/.test(title)) score -= 5;
  if (product.price !== null) score += 1;

  return score;
}

function buildMediaSaturnSources(config, products, matchedTerm) {
  const searchSource = officialSource(`${config.displayName} Suche`, makeSearchUrl(config.searchUrl, matchedTerm));
  const productSources = products.slice(0, 5).map((product, index) => ({
    index: index + 1,
    title: product.title || product.url,
    uri: product.url,
    channel: "official_direct"
  }));

  return [searchSource, ...productSources].filter((source) => source.uri);
}

function buildMediaSaturnAnswer(config, request, products, matchedTerm) {
  const answerProducts = products.filter((product) => product.relevanceScore >= 12);
  const examples = (answerProducts.length ? answerProducts : products)
    .slice(0, 3)
    .map((product) => `${product.title}${product.priceDisplay ? ` - ${product.priceDisplay}` : ""}`)
    .join("; ");

  return [
    `${config.displayName} 官方搜索页查到了与 "${request.productQuery}" 相关的商品，命中的官方搜索词是 "${matchedTerm}"。`,
    `官方页 JSON-LD 里的前几个相关价格：${examples}。`,
    "这些是官网搜索页暴露的在线商品价格；它没有直接给出 Munich 某一家实体店的单店库存或本地店价。"
  ].join(" ");
}

function failedMediaSaturnResult({ config, request, searchTerms, searchedEndpoints, status, message, debug = null }) {
  return {
    ok: false,
    channel: "official_direct",
    provider: config.providerId,
    retailerId: config.retailerId,
    retailer: config.displayName,
    status,
    request,
    answer: `${config.displayName} 官方通道没有返回可用商品数据：${message}`,
    message,
    products: [],
    officialSearchTerms: searchTerms,
    searchedEndpoints,
    sources: [officialSource(`${config.displayName} Suche`, makeSearchUrl(config.searchUrl, searchTerms[0]))],
    priceFound: false,
    availabilityFound: false,
    fallbackRecommended: true,
    debug,
    retrievedAt: new Date().toISOString()
  };
}
