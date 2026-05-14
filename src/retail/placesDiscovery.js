import { expandRetailerIds, normalizeRetailerIds } from "../retailerConfig.js";
import { buildMapPlacesFromChannels } from "./utils/mapPlaces.js";

const placesTextSearchUrl = "https://places.googleapis.com/v1/places:searchText";
const defaultLocation = "Munich, Germany";
const munichCenter = {
  latitude: 48.137154,
  longitude: 11.576124
};

export async function discoverRetailerPlaces(args = {}, options = {}) {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return {
      ok: false,
      provider: "google_places_text_search",
      status: "places_not_configured",
      retailers: normalizeRetailerIds(args.retailers || args.retailer),
      location: args.location || defaultLocation,
      stores: [],
      mapPlaces: [],
      candidateQueries: []
    };
  }

  const retailers = expandRetailerIds(args.retailers || args.retailer).filter(
    (retailer) => retailer.id !== "asian_grocery"
  );
  const location = String(args.location || defaultLocation).trim();
  const candidateQueries = buildPlacesQueries(retailers, location);
  const fetcher = options.fetcher || fetch;
  const results = await Promise.all(
    candidateQueries.map(({ retailer, query }) =>
      searchGooglePlacesText(query, { fetcher, signal: options.signal }).then((places) => ({
        retailer,
        query,
        places
      })).catch((error) => ({
        retailer,
        query,
        error: error.message,
        places: []
      }))
    )
  );
  const stores = mergeStores(
    results.flatMap((result) =>
      result.places
        .filter((place) => retailerMatchesPlace(result.retailer, place))
        .map((place) => ({
          ...place,
          retailerId: result.retailer.id,
          retailer: result.retailer.displayName,
          discoveryQuery: result.query
        }))
    )
  ).slice(0, 30);
  const channel = {
    provider: "google_places_text_search",
    channel: "store_discovery",
    stores,
    candidateStores: stores
  };

  return {
    ok: stores.length > 0,
    provider: "google_places_text_search",
    status: stores.length ? "places_collected" : "no_places_found",
    retailers: retailers.map((retailer) => retailer.id),
    location,
    stores,
    mapPlaces: buildMapPlacesFromChannels([channel]),
    candidateQueries: candidateQueries.map((candidate) => candidate.query),
    retrievedAt: new Date().toISOString()
  };
}

function buildPlacesQueries(retailers, location) {
  return retailers.flatMap((retailer) => [
    {
      retailer,
      query: `${retailer.displayName} ${location}`
    },
    {
      retailer,
      query: `${retailer.displayName} store ${location}`
    }
  ]);
}

async function searchGooglePlacesText(textQuery, options = {}) {
  const response = await options.fetcher(placesTextSearchUrl, {
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
      languageCode: "de",
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

  return (payload.places || []).map((place) => ({
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
    source: "google_places"
  }));
}

function retailerMatchesPlace(retailer, place) {
  const haystack = `${place.name || ""} ${place.websiteUri || ""}`.toLowerCase();
  const aliases = [retailer.displayName, retailer.id, ...(retailer.aliases || [])].map((alias) =>
    alias.toLowerCase().replace(/\s+/g, "")
  );
  const compactHaystack = haystack.replace(/\s+/g, "");

  return aliases.some((alias) => compactHaystack.includes(alias));
}

function mergeStores(stores) {
  const seen = new Set();
  const merged = [];

  for (const store of stores) {
    const key = store.placeId || `${normalizeKey(store.name)}|${normalizeKey(store.address)}`;

    if (!store.name || seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(store);
  }

  return merged;
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
