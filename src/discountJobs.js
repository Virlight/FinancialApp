import { composeFinalAssistantResponseStream } from "./finalResponse.js";
import {
  completeRealtimeJob,
  createRealtimeJob,
  emitRealtimeLlmToken,
  emitRealtimeJobProgress,
  failRealtimeJob,
  throwIfRealtimeJobCancelled
} from "./realtime.js";
import {
  extractKnownMerchantName,
  looksLikeFoodMerchant,
  lookupLocalDeals
} from "./localDeals/lookupLocalDeals.js";
import { discoverRetailerPlaces } from "./retail/placesDiscovery.js";
import { buildMapPlacesFromChannels } from "./retail/utils/mapPlaces.js";
import { lookupStoreProduct } from "./retailSearch.js";

const defaultLocation = "Munich, Germany";
const excludedExpenseNotes = new Set(["expense"]);

export function maybeStartDiscountLookupJob({ clientId, execution, responseLanguage = "zh" }) {
  const candidate = buildDiscountCandidate(execution);

  if (!candidate || !clientId) {
    return null;
  }

  candidate.responseLanguage = normalizeResponseLanguage(responseLanguage);

  const job = createRealtimeJob({
    clientId,
    type: "discount_lookup",
    label: `Discount check: ${candidate.productQuery}`,
    metadata: candidate
  });

  if (!job) {
    return null;
  }

  setImmediate(() => {
    runDiscountLookupJob(job, candidate).catch((error) => {
      failRealtimeJob(job, error);
    });
  });

  return {
    jobId: job.id,
    ...candidate
  };
}

async function runDiscountLookupJob(job, candidate) {
  emitRealtimeJobProgress(job, {
    stage: "discount_job_started",
    message: `Checking Munich discount information for ${candidate.productQuery}.`,
    data: candidate
  });
  throwIfRealtimeJobCancelled(job);

  const lookupArgs = {
    productQuery: candidate.productQuery,
    retailers: candidate.retailers,
    location: candidate.location,
    lookupType: "price_and_availability",
    date: new Date().toISOString().slice(0, 10)
  };

  if (candidate.lookupMode === "local_deals") {
    await runLocalDealDiscountLookupJob(job, candidate, lookupArgs.date);
    return;
  }

  const placesResult = await discoverRetailerPlaces(
    {
      retailers: candidate.retailers,
      location: candidate.location
    },
    {
      signal: job.abortController.signal
    }
  );
  const earlyMapPlaces = placesResult.mapPlaces || [];

  emitRealtimeJobProgress(job, {
    stage: "places_search_done",
    message: earlyMapPlaces.length
      ? `Found ${earlyMapPlaces.length} nearby retailer place(s).`
      : "Places discovery completed with no mapped stores.",
    data: {
      productQuery: candidate.productQuery,
      mapPlaces: earlyMapPlaces,
      places: placesResult.stores || [],
      candidateQueries: placesResult.candidateQueries || []
    }
  });
  throwIfRealtimeJobCancelled(job);

  const retailSearch = await lookupStoreProduct(lookupArgs, {
    signal: job.abortController.signal,
    onProgress(event) {
      emitRealtimeJobProgress(job, event);
    }
  });

  throwIfRealtimeJobCancelled(job);

  emitRealtimeJobProgress(job, {
    stage: "discount_summary_started",
    message: "Summarizing discount check result."
  });
  const mergedMapPlaces = mergeMapPlaces(earlyMapPlaces, retailSearch.mapPlaces || []);
  const retailSearchWithPlaces = {
    ...retailSearch,
    mapPlaces: mergedMapPlaces
  };
  const finalResponse = await composeFinalAssistantResponseStream({
    input: `Check whether ${candidate.productQuery} has a current discount or useful price/availability evidence in Munich. Explain uncertainty clearly.`,
    functionCall: {
      name: "lookup_store_product",
      args: lookupArgs
    },
    execution: {
      result: {
        ok: retailSearchWithPlaces.ok,
        message: retailSearchWithPlaces.message,
        retailSearch: retailSearchWithPlaces,
        mapPlaces: mergedMapPlaces
      }
    },
    responseLanguage: candidate.responseLanguage,
    onToken(token, accumulatedText) {
      emitRealtimeLlmToken(job, {
        text: token,
        accumulatedText
      });
    }
  });

  throwIfRealtimeJobCancelled(job);

  const discountInsight = {
    productQuery: candidate.productQuery,
    sourceAction: candidate.sourceAction,
    sourceId: candidate.sourceId,
    sourceLabel: candidate.sourceLabel,
    message: finalResponse.message,
    retailSearch: summarizeRetailSearch(retailSearchWithPlaces),
    mapPlaces: mergedMapPlaces,
    sources: retailSearchWithPlaces.sources || [],
    createdAt: new Date().toISOString()
  };

  emitRealtimeJobProgress(job, {
    stage: "discount_job_done",
    message: `Discount check completed for ${candidate.productQuery}.`,
    data: {
      discountInsight
    }
  });
  completeRealtimeJob(job, {
    discountInsight
  });
}

async function runLocalDealDiscountLookupJob(job, candidate, date) {
  const localDealArgs = {
    merchantQuery: candidate.merchantQuery || candidate.productQuery,
    productQuery: candidate.productQuery,
    category: candidate.category,
    location: candidate.location,
    period: "current_week",
    date
  };
  const localDeals = await lookupLocalDeals(localDealArgs, {
    signal: job.abortController.signal,
    onProgress(event) {
      emitRealtimeJobProgress(job, event);
    }
  });

  throwIfRealtimeJobCancelled(job);

  emitRealtimeJobProgress(job, {
    stage: "discount_summary_started",
    message: "Summarizing local deal check result."
  });

  const finalResponse = await composeFinalAssistantResponseStream({
    input: `Check whether ${candidate.merchantQuery || candidate.productQuery} has current discounts, coupons, app offers, or useful deal evidence near Munich. Explain uncertainty clearly.`,
    functionCall: {
      name: "lookup_local_deals",
      args: localDealArgs
    },
    execution: {
      result: {
        ok: localDeals.ok,
        message: localDeals.message,
        localDeals,
        mapPlaces: localDeals.mapPlaces || []
      }
    },
    responseLanguage: candidate.responseLanguage,
    onToken(token, accumulatedText) {
      emitRealtimeLlmToken(job, {
        text: token,
        accumulatedText
      });
    }
  });

  throwIfRealtimeJobCancelled(job);

  const discountInsight = {
    productQuery: candidate.productQuery,
    merchantQuery: candidate.merchantQuery,
    sourceAction: candidate.sourceAction,
    sourceId: candidate.sourceId,
    sourceLabel: candidate.sourceLabel,
    message: finalResponse.message,
    localDeals: summarizeLocalDeals(localDeals),
    mapPlaces: localDeals.mapPlaces || [],
    sources: localDeals.sources || [],
    createdAt: new Date().toISOString()
  };

  emitRealtimeJobProgress(job, {
    stage: "discount_job_done",
    message: `Local deal check completed for ${candidate.merchantQuery || candidate.productQuery}.`,
    data: {
      discountInsight
    }
  });
  completeRealtimeJob(job, {
    discountInsight
  });
}

function mergeMapPlaces(...placeLists) {
  return buildMapPlacesFromChannels(
    placeLists.map((mapPlaces) => ({
      mapPlaces
    }))
  );
}

function buildDiscountCandidate(execution) {
  const actionName = execution?.executedAction?.functionName;

  if (actionName === "create_wishlist_item") {
    const item = execution.result?.item;
    const productQuery = normalizeProductText(item?.itemName);

    if (!productQuery) {
      return null;
    }

    return {
      sourceAction: "create_wishlist_item",
      sourceId: item.id,
      sourceLabel: item.itemName,
      productQuery,
      retailers: inferRetailersForDiscount(productQuery),
      location: defaultLocation,
      trigger: "post_wishlist_create"
    };
  }

  if (actionName === "create_expense") {
    const expense = execution.result?.expense;
    const productQuery = normalizeProductText(expense?.note);

    if (!expense || !productQuery || excludedExpenseNotes.has(productQuery.toLowerCase())) {
      return null;
    }

    const merchantQuery = extractMerchantQuery(productQuery);
    const isFoodOrMerchant = expense.category === "food" || looksLikeFoodMerchant(productQuery);

    return {
      sourceAction: "create_expense",
      sourceId: expense.id,
      sourceLabel: expense.note,
      productQuery,
      merchantQuery,
      category: expense.category,
      retailers: isFoodOrMerchant ? undefined : inferRetailersForDiscount(productQuery),
      location: defaultLocation,
      trigger: "post_expense_create",
      lookupMode: isFoodOrMerchant ? "local_deals" : "retail_product"
    };
  }

  return null;
}

function inferRetailersForDiscount(productQuery) {
  if (looksLikeElectronics(productQuery)) {
    return ["mediamarkt", "saturn"];
  }

  return undefined;
}

function looksLikeProduct(productQuery) {
  return (
    looksLikeElectronics(productQuery) ||
    /(camera|monitor|tv|television|shoe|shoes|jacket|coat|bag|watch|book|家具|耳机|手机|电脑|平板|相机|显示器|电视|鞋|衣服|外套|包|手表|书)/i.test(
      productQuery
    )
  );
}

function looksLikeElectronics(productQuery) {
  return /(ipad|iphone|apple\s*pencil|pencil\s*(?:2|.*2代)|macbook|laptop|notebook|tablet|smartphone|headphone|headphones|earbud|airpods|camera|monitor|tv|电子|电器|电脑|平板|手机|耳机|相机|显示器|电视)/i.test(
    productQuery
  );
}

function normalizeProductText(value) {
  const text = String(value || "")
    .replace(/^(buy|bought|purchase|purchased|record|记录|买了|购买)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return text && text.length >= 2 ? text : null;
}

function extractMerchantQuery(productQuery) {
  return extractKnownMerchantName(productQuery) || productQuery;
}

function summarizeRetailSearch(retailSearch) {
  return {
    ok: retailSearch.ok,
    provider: retailSearch.provider,
    request: retailSearch.request,
    evidence: retailSearch.evidence,
    sources: (retailSearch.sources || []).slice(0, 12),
    searchQueries: (retailSearch.searchQueries || []).slice(0, 12),
    caveats: retailSearch.caveats || [],
    retrievedAt: retailSearch.retrievedAt
  };
}

function summarizeLocalDeals(localDeals) {
  return {
    provider: localDeals.provider,
    request: localDeals.request,
    sourceCount: localDeals.sources?.length || 0,
    mapPlaceCount: localDeals.mapPlaces?.length || 0,
    searchQueries: (localDeals.searchQueries || []).slice(0, 12),
    evidence: localDeals.evidence,
    caveats: localDeals.caveats || []
  };
}

function normalizeResponseLanguage(value) {
  return value === "en" ? "en" : "zh";
}
