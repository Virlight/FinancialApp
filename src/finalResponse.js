import { GoogleGenAI } from "@google/genai";

const defaultFinalResponseModel = "gemini-2.5-flash";
const maxToolResultChars = 45000;

export async function composeFinalAssistantResponse({
  input,
  functionCall,
  execution,
  responseLanguage = "zh"
}) {
  const fallbackMessage = execution.result?.message || "The tool completed.";
  const outputLanguage = normalizeResponseLanguage(responseLanguage);

  if (!process.env.GEMINI_API_KEY) {
    return {
      provider: "local",
      model: "template-fallback",
      message: fallbackMessage,
      warning: "GEMINI_API_KEY is not set. Used the tool message directly.",
      debug: {
        skipped: true,
        responseLanguage: outputLanguage
      }
    };
  }

  const model = process.env.GEMINI_FINAL_RESPONSE_MODEL || process.env.GEMINI_MODEL || defaultFinalResponseModel;
  const prompt = buildFinalResponsePrompt({ input, functionCall, execution, responseLanguage: outputLanguage });

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.2,
        systemInstruction: buildFinalResponseSystemInstruction(outputLanguage)
      }
    });
    const message = String(response.text || "").trim();

    return {
      provider: "gemini",
      model,
      message: message || fallbackMessage,
      debug: {
        prompt,
        rawModelOutput: response.text || "",
        responseLanguage: outputLanguage
      }
    };
  } catch (error) {
    return {
      provider: "local",
      model: "template-fallback",
      message: fallbackMessage,
      warning: `Final response synthesis failed: ${error.message}`,
      debug: {
        prompt,
        error: error.message,
        responseLanguage: outputLanguage
      }
    };
  }
}

export async function composeFinalAssistantResponseStream({
  input,
  functionCall,
  execution,
  responseLanguage = "zh",
  onToken
}) {
  const fallbackMessage = execution.result?.message || "The tool completed.";
  const outputLanguage = normalizeResponseLanguage(responseLanguage);

  if (!process.env.GEMINI_API_KEY) {
    emitToken(onToken, fallbackMessage, fallbackMessage);

    return {
      provider: "local",
      model: "template-fallback",
      message: fallbackMessage,
      warning: "GEMINI_API_KEY is not set. Used the tool message directly.",
      debug: {
        skipped: true,
        responseLanguage: outputLanguage
      }
    };
  }

  const model = process.env.GEMINI_FINAL_RESPONSE_MODEL || process.env.GEMINI_MODEL || defaultFinalResponseModel;
  const prompt = buildFinalResponsePrompt({ input, functionCall, execution, responseLanguage: outputLanguage });
  let accumulatedMessage = "";

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });
    const stream = await ai.models.generateContentStream({
      model,
      contents: prompt,
      config: {
        temperature: 0.2,
        systemInstruction: buildFinalResponseSystemInstruction(outputLanguage)
      }
    });

    for await (const chunk of stream) {
      const token = String(chunk.text || "");

      if (!token) {
        continue;
      }

      accumulatedMessage += token;
      emitToken(onToken, token, accumulatedMessage);
    }

    const message = accumulatedMessage.trim();

    return {
      provider: "gemini",
      model,
      message: message || fallbackMessage,
      debug: {
        prompt,
        rawModelOutput: accumulatedMessage,
        responseLanguage: outputLanguage
      }
    };
  } catch (error) {
    emitToken(onToken, fallbackMessage, fallbackMessage);

    return {
      provider: "local",
      model: "template-fallback",
      message: fallbackMessage,
      warning: `Final response streaming failed: ${error.message}`,
      debug: {
        prompt,
        error: error.message,
        responseLanguage: outputLanguage
      }
    };
  }
}

export async function composePostActionFinalResponse({
  input,
  priorAssistantMessage,
  postFunctionCall,
  postExecution,
  responseLanguage = "zh"
}) {
  const fallbackMessage = buildPostActionFallbackMessage({
    priorAssistantMessage,
    postExecution
  });
  const outputLanguage = normalizeResponseLanguage(responseLanguage);

  if (!process.env.GEMINI_API_KEY) {
    return {
      provider: "local",
      model: "template-fallback",
      message: fallbackMessage,
      warning: "GEMINI_API_KEY is not set. Used the post-action tool message directly.",
      debug: {
        skipped: true,
        responseLanguage: outputLanguage
      }
    };
  }

  const model = process.env.GEMINI_FINAL_RESPONSE_MODEL || process.env.GEMINI_MODEL || defaultFinalResponseModel;
  const prompt = buildPostActionFinalResponsePrompt({
    input,
    priorAssistantMessage,
    postFunctionCall,
    postExecution,
    responseLanguage: outputLanguage
  });

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.2,
        systemInstruction: buildPostActionFinalResponseSystemInstruction(outputLanguage)
      }
    });
    const message = String(response.text || "").trim();

    return {
      provider: "gemini",
      model,
      message: message || fallbackMessage,
      debug: {
        prompt,
        rawModelOutput: response.text || "",
        responseLanguage: outputLanguage
      }
    };
  } catch (error) {
    return {
      provider: "local",
      model: "template-fallback",
      message: fallbackMessage,
      warning: `Post-action final response synthesis failed: ${error.message}`,
      debug: {
        prompt,
        error: error.message,
        responseLanguage: outputLanguage
      }
    };
  }
}

function buildFinalResponseSystemInstruction(responseLanguage) {
  const languageInstruction = buildLanguageInstruction(responseLanguage);

  return `
You write the final user-facing response after a registered app function has executed.
Use only the tool result and cited sources provided by the app. Do not invent prices, stock, stores, or actions.
${languageInstruction}
Write the response as clean Markdown:
- Use short sections with headings when the answer has multiple stores, products, sources, or caveats.
- Use bullet lists for offers or product results.
- Put one offer or product per bullet; do not compress several offers into one paragraph.
- Use Markdown links for sources when source URLs are available.
- For every source link, use descriptive link text such as "MediaMarkt 官方优惠页"; do not use the raw URL as the visible text.
- Keep blank lines between sections.
If the original user also asked to email/send the final answer, do not refuse or comment on email sending in this first answer. The app handles email as a separate post-response function after this answer is written.
For retail lookup:
- Distinguish confirmed physical-store availability, online-only availability, strong leads, and not-confirmed stores.
- If no Munich physical store has confirmed stock, say that clearly.
- Include useful official or product page links when the tool result provides them. Use the URL directly or a Markdown link; do not write bracketed source numbers such as [Source 1] unless the URL is also shown.
- Keep source links concise and do not expose internal debug details unless the user asked about workflow.
For retail offers lookup:
- Explain the pipeline result: Munich store discovery, official offer/prospect pages, then Google grounding fallback when official pages were not parseable.
- Distinguish confirmed offer items with prices from official offer/prospect pages that were found but not parsed into product prices.
- If no current store-specific offer price is confirmed, say that clearly.
- Prefer this shape: "查询结果", "门店优惠", "注意事项", "信源".
- End the response with a short "信源" section that lists source URLs from the tool result as clickable Markdown links.
For local merchant deal lookup:
- Explain whether current food/restaurant/app discounts were confirmed, only found as official deal/app pages, or not confirmed.
- Mention nearby mapped stores when store discovery was available, but do not claim a specific store honors an app-only coupon unless the source says so.
- Prefer this shape: "查询结果", "附近门店", "优惠线索", "注意事项", "信源".
- End with concise clickable Markdown source links.
For finance or email actions, summarize the completed action directly and briefly.
`.trim();
}

function buildPostActionFinalResponseSystemInstruction(responseLanguage) {
  const languageInstruction = buildLanguageInstruction(responseLanguage);

  return `
You write the final user-facing response after a post-response app function has executed.
Preserve the prior assistant answer's facts and source links. Do not add new retail facts.
Preserve clean Markdown formatting and clickable Markdown links.
Append a brief status sentence for the post-response action, such as whether the email was sent, prepared as a dry run, or failed.
${languageInstruction}
`.trim();
}

function buildFinalResponsePrompt({ input, functionCall, execution, responseLanguage }) {
  const toolResult = buildPromptToolResult(execution.result);

  return `
Output language:
${formatResponseLanguage(responseLanguage)}

User input:
${input}

Function call selected:
${JSON.stringify(functionCall, null, 2)}

Tool execution result:
${truncateJson(toolResult, maxToolResultChars)}

Write the final assistant response now.
`.trim();
}

function buildPostActionFinalResponsePrompt({
  input,
  priorAssistantMessage,
  postFunctionCall,
  postExecution,
  responseLanguage
}) {
  return `
Output language:
${formatResponseLanguage(responseLanguage)}

Original user input:
${input}

Prior final assistant answer:
${priorAssistantMessage}

Post-response function call selected:
${JSON.stringify(postFunctionCall, null, 2)}

Post-response tool execution result:
${truncateJson(buildPromptToolResult(postExecution.result), maxToolResultChars)}

Write the final web UI assistant response now.
`.trim();
}

function buildPromptToolResult(result) {
  if (result?.retailSearch) {
    const retailSearch = result.retailSearch;

    return {
      ok: result.ok,
      toolMessage: result.message,
      retailSearch: {
        request: retailSearch.request,
        provider: retailSearch.provider,
        evidence: retailSearch.evidence,
        sources: (retailSearch.sources || []).slice(0, 30),
        mapPlaces: (retailSearch.mapPlaces || []).slice(0, 30),
        searchQueries: (retailSearch.searchQueries || []).slice(0, 30),
        caveats: retailSearch.caveats || [],
        channels: (retailSearch.channels || []).map((channel) => ({
          channel: channel.channel,
          provider: channel.provider,
          retailer: channel.retailer,
          status: channel.status,
          ok: channel.ok,
          products: (channel.products || []).slice(0, 8),
          stores: (channel.stores || channel.candidateStores || []).slice(0, 30),
          evidence: channel.evidence || null,
          sources: (channel.sources || []).slice(0, 10)
        }))
      }
    };
  }

  if (result?.retailOffers) {
    const retailOffers = result.retailOffers;

    return {
      ok: result.ok,
      toolMessage: result.message,
      retailOffers: {
        request: retailOffers.request,
        provider: retailOffers.provider,
        evidence: retailOffers.evidence,
        sources: (retailOffers.sources || []).slice(0, 40),
        mapPlaces: (retailOffers.mapPlaces || []).slice(0, 30),
        searchQueries: (retailOffers.searchQueries || []).slice(0, 40),
        caveats: retailOffers.caveats || [],
        channels: (retailOffers.channels || []).map((channel) => ({
          channel: channel.channel,
          provider: channel.provider,
          retailer: channel.retailer,
          status: channel.status,
          ok: channel.ok,
          stores: (channel.stores || []).slice(0, 30),
          officialOfferPages: (channel.officialOfferPages || []).slice(0, 20),
          offers: (channel.offers || []).slice(0, 20),
          evidence: channel.evidence || null,
          sources: (channel.sources || []).slice(0, 15),
          searchQueries: (channel.searchQueries || []).slice(0, 20)
        }))
      }
    };
  }

  if (result?.localDeals) {
    const localDeals = result.localDeals;

    return {
      ok: result.ok,
      toolMessage: result.message,
      localDeals: {
        request: localDeals.request,
        provider: localDeals.provider,
        evidence: localDeals.evidence,
        sources: (localDeals.sources || []).slice(0, 40),
        mapPlaces: (localDeals.mapPlaces || []).slice(0, 30),
        searchQueries: (localDeals.searchQueries || []).slice(0, 40),
        caveats: localDeals.caveats || [],
        channels: (localDeals.channels || []).map((channel) => ({
          channel: channel.channel,
          provider: channel.provider,
          merchant: channel.merchant,
          status: channel.status,
          ok: channel.ok,
          stores: (channel.stores || []).slice(0, 30),
          officialDealPages: (channel.officialDealPages || []).slice(0, 20),
          deals: (channel.deals || []).slice(0, 20),
          evidence: channel.evidence || null,
          sources: (channel.sources || []).slice(0, 15),
          searchQueries: (channel.searchQueries || []).slice(0, 20)
        }))
      }
    };
  }

  return {
    ok: result?.ok,
    message: result?.message,
    expense: result?.expense,
    summary: result?.summary,
    profile: result?.profile,
    wishlist: result?.wishlist,
    wishlistTotal: result?.wishlistTotal,
    email: result?.email,
    errors: result?.errors
  };
}

function buildPostActionFallbackMessage({ priorAssistantMessage, postExecution }) {
  return [priorAssistantMessage, postExecution.result?.message].filter(Boolean).join("\n\n");
}

function emitToken(onToken, token, accumulatedMessage) {
  if (typeof onToken === "function") {
    onToken(token, accumulatedMessage);
  }
}

function normalizeResponseLanguage(value) {
  return value === "en" ? "en" : "zh";
}

function formatResponseLanguage(value) {
  return normalizeResponseLanguage(value) === "en" ? "English" : "Simplified Chinese";
}

function buildLanguageInstruction(value) {
  return normalizeResponseLanguage(value) === "en"
    ? "Always reply in English, even if the user input or tool data is in another language."
    : "Always reply in Simplified Chinese, even if the user input or tool data is in another language.";
}

function truncateJson(value, maxChars) {
  const json = JSON.stringify(value, null, 2);

  if (json.length <= maxChars) {
    return json;
  }

  return `${json.slice(0, maxChars)}\n...TRUNCATED...`;
}
