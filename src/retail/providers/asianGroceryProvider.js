import { uniqueTerms } from "../utils/normalizeProductQuery.js";
import { asianProductLookupProvider } from "./asianProductLookupProvider.js";
import { asianStoreDiscoveryProvider } from "./asianStoreDiscoveryProvider.js";

export const asianGroceryProvider = {
  id: "asian_grocery",

  supports(retailerId) {
    return retailerId === "asian_grocery";
  },

  async search(request, context = {}) {
    const searchTerms = buildAsianGrocerySearchTerms(request.productQuery);
    const discoveryResult = await asianStoreDiscoveryProvider.search(request, context);
    const productLookupResult = await asianProductLookupProvider.search(request, {
      ...context,
      stores: discoveryResult.stores || [],
      searchTerms
    });

    return [discoveryResult, productLookupResult];
  }
};

export function buildAsianGrocerySearchTerms(productQuery) {
  const raw = String(productQuery || "").trim();

  return uniqueTerms([
    raw,
    "肉松",
    "pork floss",
    "rousong",
    "meat floss",
    "flossy pork",
    "Schweinefleischflocken",
    "Fleischwatte"
  ]);
}
