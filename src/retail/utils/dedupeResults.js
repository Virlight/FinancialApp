export function dedupeSources(sources) {
  const seen = new Set();

  return sources.filter((source, index) => {
    if (!source?.uri || seen.has(source.uri)) {
      return false;
    }

    seen.add(source.uri);
    source.index = index + 1;
    return true;
  });
}
