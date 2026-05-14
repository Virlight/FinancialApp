export function buildMapPlacesFromChannels(channels, options = {}) {
  const limit = options.limit || 30;
  const places = (channels || []).flatMap((channel) => [
    ...(channel.mapPlaces || []),
    ...(channel.stores || []),
    ...(channel.candidateStores || [])
  ]);

  return dedupeMapPlaces(places.map(normalizeMapPlace).filter(Boolean)).slice(0, limit);
}

export function normalizeMapPlace(place) {
  if (!place || typeof place !== "object") {
    return null;
  }

  const latitude = normalizeCoordinate(
    place.latitude ?? place.lat ?? place.location?.latitude ?? place.location?.lat
  );
  const longitude = normalizeCoordinate(
    place.longitude ?? place.lng ?? place.location?.longitude ?? place.location?.lng
  );

  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    placeId: normalizeText(place.placeId || place.id),
    name: normalizeText(place.name || place.title),
    address: normalizeText(place.address || place.formattedAddress),
    latitude,
    longitude,
    googleMapsUri: normalizeText(place.googleMapsUri || place.mapUrl),
    websiteUri: normalizeText(place.websiteUri),
    sourceUrl: normalizeText(place.sourceUrl || place.googleMapsUri || place.websiteUri),
    source: normalizeText(place.source || place.provider || place.channel)
  };
}

function dedupeMapPlaces(places) {
  const seen = new Set();
  const deduped = [];

  for (const place of places) {
    const key =
      place.placeId ||
      `${normalizeKey(place.name)}|${normalizeKey(place.address)}|${place.latitude.toFixed(5)},${place.longitude.toFixed(5)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(place);
  }

  return deduped;
}

function normalizeCoordinate(value) {
  const number = typeof value === "number" ? value : Number.parseFloat(value);

  return Number.isFinite(number) ? number : null;
}

function normalizeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
