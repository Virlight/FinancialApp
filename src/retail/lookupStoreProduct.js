import { fallbackGroundingProvider, lookupPrimaryRetailProducts } from "./providers/index.js";
import { buildRetailSearchRequest } from "./retailerRouter.js";
import { dedupeSources } from "./utils/dedupeResults.js";
import { buildMapPlacesFromChannels } from "./utils/mapPlaces.js";

export async function lookupStoreProduct(args, options = {}) {
  const request = buildRetailSearchRequest(args);
  emitProgress(options, {
    stage: "official_page_fetching",
    message: "Checking official retailer pages and local discovery providers."
  });
  throwIfAborted(options.signal);
  const primaryResults = await lookupPrimaryRetailProducts(request, {
    signal: options.signal
  });
  const primaryMapPlaces = buildMapPlacesFromChannels(primaryResults);

  emitProgress(options, {
    stage: "places_search_done",
    message: primaryMapPlaces.length
      ? `Found ${primaryMapPlaces.length} local place candidate(s).`
      : "Official/local discovery completed with no mapped places.",
    data: {
      mapPlaces: primaryMapPlaces
    }
  });

  if (!process.env.GEMINI_API_KEY) {
    if (primaryResults.some((result) => result.ok)) {
      return combineRetailResults({
        request,
        primaryResults,
        fallbackResult: null,
        fallbackUnavailableMessage:
          "Google fallback was skipped because GEMINI_API_KEY is not configured."
      });
    }

    return {
      ok: false,
      code: "retail_search_not_configured",
      provider: primaryResults.length ? "official_direct" : "gemini_google_search_grounding",
      request,
      channels: primaryResults,
      answer: primaryResults.map((result) => result.answer).filter(Boolean).join("\n\n") || null,
      message:
        "Retail product lookup requires GEMINI_API_KEY because it uses Gemini Grounding with Google Search."
    };
  }

  const useFallback = shouldUseFallback(request, primaryResults);

  if (useFallback) {
    throwIfAborted(options.signal);
    emitProgress(options, {
      stage: "grounding_started",
      message: "Running Google Search grounding fallback."
    });
  }

  const fallbackResult = useFallback
    ? await fallbackGroundingProvider.search(request, { primaryResults, signal: options.signal })
    : null;

  return combineRetailResults({
    request,
    primaryResults,
    fallbackResult
  });
}

function emitProgress(options, event) {
  if (typeof options.onProgress === "function") {
    options.onProgress(event);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new Error("Retail product lookup was cancelled.");
  }
}

function combineRetailResults({ request, primaryResults = [], fallbackResult, fallbackUnavailableMessage }) {
  const channels = [...primaryResults, fallbackResult].filter(Boolean);
  const sources = dedupeSources(channels.flatMap((channel) => channel.sources || []));
  const mapPlaces = buildMapPlacesFromChannels(channels);
  const searchQueries = [
    ...primaryResults.flatMap((result) =>
      (result.officialSearchTerms || []).map((term) => `${result.retailer} official: ${term}`)
    ),
    ...(fallbackResult?.searchQueries || [])
  ];
  const evidence = buildRetailEvidence(primaryResults, fallbackResult);
  const answer = buildToolSummary(primaryResults, fallbackResult, fallbackUnavailableMessage);
  const ok = channels.some((channel) => channel.ok);
  const provider = fallbackResult
    ? primaryResults.length
      ? "official_direct_then_google_grounding"
      : "gemini_google_search_grounding"
    : primaryResults.length
      ? "official_direct"
      : "unknown";

  return {
    ok,
    provider,
    request,
    answer: answer || "No retail lookup result was returned.",
    message: answer || "No retail lookup result was returned.",
    evidence,
    sources,
    mapPlaces,
    searchQueries,
    channels,
    requiresFinalSynthesis: true,
    retrievedAt: new Date().toISOString(),
    caveats: [
      "Official direct channels are preferred when configured.",
      "Retailer websites may show online prices, local store prices, offers, and availability differently.",
      "If a fallback result does not cite an official retailer source, treat the price as unverified."
    ],
    debug: {
      primaryResults,
      officialResults: primaryResults,
      officialResult: primaryResults[0] || null,
      groundingPrompt: fallbackResult?.debug?.groundingPrompt || null
    }
  };
}

function buildToolSummary(primaryResults, fallbackResult, fallbackUnavailableMessage) {
  const channelSummary = [
    primaryResults.length ? `${primaryResults.length} primary retail provider result(s)` : null,
    fallbackResult ? "grounded evidence result" : null,
    fallbackUnavailableMessage
  ].filter(Boolean);

  return channelSummary.length
    ? `Retail lookup tool completed: ${channelSummary.join(", ")}.`
    : "Retail lookup tool completed with no result channels.";
}

function buildRetailEvidence(primaryResults, fallbackResult) {
  return {
    providerChannels: primaryResults.map((result) => ({
      provider: result.provider,
      channel: result.channel,
      retailer: result.retailer,
      status: result.status,
      ok: result.ok,
      products: (result.products || []).slice(0, 10),
      stores: (result.stores || result.candidateStores || []).slice(0, 50),
      candidateQueries: result.candidateQueries || [],
      officialSearchTerms: result.officialSearchTerms || [],
      sources: result.sources || []
    })),
    grounded: fallbackResult?.evidence || null,
    groundingRawText: fallbackResult?.rawEvidenceText || null,
    groundingSources: fallbackResult?.sources || [],
    groundingSearchQueries: fallbackResult?.searchQueries || []
  };
}

function shouldUseFallback(request, primaryResults) {
  if (process.env.RETAIL_SEARCH_GOOGLE_FALLBACK === "false") {
    return false;
  }

  if (!primaryResults.length) {
    return true;
  }

  if (primaryResults.some((result) => !result.ok)) {
    return true;
  }

  return (
    request.lookupType === "price" ||
    request.lookupType === "availability" ||
    request.lookupType === "price_and_availability" ||
    primaryResults.some((result) => result.fallbackRecommended)
  );
}
