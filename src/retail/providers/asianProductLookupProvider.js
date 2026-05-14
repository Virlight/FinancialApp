import { buildAsianGrocerySearchTerms } from "./asianGroceryProvider.js";

export const asianProductLookupProvider = {
  id: "asian_product_lookup",

  supports(retailerId) {
    return retailerId === "asian_grocery";
  },

  async search(request, context = {}) {
    const retailer = context.retailer || {
      id: "asian_grocery",
      displayName: "Asian grocery stores in Munich"
    };
    const searchTerms = context.searchTerms?.length
      ? context.searchTerms
      : buildAsianGrocerySearchTerms(request.productQuery);
    const stores = context.stores || [];
    const candidateQueries = buildStoreProductQueries(stores, searchTerms);

    return {
      ok: false,
      channel: "product_lookup_plan",
      provider: "asian_product_lookup",
      retailerId: retailer.id,
      retailer: retailer.displayName,
      status: "requires_store_specific_grounding",
      request,
      answer: `已生成 ${stores.length} 个 Munich 亚洲超市候选的店铺级商品查询计划；没有统一库存 API，下一步用 grounding 查每家店与 ${request.productQuery} 的商品页、价格、库存或评论证据。`,
      stores,
      candidateStores: stores,
      officialSearchTerms: searchTerms,
      candidateQueries,
      searchedEndpoints: [],
      sources: [],
      products: [],
      priceFound: false,
      availabilityFound: false,
      fallbackRecommended: true,
      retrievedAt: new Date().toISOString()
    };
  }
};

function buildStoreProductQueries(stores, searchTerms) {
  const productTerms = searchTerms.slice(0, 4).join(" OR ");
  const storeQueries = stores.slice(0, 10).flatMap((store) => {
    const storeName = store.searchName || store.name;
    const domain = store.websiteUri ? getDomain(store.websiteUri) : null;

    return [
      `"${storeName}" ${productTerms}`,
      domain ? `site:${domain} ${productTerms}` : null
    ].filter(Boolean);
  });

  return [
    ...storeQueries,
    `Munich Asian supermarket ${productTerms}`,
    `Asia Markt München ${productTerms}`,
    `亚洲超市 慕尼黑 ${productTerms}`
  ];
}

function getDomain(uri) {
  try {
    return new URL(uri).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
