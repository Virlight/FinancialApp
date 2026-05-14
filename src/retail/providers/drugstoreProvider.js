import { uniqueTerms } from "../utils/normalizeProductQuery.js";
import { buildOfficialSearchOnlyResult } from "./baseProvider.js";

const drugstoreConfigs = {
  rossmann: {
    providerId: "drugstore_official_search",
    searchUrl: "https://www.rossmann.de/de/search?text="
  }
};

export const drugstoreProvider = {
  id: "drugstore_search",

  supports(retailerId) {
    return Boolean(drugstoreConfigs[retailerId]);
  },

  async search(request, context = {}) {
    const retailer = context.retailer;
    const config = drugstoreConfigs[retailer?.id];

    if (!retailer || !config) {
      throw new Error("Missing drugstore retailer config.");
    }

    const searchTerms = uniqueTerms([
      request.productQuery,
      `${retailer.displayName} ${request.productQuery}`,
      `${request.productQuery} Preis`
    ]);
    const searchedEndpoints = [`${config.searchUrl}${encodeURIComponent(searchTerms[0])}`];

    return buildOfficialSearchOnlyResult({
      providerId: config.providerId,
      retailer,
      request,
      searchTerms,
      searchedEndpoints,
      answer: `${retailer.displayName} 当前走通用药妆店官方搜索策略；没有稳定公开商品 API 时，会把官方搜索入口交给 Google grounding fallback 补价格和可用性。`
    });
  }
};
