import { uniqueTerms } from "../utils/normalizeProductQuery.js";
import { buildOfficialSearchOnlyResult } from "./baseProvider.js";

const ikeaSearchUrl = "https://www.ikea.com/de/de/search/?q=";

export const ikeaProvider = {
  id: "ikea",

  supports(retailerId) {
    return retailerId === "ikea";
  },

  async search(request, context = {}) {
    const retailer = context.retailer;
    const searchTerms = buildIkeaSearchTerms(request.productQuery);
    const searchedEndpoints = [`${ikeaSearchUrl}${encodeURIComponent(searchTerms[0])}`];

    return buildOfficialSearchOnlyResult({
      providerId: "ikea_official_search",
      retailer,
      request,
      searchTerms,
      searchedEndpoints,
      answer:
        "IKEA 商品、门店和库存结构和普通超市不同。当前 provider 已单独隔离 IKEA 官方搜索入口，后续可以在这里扩展 Eching/Brunnthal 门店库存解析。"
    });
  }
};

export function buildIkeaSearchTerms(productQuery) {
  return uniqueTerms([productQuery, `${productQuery} IKEA`, `${productQuery} München`]);
}
