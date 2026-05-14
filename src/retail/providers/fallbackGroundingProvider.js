import { GoogleGenAI } from "@google/genai";
import { buildGroundingPrompt } from "../prompts/buildGroundingPrompt.js";

const defaultRetailSearchModel = "gemini-2.5-flash";

export const fallbackGroundingProvider = {
  id: "fallback_grounding",

  supports() {
    return true;
  },

  async search(request, context = {}) {
    if (context.signal?.aborted) {
      throw new Error("Retail grounding lookup was cancelled.");
    }

    const model = process.env.RETAIL_SEARCH_MODEL || process.env.GEMINI_MODEL || defaultRetailSearchModel;
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });
    const groundingPrompt = buildGroundingPrompt(request, context.primaryResults || []);
    const response = await ai.models.generateContent({
      model,
      contents: groundingPrompt,
      config: {
        temperature: 0,
        tools: [
          {
            googleSearch: {}
          }
        ]
      }
    });
    const grounding = extractGroundingMetadata(response);
    const rawEvidenceText = String(response.text || "").trim();
    const evidence = parseGroundedEvidence(rawEvidenceText);

    return {
      ok: hasGroundedEvidence(evidence),
      channel: "google_grounding",
      provider: "gemini_google_search_grounding",
      model,
      request,
      answer: evidence.summary || "Grounded evidence lookup completed.",
      evidence,
      rawEvidenceText,
      sources: grounding.sources,
      searchQueries: grounding.searchQueries,
      retrievedAt: new Date().toISOString(),
      caveats: [
        "Retailer websites may show online prices, local store prices, offers, and availability differently.",
        "If the grounded result does not cite an official retailer source, treat the price as unverified."
      ],
      debug: {
        groundingPrompt
      }
    };
  }
};

function extractGroundingMetadata(response) {
  const metadata = response.candidates?.[0]?.groundingMetadata || {};
  const sources = (metadata.groundingChunks || [])
    .map((chunk, index) => ({
      index: index + 1,
      title: chunk.web?.title || "Source",
      uri: chunk.web?.uri || null
    }))
    .filter((source) => source.uri);

  return {
    sources,
    searchQueries: metadata.webSearchQueries || []
  };
}

function parseGroundedEvidence(rawText) {
  const fallbackEvidence = {
    summary: rawText || "No grounded evidence was returned.",
    confirmed: [],
    strongLeads: [],
    onlineOnly: [],
    notConfirmed: [],
    searchedStores: [],
    caveats: []
  };

  if (!rawText) {
    return fallbackEvidence;
  }

  try {
    return normalizeEvidence(JSON.parse(stripJsonFence(rawText)));
  } catch {
    return fallbackEvidence;
  }
}

function normalizeEvidence(value) {
  const source = value && typeof value === "object" ? value : {};

  return {
    summary: typeof source.summary === "string" ? source.summary : "",
    confirmed: normalizeEvidenceArray(source.confirmed),
    strongLeads: normalizeEvidenceArray(source.strongLeads),
    onlineOnly: normalizeEvidenceArray(source.onlineOnly),
    notConfirmed: normalizeEvidenceArray(source.notConfirmed),
    searchedStores: Array.isArray(source.searchedStores)
      ? source.searchedStores.map((store) => String(store || "").trim()).filter(Boolean)
      : [],
    caveats: Array.isArray(source.caveats)
      ? source.caveats.map((caveat) => String(caveat || "").trim()).filter(Boolean)
      : []
  };
}

function normalizeEvidenceArray(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
}

function stripJsonFence(rawText) {
  return String(rawText)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function hasGroundedEvidence(evidence) {
  return Boolean(
    evidence.summary ||
      evidence.confirmed.length ||
      evidence.strongLeads.length ||
      evidence.onlineOnly.length ||
      evidence.notConfirmed.length
  );
}
