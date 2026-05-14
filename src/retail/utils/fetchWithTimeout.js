export const requestTimeoutMs = 8000;

export async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

export async function fetchText(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: headersToObject(response.headers),
    text,
    url: String(url)
  };
}

export function looksLikeAccessChallenge(response) {
  const text = response?.text || "";
  const headers = response?.headers || {};

  return (
    response?.status === 403 ||
    /cf-mitigated|enable javascript and cookies|just a moment|challenge-error-title|challenge-error-text|checking your browser/i.test(
      text
    ) ||
    /challenge/i.test(headers["cf-mitigated"] || "")
  );
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || requestTimeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetcher = options.fetcher || fetch;
  const abortFromParent = () => controller.abort(options.signal.reason);

  if (options.signal?.aborted) {
    controller.abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", abortFromParent, {
      once: true
    });
  }

  try {
    const { fetcher: _fetcher, timeoutMs: _timeoutMs, signal: _signal, ...fetchOptions } = options;

    return await fetcher(url, {
      ...fetchOptions,
      signal: controller.signal
    });
  } finally {
    options.signal?.removeEventListener("abort", abortFromParent);
    clearTimeout(timeout);
  }
}

function headersToObject(headers) {
  if (!headers) {
    return {};
  }

  if (typeof headers.entries === "function") {
    return Object.fromEntries(headers.entries());
  }

  return {};
}
