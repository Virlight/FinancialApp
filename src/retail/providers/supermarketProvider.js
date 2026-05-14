import { fetchJson } from "../utils/fetchWithTimeout.js";
import { normalizeSearchText, uniqueTerms } from "../utils/normalizeProductQuery.js";
import { buildOfficialSearchOnlyResult, officialSource } from "./baseProvider.js";

const edekaProductSearchUrl = "https://www.edeka.de/unsere-marken/produkte/index.jsp";
const edekaApiUrl = "https://www.edeka.de/api/emsearch";

const supermarketConfigs = {
  edeka: {
    providerId: "edeka_official_api",
    searchUrl: edekaProductSearchUrl
  },
  rewe: {
    providerId: "supermarket_official_search",
    searchUrl: "https://www.rewe.de/suche/?search="
  },
  penny: {
    providerId: "supermarket_official_search",
    searchUrl: "https://www.penny.de/suche?query="
  },
  lidl: {
    providerId: "supermarket_official_search",
    searchUrl: "https://www.lidl.de/q/search?query="
  },
  aldi: {
    providerId: "supermarket_official_search",
    searchUrl: "https://www.aldi-sued.de/de/suchergebnisse.html?search="
  }
};

export const supermarketProvider = {
  id: "supermarket_search",

  supports(retailerId) {
    return Boolean(supermarketConfigs[retailerId]);
  },

  async search(request, context = {}) {
    const retailer = context.retailer;
    const config = supermarketConfigs[retailer?.id];

    if (!retailer || !config) {
      throw new Error("Missing supermarket retailer config.");
    }

    if (retailer.id === "edeka") {
      return lookupEdekaOfficialProduct(request, context);
    }

    const searchTerms = buildGenericSupermarketSearchTerms(request.productQuery, retailer.displayName);
    const searchedEndpoints = [makeGenericSearchUrl(config.searchUrl, searchTerms[0])];

    return buildOfficialSearchOnlyResult({
      providerId: config.providerId,
      retailer,
      request,
      searchTerms,
      searchedEndpoints,
      answer: `${retailer.displayName} 当前没有接入稳定公开商品 API。App 会优先使用官方域名和官方搜索入口，然后进入 Google grounding fallback 查询价格、优惠和门店可用性。`
    });
  }
};

export async function lookupEdekaOfficialProduct(request, options = {}) {
  const searchTerms = buildEdekaSearchTerms(request.productQuery);
  const searchedEndpoints = [];
  const termResults = [];
  let matchedTerm = null;
  let matchedTotalCount = 0;
  let products = [];

  try {
    for (const term of searchTerms) {
      const result = await searchEdekaCatalog(term, options);
      searchedEndpoints.push(result.endpoint);
      termResults.push({
        term,
        totalCount: result.totalCount
      });

      if (result.products.length > 0) {
        matchedTerm = term;
        matchedTotalCount = result.totalCount;
        products = result.products;
        break;
      }
    }
  } catch (error) {
    return {
      ok: false,
      channel: "official_direct",
      provider: "edeka_official_api",
      retailerId: "edeka",
      retailer: "EDEKA",
      status: "official_lookup_failed",
      request,
      officialSearchTerms: searchTerms,
      searchedEndpoints,
      sources: [edekaProductSearchSource()],
      message: `EDEKA official lookup failed: ${error.message}`,
      answer: `EDEKA 官方通道查询失败：${error.message}`,
      priceFound: false,
      availabilityFound: false,
      fallbackRecommended: true,
      retrievedAt: new Date().toISOString()
    };
  }

  const sources = buildEdekaSources(products);
  const lookupNeedsPrice = request.lookupType === "price" || request.lookupType === "price_and_availability";
  const lookupNeedsAvailability =
    request.lookupType === "availability" || request.lookupType === "price_and_availability";

  if (!products.length) {
    return {
      ok: false,
      channel: "official_direct",
      provider: "edeka_official_api",
      retailerId: "edeka",
      retailer: "EDEKA",
      status: "no_catalog_match",
      request,
      answer: buildNoEdekaMatchAnswer(request, searchTerms),
      message: buildNoEdekaMatchAnswer(request, searchTerms),
      products: [],
      officialSearchTerms: searchTerms,
      termResults,
      searchedEndpoints,
      sources: [edekaProductSearchSource()],
      priceFound: false,
      availabilityFound: false,
      fallbackRecommended: true,
      retrievedAt: new Date().toISOString()
    };
  }

  return {
    ok: true,
    channel: "official_direct",
    provider: "edeka_official_api",
    retailerId: "edeka",
    retailer: "EDEKA",
    status: "catalog_matches_found",
    request,
    answer: buildEdekaMatchAnswer({
      request,
      products,
      matchedTerm,
      matchedTotalCount,
      lookupNeedsPrice,
      lookupNeedsAvailability
    }),
    products,
    officialSearchTerms: searchTerms,
    termResults,
    matchedTerm,
    matchedTotalCount,
    searchedEndpoints,
    sources,
    priceFound: false,
    availabilityFound: false,
    fallbackRecommended: lookupNeedsPrice || lookupNeedsAvailability,
    retrievedAt: new Date().toISOString()
  };
}

export function buildEdekaSearchTerms(productQuery) {
  const raw = String(productQuery || "").trim();
  const normalized = normalizeSearchText(raw);
  const terms = [raw];

  const mappings = [
    {
      patterns: [/整鸡|全鸡|whole chicken|roast chicken|brathaehnchen|brathahnchen|brathähnchen/],
      terms: ["Brathähnchen", "ganzes Hähnchen", "Hähnchen", "Huhn"]
    },
    {
      patterns: [/肉松|pork floss|rousong|meat floss|fleischwatte/],
      terms: ["肉松", "Pork Floss", "Rousong", "Fleischwatte"]
    },
    {
      patterns: [/牛奶|milk|milch/],
      terms: ["Milch", "Vollmilch", "H-Milch"]
    },
    {
      patterns: [/鸡|chicken|haehnchen|hähnchen/],
      terms: ["Hähnchen", "Brathähnchen", "Huhn"]
    }
  ];

  for (const mapping of mappings) {
    if (mapping.patterns.some((pattern) => pattern.test(normalized) || pattern.test(raw))) {
      terms.push(...mapping.terms);
    }
  }

  return uniqueTerms(terms);
}

function buildGenericSupermarketSearchTerms(productQuery, retailerName) {
  return uniqueTerms([productQuery, `${retailerName} ${productQuery}`, `${productQuery} Preis`, `${productQuery} Angebote`]);
}

async function searchEdekaCatalog(term, options) {
  const endpoint = new URL(edekaApiUrl);
  endpoint.searchParams.set("page", "0");
  endpoint.searchParams.set("size", "8");
  endpoint.searchParams.set("query", term);

  const payload = await fetchJson(endpoint, {
    fetcher: options.fetcher,
    signal: options.signal
  });
  const rawProducts = Array.isArray(payload.products) ? payload.products : [];

  return {
    endpoint: endpoint.toString(),
    totalCount: Number(payload.totalCount || 0),
    products: rawProducts.map((product) => normalizeEdekaProduct(product, term))
  };
}

function normalizeEdekaProduct(product, matchedSearchTerm) {
  const brand = String(product.brand || "").trim();
  const name = String(product.name || "").trim();
  const description = String(product.longDescription || product.description || "").trim();
  const gtin = product.gtin ? String(product.gtin) : null;

  return {
    retailer: "EDEKA",
    name,
    brand,
    title: [brand, name].filter(Boolean).join(" "),
    description,
    gtin,
    url: gtin && brand && name ? makeEdekaProductUrl(brand, name, gtin) : edekaProductSearchUrl,
    imageUrl: product.image?.url || null,
    matchedSearchTerm,
    price: null,
    priceCurrency: null,
    availability: null,
    storeSpecific: false
  };
}

function makeEdekaProductUrl(brand, name, gtin) {
  const slug = `${brand}-${name}`
    .toLowerCase()
    .replace(/ä/gi, "ae")
    .replace(/ü/gi, "ue")
    .replace(/ö/gi, "oe")
    .replace(/ß/gi, "ss")
    .replace(/&/gi, "-")
    .replace(/,/gi, "-")
    .replace(/[^0-9a-z-\s]/gi, "")
    .replace(/\s/gi, "-")
    .replace(/[-](?=-)/gi, "");

  return `https://www.edeka.de/unsere-marken/produkte/${slug}-${gtin}.jsp`;
}

function makeGenericSearchUrl(searchUrl, term) {
  return `${searchUrl}${encodeURIComponent(term)}`;
}

function buildEdekaSources(products) {
  const productSources = products.slice(0, 5).map((product, index) => ({
    index: index + 1,
    title: product.title || product.url,
    uri: product.url,
    channel: "official_direct"
  }));

  return [edekaProductSearchSource(), ...productSources];
}

function edekaProductSearchSource() {
  return officialSource("EDEKA Produktsuche", edekaProductSearchUrl);
}

function buildEdekaMatchAnswer({
  request,
  products,
  matchedTerm,
  matchedTotalCount,
  lookupNeedsPrice,
  lookupNeedsAvailability
}) {
  const examples = products
    .slice(0, 3)
    .map((product) => `${product.title}${product.description ? ` (${product.description})` : ""}`)
    .join("; ");
  const priceNote = lookupNeedsPrice ? "价格：EDEKA 官方产品 API 没有返回价格。" : "";
  const availabilityNote = lookupNeedsAvailability
    ? "库存/门店：EDEKA 官方产品 API 没有返回 Munich 单店库存。"
    : "";

  return [
    `EDEKA 官方通道查到了与 "${request.productQuery}" 相关的产品目录结果，命中的官方搜索词是 "${matchedTerm}"，官方结果数为 ${matchedTotalCount}。`,
    `示例：${examples}。`,
    priceNote,
    availabilityNote,
    "这能证明 EDEKA 官方产品库里有相关商品条目，但不能证明今天慕尼黑某一家门店有货或具体售价。"
  ]
    .filter(Boolean)
    .join(" ");
}

function buildNoEdekaMatchAnswer(request, searchTerms) {
  return `EDEKA 官方产品搜索没有找到 "${request.productQuery}" 的商品目录结果。已尝试：${searchTerms
    .map((term) => `"${term}"`)
    .join(", ")}。`;
}
