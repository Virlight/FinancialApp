import {
  expandRetailerIds,
  formatRetailerNames,
  normalizeRetailLookupType,
  normalizeRetailerIdsForProduct
} from "./retailerConfig.js";
import { normalizeProductQuery } from "./utils/normalizeProductQuery.js";

const defaultLocation = "Munich, Germany";

export function buildRetailSearchRequest(args) {
  const productQuery = normalizeProductQuery(args.productQuery);
  const retailers = normalizeRetailerIdsForProduct(args.retailers || args.retailer, productQuery);
  const retailerConfigs = expandRetailerIds(retailers);

  return {
    retailers,
    retailerNames: formatRetailerNames(retailers),
    retailerDomains: retailerConfigs.flatMap((retailer) => retailer.domains),
    openDiscovery: retailerConfigs.some((retailer) => retailer.openDiscovery),
    productQuery,
    location: String(args.location || defaultLocation).trim(),
    lookupType: normalizeRetailLookupType(args.lookupType),
    requestedDate: args.date || new Date().toISOString().slice(0, 10)
  };
}
