const placesTextSearchUrl = "https://places.googleapis.com/v1/places:searchText";
const munichCenter = {
  latitude: 48.137154,
  longitude: 11.576124
};

const seedAsianStores = [
  {
    name: "Go Asia Supermarkt",
    searchName: "Go Asia Munich",
    websiteUri: "https://goasia.net/",
    source: "seed"
  },
  {
    name: "Orient Shop",
    searchName: "Orient Shop Rosenheimer Str. 38 Munich",
    websiteUri: "https://www.orientshop.net/",
    source: "seed"
  },
  {
    name: "Asia Markt City",
    searchName: "Asia Markt City Elisenhof Munich",
    source: "seed"
  },
  {
    name: "Shanghai Markt",
    searchName: "Shanghai Markt Münchner Freiheit Munich",
    source: "seed"
  },
  {
    name: "Vinh-Loi Asien Supermarkt",
    searchName: "Vinh-Loi Asien Supermarkt München",
    websiteUri: "https://www.vinhloi.de/",
    source: "seed"
  },
  {
    name: "iShop",
    searchName: "iShop Prinzregentenstraße 120 Munich Asian grocery",
    source: "seed"
  }
];

const discoveryQueries = [
  "Asian grocery Munich",
  "Asia Markt München",
  "Chinese supermarket Munich",
  "Korean supermarket Munich",
  "Japanese grocery Munich",
  "Vietnamese supermarket Munich"
];

export const asianStoreDiscoveryProvider = {
  id: "asian_store_discovery",

  supports(retailerId) {
    return retailerId === "asian_grocery";
  },

  async search(request, context = {}) {
    const retailer = context.retailer || {
      id: "asian_grocery",
      displayName: "Asian grocery stores in Munich"
    };
    const placesConfigured = Boolean(process.env.GOOGLE_PLACES_API_KEY);
    const placesStores = placesConfigured ? await searchGooglePlaces(discoveryQueries, context) : [];
    const stores = mergeStores([...placesStores, ...seedAsianStores]);

    return {
      ok: stores.length > 0,
      channel: "store_discovery",
      provider: placesConfigured ? "google_places_text_search" : "asian_store_seed_discovery",
      retailerId: retailer.id,
      retailer: retailer.displayName,
      status: placesConfigured ? "places_and_seed_stores_collected" : "places_not_configured_seed_stores_used",
      request,
      answer: placesConfigured
        ? `已用 Google Places Text Search 和本地 seed 列表发现 ${stores.length} 个 Munich 亚洲超市候选。`
        : `GOOGLE_PLACES_API_KEY 未配置，先使用内置 Munich 亚洲超市 seed 列表发现 ${stores.length} 个候选；商品证据会交给 grounding 查。`,
      stores,
      candidateStores: stores,
      candidateQueries: discoveryQueries,
      officialSearchTerms: [],
      sources: stores
        .filter((store) => store.googleMapsUri || store.websiteUri)
        .slice(0, 8)
        .map((store, index) => ({
          index: index + 1,
          title: store.name,
          uri: store.googleMapsUri || store.websiteUri,
          channel: "store_discovery"
        })),
      products: [],
      priceFound: false,
      availabilityFound: false,
      fallbackRecommended: true,
      retrievedAt: new Date().toISOString()
    };
  }
};

export function getSeedAsianStores() {
  return seedAsianStores.map((store) => ({ ...store }));
}

async function searchGooglePlaces(queries, options = {}) {
  const results = await Promise.all(
    queries.map((query) =>
      searchGooglePlacesText(query, options).catch((error) => ({
        query,
        error: error.message,
        places: []
      }))
    )
  );

  return results.flatMap((result) => result.places || []);
}

async function searchGooglePlacesText(textQuery, options = {}) {
  const fetcher = options.fetcher || fetch;
  const response = await fetcher(placesTextSearchUrl, {
    method: "POST",
    signal: options.signal,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.websiteUri,places.nationalPhoneNumber,places.businessStatus,places.types"
    },
    body: JSON.stringify({
      textQuery,
      languageCode: "en",
      regionCode: "DE",
      locationBias: {
        circle: {
          center: munichCenter,
          radius: 20000
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Google Places Text Search failed: HTTP ${response.status}`);
  }

  const payload = await response.json();

  return {
    query: textQuery,
    places: (payload.places || []).map((place) => normalizePlace(place, textQuery))
  };
}

function normalizePlace(place, discoveryQuery) {
  return {
    placeId: place.id || null,
    name: place.displayName?.text || null,
    address: place.formattedAddress || null,
    latitude: place.location?.latitude || null,
    longitude: place.location?.longitude || null,
    location: place.location || null,
    websiteUri: place.websiteUri || null,
    phone: place.nationalPhoneNumber || null,
    googleMapsUri: place.googleMapsUri || null,
    businessStatus: place.businessStatus || null,
    types: place.types || [],
    discoveryQuery,
    source: "google_places"
  };
}

function mergeStores(stores) {
  const seen = new Set();
  const merged = [];

  for (const store of stores) {
    const key = store.placeId || `${normalizeStoreName(store.name)}|${normalizeStoreName(store.address || store.searchName)}`;

    if (!store.name || seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(store);
  }

  return merged;
}

function normalizeStoreName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f]+/gi, " ")
    .trim();
}
