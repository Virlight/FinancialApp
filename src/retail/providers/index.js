import { expandRetailerIds } from "../retailerConfig.js";
import { asianGroceryProvider, buildAsianGrocerySearchTerms } from "./asianGroceryProvider.js";
import { asianProductLookupProvider } from "./asianProductLookupProvider.js";
import { asianStoreDiscoveryProvider, getSeedAsianStores } from "./asianStoreDiscoveryProvider.js";
import { drugstoreProvider } from "./drugstoreProvider.js";
import { fallbackGroundingProvider } from "./fallbackGroundingProvider.js";
import { ikeaProvider } from "./ikeaProvider.js";
import { mediaSaturnProvider, buildMediaSaturnSearchTerms } from "./mediaSaturnProvider.js";
import {
  buildEdekaSearchTerms,
  lookupEdekaOfficialProduct,
  supermarketProvider
} from "./supermarketProvider.js";

export const providerRegistry = [
  mediaSaturnProvider,
  ikeaProvider,
  supermarketProvider,
  drugstoreProvider,
  asianGroceryProvider
];

export const officialRetailProviders = providerRegistry;

export {
  buildAsianGrocerySearchTerms,
  buildEdekaSearchTerms,
  buildMediaSaturnSearchTerms,
  asianProductLookupProvider,
  asianStoreDiscoveryProvider,
  fallbackGroundingProvider,
  getSeedAsianStores,
  lookupEdekaOfficialProduct
};

export function getProvidersForRetailer(retailerId) {
  return providerRegistry.filter((provider) => provider.supports(retailerId));
}

export function getProviderSearchPlan(request) {
  return expandRetailerIds(request.retailers).flatMap((retailer) =>
    getProvidersForRetailer(retailer.id).map((provider) => ({
      provider,
      retailer
    }))
  );
}

export async function lookupPrimaryRetailProducts(request, options = {}) {
  const searchPlan = getProviderSearchPlan(request);

  if (!searchPlan.length) {
    return [];
  }

  const results = await Promise.all(
    searchPlan.map(({ provider, retailer }) =>
      provider.search(request, {
        ...options,
        retailer,
        retailerId: retailer.id
      })
    )
  );

  return results.flat().filter(Boolean);
}

export const lookupOfficialRetailProduct = lookupPrimaryRetailProducts;
