export function officialSource(title, uri) {
  return {
    index: 0,
    title,
    uri,
    channel: "official_direct"
  };
}

export function buildOfficialSearchOnlyResult({
  providerId,
  retailer,
  request,
  searchTerms,
  searchedEndpoints,
  status = "official_direct_not_configured",
  answer
}) {
  return {
    ok: false,
    channel: "official_direct",
    provider: providerId,
    retailerId: retailer.id,
    retailer: retailer.displayName,
    status,
    request,
    answer:
      answer ||
      `${retailer.displayName} 当前没有稳定的官方直连商品 API/解析器。已生成官方搜索入口，后续会进入 Google grounding fallback。`,
    products: [],
    officialSearchTerms: searchTerms,
    searchedEndpoints,
    sources: searchedEndpoints.slice(0, 1).map((uri) => officialSource(`${retailer.displayName} Suche`, uri)),
    priceFound: false,
    availabilityFound: false,
    fallbackRecommended: true,
    retrievedAt: new Date().toISOString()
  };
}
