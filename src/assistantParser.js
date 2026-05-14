import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import {
  supportedCategories,
  supportedCurrencies,
  supportedFunctionNames,
  supportedPeriods,
  supportedPriorities,
  normalizeFunctionCall
} from "./functionSchema.js";
import {
  findRetailerIdsInText,
  looksLikeAsianGroceryQuery,
  looksLikeConsumerElectronicsQuery,
  retailerConfigs,
  supportedRetailLookupTypes,
  supportedRetailerIds
} from "./retailerConfig.js";
import { extractKnownMerchantName, looksLikeFoodMerchant } from "./localDeals/lookupLocalDeals.js";

const defaultModel = "gemini-2.5-flash";
const functionDeclarations = buildFunctionDeclarations();
const allowedFunctionNames = functionDeclarations.map((declaration) => declaration.name);

export async function parseAssistantFunctionCall(userText) {
  const input = String(userText || "").trim();
  const systemInstruction = buildSystemInstruction();
  const toolConfig = buildToolConfig(input);

  if (!input) {
    const functionCall = normalizeFunctionCall({
      name: "unsupported",
      args: {
        reason: "Empty input"
      }
    });

    return {
      provider: "mock",
      model: "local-rule-parser",
      functionCall,
      debug: buildDebugPayload({
        input,
        systemInstruction,
        rawModelOutput: JSON.stringify([functionCall], null, 2),
        parserMode: "empty-input",
        toolConfig
      })
    };
  }

  if (!process.env.GEMINI_API_KEY) {
    const functionCall = normalizeFunctionCall(parseWithMockRules(input));

    return {
      provider: "mock",
      model: "local-rule-parser",
      functionCall,
      warning: "GEMINI_API_KEY is not set. Used local mock parser for demo verification.",
      debug: buildDebugPayload({
        input,
        systemInstruction,
        rawModelOutput: JSON.stringify([functionCall], null, 2),
        parserMode: "mock-fallback",
        toolConfig
      })
    };
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });
    const model = process.env.GEMINI_MODEL || defaultModel;

    const response = await ai.models.generateContent({
      model,
      contents: input,
      config: {
        temperature: 0,
        systemInstruction,
        tools: [
          {
            functionDeclarations
          }
        ],
        toolConfig
      }
    });
    const functionCall = normalizeFunctionCall(extractFunctionCall(response));
    const rawModelOutput = JSON.stringify(response.functionCalls || [], null, 2);

    return {
      provider: "gemini",
      model,
      functionCall,
      debug: buildDebugPayload({
        input,
        systemInstruction,
        rawModelOutput,
        parserMode: "gemini-function-calling",
        toolConfig
      })
    };
  } catch (error) {
    const functionCall = normalizeFunctionCall(parseWithMockRules(input));

    return {
      provider: "mock",
      model: "local-rule-parser",
      functionCall,
      warning: `Gemini parsing failed. Used local mock parser instead: ${error.message}`,
      debug: buildDebugPayload({
        input,
        systemInstruction,
        rawModelOutput: JSON.stringify([functionCall], null, 2),
        parserMode: "gemini-function-calling-error-fallback",
        toolConfig,
        error: error.message
      })
    };
  }
}

export async function parsePostResponseFunctionCall({ input, finalMessage }) {
  const userText = String(input || "").trim();
  const message = String(finalMessage || "").trim();

  if (!looksLikeSendFinalAnswerEmailRequest(userText) || !message) {
    return null;
  }

  const fallbackCall = normalizeFunctionCall({
    name: "send_email",
    args: {
      recipientEmails: resolveRequestedRecipientEmails(userText),
      emailSubject: buildFinalAnswerEmailSubject(userText),
      emailBody: message
    }
  });

  if (!fallbackCall.args.recipientEmails?.length && !fallbackCall.args.recipientEmail) {
    return null;
  }

  if (!process.env.GEMINI_API_KEY) {
    return {
      provider: "mock",
      model: "local-post-action-parser",
      functionCall: fallbackCall,
      debug: {
        parserMode: "post-response-mock-fallback",
        input: userText,
        finalMessage: message
      }
    };
  }

  const systemInstruction = `
You decide whether to call a post-response function after the assistant has produced a final answer.
Only call send_email when the original user explicitly asked to email/send/mail the final answer/result.
If the user asks for multiple recipients, call send_email with recipientEmails containing every requested email address.
If the user says "to me", "给我", "我自己的邮箱", or similar, include this configured recipient too: ${process.env.GMAIL_USER || "missing"}.
The email body must be exactly the final answer text supplied by the app.
If no email should be sent, call unsupported.
`.trim();

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });
    const model = process.env.GEMINI_MODEL || defaultModel;
    const response = await ai.models.generateContent({
      model,
      contents: `
Original user input:
${userText}

Final answer to email:
${message}
`.trim(),
      config: {
        temperature: 0,
        systemInstruction,
        tools: [
          {
            functionDeclarations: buildPostResponseFunctionDeclarations()
          }
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: ["send_email", "unsupported"]
          }
        }
      }
    });
    const functionCall = normalizeFunctionCall(extractFunctionCall(response));

    if (functionCall.name !== "send_email") {
      return null;
    }

    const enforcedFunctionCall = normalizeFunctionCall({
      name: "send_email",
      args: {
        recipientEmails:
          mergeRecipientEmails(
            functionCall.args.recipientEmails,
            functionCall.args.recipientEmail,
            fallbackCall.args.recipientEmails
          ),
        emailSubject: functionCall.args.emailSubject || fallbackCall.args.emailSubject,
        emailBody: message
      }
    });

    return {
      provider: "gemini",
      model,
      functionCall: enforcedFunctionCall,
      debug: {
        parserMode: "post-response-function-calling",
        input: userText,
        systemInstruction,
        rawModelOutput: JSON.stringify(response.functionCalls || [], null, 2)
      }
    };
  } catch (error) {
    return {
      provider: "mock",
      model: "local-post-action-parser",
      functionCall: fallbackCall,
      warning: `Post-response function calling failed. Used local fallback: ${error.message}`,
      debug: {
        parserMode: "post-response-error-fallback",
        input: userText,
        finalMessage: message,
        error: error.message
      }
    };
  }
}

function buildDebugPayload({ input, systemInstruction, rawModelOutput, parserMode, toolConfig, error = null }) {
  return {
    parserMode,
    input,
    promptSentToModel: {
      systemInstruction,
      userInput: input
    },
    modelOutputContract: {
      mode: "function_calling",
      toolConfig,
      tools: [
        {
          functionDeclarations
        }
      ]
    },
    rawModelOutput,
    functionCallingNote:
      "Gemini returns a registered function call. The app validates that function call and executes it directly.",
    error
  };
}

function buildSystemInstruction() {
  const today = new Date().toISOString().slice(0, 10);

  return `
You route each Financial App assistant request by calling exactly one registered function.
- Current date is ${today}.
- Use the registered unsupported function for transfers, investments, payments, loans, or anything outside this MVP.
- Use EUR when user says euro, euros, €, 欧, or 欧元. Use USD when user says dollar, dollars, or $.
- If the user says 块 or 块钱 without RMB/人民币/CNY, treat the currency as unclear and default to EUR for this Munich-based app.
- Translate common Chinese finance phrases into the schema values.
- For unclear summary periods, default to current_month.
- When the user asks to change, set, edit, update, or modify personal profile fields such as name, monthly income, monthly budget, current balance, base currency, or savings goal, call update_profile.
- When a request asks to send email, extract every requested recipient email address, a short subject, and the plain-text body. Use recipientEmails for multiple recipients. If a required email field is missing, call unsupported.
- If a request asks to look up information and then email the final answer, first call the information lookup function. Emailing the final answer is handled after final response synthesis.
- Routing priority: for combined requests such as "look up/summarize/check X and send the final answer to me", ignore the email part during this first function call. Do not call send_email or unsupported because the first step has no recipient.
- If the user is recording an expense/spending event, call create_expense first. The app runs discount lookup as a post-action background job after the expense is recorded.
- When a request asks for retailer discounts, offers, weekly deals, Angebote, Prospekt, or 打折/优惠 at Munich retailers, call lookup_retail_offers. Default the location to Munich, Germany and period to current_week.
- When a request asks for discounts, coupons, app offers, deals, Gutscheine, 打折, 折扣, 优惠, or 促销 at a named restaurant, cafe, food chain, or local merchant such as McDonald's/麦当劳, KFC/肯德基, Burger King/汉堡王, Subway/赛百味, or Starbucks/星巴克, call lookup_local_deals. Default location to Munich, Germany and period to current_week.
- When a request asks for current product price, stock, or availability at Munich retailers such as MediaMarkt, Saturn, EDEKA, ROSSMANN, REWE, PENNY, Lidl, ALDI, or IKEA, call lookup_store_product. Default the location to Munich, Germany. If no retailer is specified, use all_supported.
- For consumer electronics such as iPad, Apple Pencil, phones, tablets, laptops, or headphones, default unspecified retailers to mediamarkt and saturn.
- For Asian grocery or Asian supermarket discovery in Munich, including queries for 肉松, pork floss, rousong, or meat floss, use retailer id asian_grocery. This can include Asian supermarkets that are not pre-enumerated.
`.trim();
}

function buildToolConfig(input = "") {
  return {
    functionCallingConfig: {
      mode: FunctionCallingConfigMode.ANY,
      allowedFunctionNames: getAllowedFunctionNamesForInput(input)
    }
  };
}

function getAllowedFunctionNamesForInput(input) {
  const lowerInput = String(input || "").toLowerCase();

  if (!looksLikeSendFinalAnswerEmailRequest(input)) {
    return allowedFunctionNames;
  }

  if (looksLikeRetailOfferRequest(input)) {
    return ["lookup_retail_offers", "unsupported"];
  }

  if (looksLikeLocalDealRequest(input)) {
    return ["lookup_local_deals", "unsupported"];
  }

  if (looksLikeRetailLookupRequest(input)) {
    return ["lookup_store_product", "unsupported"];
  }

  if (looksLikeOverviewRequest(lowerInput)) {
    return ["get_financial_overview", "unsupported"];
  }

  if (looksLikeSummaryRequest(lowerInput)) {
    return ["get_spending_summary", "unsupported"];
  }

  if (
    looksLikeWishlistRequest(lowerInput) &&
    (looksLikeListRequest(lowerInput) || looksLikeWishlistAmountQuestion(lowerInput))
  ) {
    return ["get_wishlist", "unsupported"];
  }

  return allowedFunctionNames;
}

function extractFunctionCall(response) {
  const functionCall = response.functionCalls?.[0];

  if (!functionCall?.name) {
    throw new Error("Gemini did not return a function call.");
  }

  return functionCall;
}

function buildFunctionDeclarations() {
  return [
    {
      name: "create_expense",
      description: "Record a user expense or spending event.",
      parametersJsonSchema: objectSchema(
        {
          amount: numberSchema("Positive expense amount."),
          currency: enumSchema(supportedCurrencies, "ISO currency code."),
          category: enumSchema(supportedCategories, "Finance category."),
          note: stringSchema("Short user-facing expense note, such as lunch or coffee."),
          date: stringSchema("ISO date YYYY-MM-DD if the user mentions a date.")
        },
        ["amount", "currency"]
      )
    },
    {
      name: "delete_expense",
      description:
        "Delete an existing expense by explicit id or natural-language selectors such as amount, category, and note.",
      parametersJsonSchema: objectSchema({
        expenseId: stringSchema("Expense id when explicitly provided."),
        amount: numberSchema("Expense amount selector."),
        currency: enumSchema(supportedCurrencies, "Currency selector."),
        category: enumSchema(supportedCategories, "Category selector."),
        note: stringSchema("Description selector, such as lunch or coffee.")
      })
    },
    {
      name: "create_wishlist_item",
      description: "Create a wishlist item, purchase plan, or savings plan for an item.",
      parametersJsonSchema: objectSchema(
        {
          itemName: stringSchema("Wishlist or purchase plan item name."),
          targetAmount: numberSchema("Target price or budget when present."),
          currency: enumSchema(supportedCurrencies, "ISO currency code."),
          priority: enumSchema(supportedPriorities, "Wishlist priority."),
          dueDate: stringSchema("ISO date YYYY-MM-DD for the purchase target date."),
          note: stringSchema("Short note for the wishlist item.")
        },
        ["itemName"]
      )
    },
    {
      name: "get_wishlist",
      description:
        "View, list, check, or calculate purchase plans, wishlist items, wishlist amount, or planned purchase cost.",
      parametersJsonSchema: objectSchema({})
    },
    {
      name: "send_email",
      description: "Send a plain-text email message through the configured Gmail sender.",
      parametersJsonSchema: objectSchema(
        {
          recipientEmail: stringSchema("Recipient email address."),
          recipientEmails: arraySchema(
            stringSchema("Recipient email address."),
            "Recipient email addresses when the user requests multiple recipients."
          ),
          emailSubject: stringSchema("Short email subject line."),
          emailBody: stringSchema("Plain-text email body.")
        },
        ["emailSubject", "emailBody"]
      )
    },
    {
      name: "lookup_store_product",
      description:
        "Look up current product price, stock, availability, or product information for supported Munich physical retailers using grounded web research.",
      parametersJsonSchema: objectSchema(
        {
          productQuery: stringSchema("The product or product category to look up."),
          retailers: arraySchema(
            enumSchema(supportedRetailerIds, "Supported retailer id."),
            "Retailer ids to search. Use mediamarkt and saturn for consumer electronics when the user does not specify a retailer. Use asian_grocery for Munich Asian supermarket discovery. Otherwise use all_supported."
          ),
          location: stringSchema("City or local area. Default to Munich, Germany."),
          lookupType: enumSchema(supportedRetailLookupTypes, "The type of product lookup requested."),
          date: stringSchema("ISO date YYYY-MM-DD when the user asks about a specific day.")
        },
        ["productQuery"]
      )
    },
    {
      name: "lookup_retail_offers",
      description:
        "Look up current or recent retailer discounts, weekly offers, Angebote, promotions, or prospect pages for supported Munich retailers.",
      parametersJsonSchema: objectSchema(
        {
          retailers: arraySchema(
            enumSchema(supportedRetailerIds, "Supported retailer id."),
            "Retailer ids to search for offers. Use edeka for EDEKA/edika offer questions."
          ),
          location: stringSchema("City or local area. Default to Munich, Germany."),
          period: enumSchema(supportedPeriods, "Offer period. Use current_week for recent/current offers."),
          date: stringSchema("ISO date YYYY-MM-DD when the user asks about a specific day.")
        },
        ["retailers"]
      )
    },
    {
      name: "lookup_local_deals",
      description:
        "Look up current or recent discounts, coupons, app offers, meal deals, Gutscheine, Aktionen, or promotions for a named Munich restaurant, cafe, food chain, or local merchant.",
      parametersJsonSchema: objectSchema(
        {
          merchantQuery: stringSchema("Named merchant, restaurant, cafe, food chain, or local shop, such as McDonald's or 麦当劳."),
          productQuery: stringSchema("Optional product, meal, or purchase context, such as 汉堡套餐."),
          category: enumSchema(supportedCategories, "Category context. Use food for restaurants and food chains."),
          location: stringSchema("City or local area. Default to Munich, Germany."),
          period: enumSchema(supportedPeriods, "Offer period. Use current_week for recent/current offers."),
          date: stringSchema("ISO date YYYY-MM-DD when the user asks about a specific day.")
        },
        ["merchantQuery"]
      )
    },
    {
      name: "update_profile",
      description:
        "Update editable personal finance profile fields such as name, base currency, current balance, monthly income, monthly budget, or savings goal.",
      parametersJsonSchema: objectSchema({
        name: stringSchema("User display name."),
        baseCurrency: enumSchema(supportedCurrencies, "Default profile currency."),
        currentBalance: numberSchema("Current account balance."),
        monthlyIncome: numberSchema("Monthly income amount."),
        monthlyBudget: numberSchema("Monthly spending budget amount."),
        savingsGoalName: stringSchema("Savings goal display name."),
        savingsGoalTargetAmount: numberSchema("Savings goal target amount."),
        savingsGoalSavedAmount: numberSchema("Amount already saved toward the savings goal.")
      })
    },
    {
      name: "get_profile",
      description: "Show the user's profile, account info, current balance, monthly budget, or assets.",
      parametersJsonSchema: objectSchema({})
    },
    {
      name: "get_spending_summary",
      description:
        "Show spending totals, category breakdowns, or answer how much was spent for a period.",
      parametersJsonSchema: objectSchema(
        {
          period: enumSchema(supportedPeriods, "Summary period. Default to current_month when unclear."),
          category: enumSchema(supportedCategories, "Specific category when the user asks for one.")
        },
        ["period"]
      )
    },
    {
      name: "get_financial_overview",
      description:
        "Show an overall financial recap combining balance, spending summary, category breakdown, latest expenses, and wishlist.",
      parametersJsonSchema: objectSchema({
        period: enumSchema(supportedPeriods, "Overview period. Default to current_month when unclear.")
      })
    },
    {
      name: "unsupported",
      description:
        "Use when the request is outside this MVP, ambiguous, missing required fields, or cannot be safely mapped to another registered function.",
      parametersJsonSchema: objectSchema(
        {
          reason: stringSchema("Short reason the request cannot be handled.")
        },
        ["reason"]
      )
    }
  ];
}

function buildPostResponseFunctionDeclarations() {
  return [
    {
      name: "send_email",
      description: "Send the final assistant answer by email after another tool has completed.",
      parametersJsonSchema: objectSchema(
        {
          recipientEmail: stringSchema("Recipient email address."),
          recipientEmails: arraySchema(
            stringSchema("Recipient email address."),
            "Recipient email addresses when the user requests multiple recipients."
          ),
          emailSubject: stringSchema("Short email subject line."),
          emailBody: stringSchema("Plain-text email body. Must be the final answer text.")
        },
        ["emailSubject", "emailBody"]
      )
    },
    {
      name: "unsupported",
      description: "Use when no post-response action is needed.",
      parametersJsonSchema: objectSchema({
        reason: stringSchema("Short reason no post-response action is needed.")
      })
    }
  ];
}

function objectSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function stringSchema(description) {
  return {
    type: "string",
    description
  };
}

function numberSchema(description) {
  return {
    type: "number",
    description
  };
}

function enumSchema(values, description) {
  return {
    type: "string",
    enum: values,
    description
  };
}

function arraySchema(items, description) {
  return {
    type: "array",
    items,
    description
  };
}

function parseWithMockRules(input) {
  const lowerInput = input.toLowerCase();
  const amount = extractAmount(input);
  const currency = extractCurrency(input);

  if (looksLikeRetailOfferRequest(input)) {
    return functionCall("lookup_retail_offers", {
      retailers: findRetailerIdsInText(input),
      location: extractRetailLocation(input),
      period: extractOfferPeriod(input),
      date: extractRetailDate(input)
    });
  }

  if (looksLikeRetailLookupRequest(input)) {
    return functionCall("lookup_store_product", {
      productQuery: extractRetailProductQuery(input),
      retailers: findRetailerIdsInText(input),
      location: extractRetailLocation(input),
      lookupType: extractRetailLookupType(input),
      date: extractRetailDate(input)
    });
  }

  if (looksLikeEmailRequest(lowerInput)) {
    return functionCall("send_email", {
      recipientEmails: resolveRequestedRecipientEmails(input),
      emailSubject: extractEmailSubject(input),
      emailBody: extractEmailBody(input)
    });
  }

  if (looksLikeProfileUpdateRequest(input)) {
    return functionCall("update_profile", extractProfileUpdateArgs(input));
  }

  if (
    looksLikeWishlistRequest(lowerInput) &&
    !looksLikeWishlistCreateRequest(lowerInput) &&
    (looksLikeListRequest(lowerInput) || looksLikeWishlistAmountQuestion(lowerInput))
  ) {
    return functionCall("get_wishlist");
  }

  if (looksLikeOverviewRequest(lowerInput)) {
    return functionCall("get_financial_overview", {
      period: extractPeriod(lowerInput)
    });
  }

  if (looksLikeWishlistRequest(lowerInput)) {
    const itemName = extractWishlistItemName(input);

    return functionCall("create_wishlist_item", {
      itemName,
      targetAmount: amount,
      currency: currency || (amount === null ? null : "EUR"),
      priority: extractPriority(lowerInput),
      note: "purchase plan"
    });
  }

  if (looksLikeDeleteRequest(lowerInput)) {
    const category = extractCategory(lowerInput);
    const note = extractNote(lowerInput, category);

    return functionCall("delete_expense", {
      amount,
      currency,
      category,
      note: note === "other" ? null : note
    });
  }

  if (looksLikeProfileRequest(lowerInput)) {
    return functionCall("get_profile");
  }

  if (looksLikeSummaryRequest(lowerInput)) {
    return functionCall("get_spending_summary", {
      period: extractPeriod(lowerInput),
      category: extractSpecificCategory(lowerInput)
    });
  }

  if (amount !== null && looksLikeExpenseRequest(lowerInput)) {
    const category = extractCategory(lowerInput);
    const note = extractNote(lowerInput, category);

    return functionCall("create_expense", {
      amount,
      currency: currency || "EUR",
      category,
      note
    });
  }

  if (looksLikeLocalDealRequest(input)) {
    return functionCall("lookup_local_deals", {
      merchantQuery: extractLocalMerchantQuery(input),
      productQuery: extractLocalDealProductQuery(input),
      category: "food",
      location: extractRetailLocation(input),
      period: extractOfferPeriod(input),
      date: extractRetailDate(input)
    });
  }

  return functionCall("unsupported", {
    reason: "The mock parser could not map this request to an MVP action."
  });
}

function functionCall(name, args = {}) {
  return {
    name,
    args
  };
}

function extractAmount(input) {
  const match = input.match(/(?:€|\$|eur|usd|欧元?|美元?)?\s*(\d+(?:[.,]\d{1,2})?)/i);

  if (!match) {
    return null;
  }

  return Number.parseFloat(match[1].replace(",", "."));
}

function extractCurrency(input) {
  if (/(€|eur|euro|euros|欧|欧元)/i.test(input)) {
    return "EUR";
  }

  if (/(\$|usd|dollar|dollars|美元)/i.test(input)) {
    return "USD";
  }

  if (/(gbp|pound|pounds|英镑)/i.test(input)) {
    return "GBP";
  }

  if (/(cny|rmb|人民币|¥)/i.test(input)) {
    return "CNY";
  }

  return null;
}

function extractRecipientEmail(input) {
  return extractRecipientEmails(input)[0] || null;
}

function extractRecipientEmails(input) {
  const matches = String(input || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return mergeRecipientEmails(matches);
}

function resolveRequestedRecipientEmails(input) {
  const requestedEmails = extractRecipientEmails(input);

  if (looksLikeOwnEmailRecipient(input)) {
    requestedEmails.push(process.env.GMAIL_USER);
  }

  return mergeRecipientEmails(requestedEmails);
}

function mergeRecipientEmails(...values) {
  const rawEmails = values.flatMap((value) => {
    if (Array.isArray(value)) {
      return value;
    }

    if (typeof value === "string") {
      return value.split(/[,\s;]+/);
    }

    return [];
  });
  const seen = new Set();
  const emails = [];

  for (const rawEmail of rawEmails) {
    const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
    const key = email.toLowerCase();

    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !seen.has(key)) {
      seen.add(key);
      emails.push(email);
    }
  }

  return emails;
}

function looksLikeOwnEmailRecipient(input) {
  return /(\bto me\b|\bmy email\b|\bmy own email\b|给我|发给我|发到我|我的邮箱|自己.*邮箱|我自己.*邮箱)/i.test(
    input
  );
}

function extractEmailSubject(input) {
  const patterns = [
    /subject\s*(?:is|:)?\s*["“]?(.+?)(?:["”]?\s+(?:saying|body|message|content)\b|$)/i,
    /主题(?:是|为|:)?\s*["“]?(.+?)(?:["”]?[，,。]\s*(?:内容|正文)|$)/i
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);

    if (match?.[1]) {
      return cleanupEmailText(match[1]);
    }
  }

  return "Message from Financial App";
}

function extractEmailBody(input) {
  const patterns = [
    /(?:saying|body|message|content)\s*(?:is|:)?\s*["“]?(.+?)["”]?$/i,
    /(?:内容|正文)(?:是|为|:)?\s*["“]?(.+?)["”]?$/i
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);

    if (match?.[1]) {
      return cleanupEmailText(match[1]);
    }
  }

  return input.replace(extractRecipientEmail(input) || "", "").trim();
}

function cleanupEmailText(text) {
  return text
    .replace(/^[，,。:\s]+|[，,。:\s]+$/g, "")
    .replace(/^["“]|["”]$/g, "")
    .trim();
}

function looksLikeRetailLookupRequest(input) {
  const lowerInput = input.toLowerCase();
  const hasRetailer = retailerConfigs.some((retailer) =>
    [retailer.id, retailer.displayName.toLowerCase(), ...retailer.aliases].some((alias) =>
      lowerInput.includes(alias.toLowerCase())
    )
  );
  const hasRetailIntent =
    /(price|cost|how much|availability|available|in stock|stock|store|shop|retailer|价格|多少钱|多少|有货|库存|商品|商场|超市|门店|实体店|今天)/i.test(
      input
    );

  return (hasRetailer || looksLikeConsumerElectronicsQuery(input) || looksLikeAsianGroceryQuery(input)) && hasRetailIntent;
}

function looksLikeRetailOfferRequest(input) {
  const lowerInput = input.toLowerCase();
  const hasRetailer = retailerConfigs.some((retailer) =>
    [retailer.id, retailer.displayName.toLowerCase(), ...retailer.aliases].some((alias) =>
      lowerInput.includes(alias.toLowerCase())
    )
  );
  const hasOfferIntent = /(discount|deal|offer|offers|promotion|promo|sale|weekly|prospekt|angebote|angebot|打折|折扣|优惠|促销|特价|近期|本周|这周|最近)/i.test(
    input
  );

  return hasRetailer && hasOfferIntent;
}

function looksLikeLocalDealRequest(input) {
  const hasOfferIntent = /(discount|deal|deals|offer|offers|coupon|coupons|promotion|promo|sale|gutschein|gutscheine|angebote|angebot|aktion|aktionen|打折|折扣|优惠|促销|特价|券|套餐|近期|本周|这周|最近)/i.test(
    input
  );

  return hasOfferIntent && looksLikeFoodMerchant(input);
}

function extractLocalMerchantQuery(input) {
  const knownMerchant = extractKnownMerchantName(input);

  if (knownMerchant) {
    return knownMerchant;
  }

  const patterns = [
    /(?:最近|当前|现在|本周|这周)?\s*([^，。?？]+?)(?:有什么|有哪些|有没有).*(?:打折|折扣|优惠|促销|特价|券|套餐)/i,
    /(?:discounts?|deals?|offers?|coupons?|promotions?)\s+(?:at|for|from)\s+(.+?)(?:\s+(?:in|near|munich|münchen)|$)/i,
    /(?:at|from)\s+(.+?)\s+(?:discounts?|deals?|offers?|coupons?)/i
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);

    if (match?.[1]) {
      return cleanupLocalDealText(match[1]);
    }
  }

  return cleanupLocalDealText(input);
}

function extractLocalDealProductQuery(input) {
  const cleaned = String(input || "")
    .replace(extractLocalMerchantQuery(input), " ")
    .replace(/(mcdonald'?s?|麦当劳|麦當勞|burger king|汉堡王|漢堡王|kfc|肯德基|subway|赛百味|賽百味|starbucks|星巴克)/gi, " ")
    .replace(/(最近|当前|现在|本周|这周|有什么|有哪些|有没有|打折|折扣|优惠|促销|特价|券|帮我|能帮我|看看|查看|查询|吗|么|munich|münchen|muenchen|deals?|offers?|discounts?|coupons?|promotions?|at|for|from|in|near)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleanupLocalDealText(cleaned) || null;
}

function cleanupLocalDealText(text) {
  return String(text || "")
    .replace(/^[，,。:!?？\s]+|[，,。:!?？\s]+$/g, "")
    .trim();
}

function extractRetailProductQuery(input) {
  const specificPatterns = [
    /^([^，。?？]+?)(?:在|于)\s*(?:munich|münchen|muenchen|慕尼黑)?\s*(?:哪个|哪家|哪些)?.*(?:亚洲超市|亚洲商店|亚超).*(?:有卖|卖|有货)/i,
    /(?:where\s+(?:can|could)\s+i\s+(?:buy|find)|which\s+.+?(?:sells|has))\s+(.+?)\s+(?:in|at|near).*(?:asian\s+(?:supermarket|grocery|market)|asia\s+markt)/i,
    /(?:有没有|有无|卖不卖)([^，。?？]+?)(?:这个)?(?:商品)?(?:，|。|,|\.|$|有的话|的话|价格|多少钱|多少)/i,
    /(?:里|下|卖|有)([^，。?？]+?)(?:价格|多少钱|多少|有货|库存|信息|内容)/i,
    /(?:price|cost|availability|stock)\s+(?:of|for)\s+(.+?)\s+(?:at|in|near|from)\b/i,
    /(?:how much is|how much are)\s+(.+?)\s+(?:at|in|near|from)\b/i
  ];

  for (const pattern of specificPatterns) {
    const match = input.match(pattern);

    if (match?.[1]) {
      return cleanupRetailProductText(match[1]);
    }
  }

  let cleaned = input;

  for (const retailer of retailerConfigs) {
    for (const alias of [retailer.id, retailer.displayName, ...retailer.aliases]) {
      cleaned = cleaned.replace(new RegExp(escapeRegExp(alias), "gi"), " ");
    }
  }

  cleaned = cleaned
    .replace(
      /(today|current|now|munich|münchen|muenchen|germany|price|cost|how much|availability|available|in stock|stock|store|stores|shop|retailer|near|find|look up|show|please|which|what|今天|当前|现在|慕尼黑|德国|价格|多少钱|多少|有货|库存|商品|商场|超市|门店|实体店|亚洲超市|亚洲商店|亚超|查看|查询|查一下|查查|帮我|哪个|哪家|哪些|有卖|买得到|可以买|里的|里|下|的|内容|信息)/gi,
      " "
    )
    .replace(/(有没有|有无|卖不卖|如果有|有的话|的话|这个)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleanupRetailProductText(cleaned) || "product";
}

function cleanupRetailProductText(text) {
  return String(text || "")
    .replace(/^(没有|有无|有没有|卖不卖)/, "")
    .replace(/(这个)?商品$/, "")
    .replace(/^[，,。:!?？\s]+|[，,。:!?？\s]+$/g, "")
    .trim();
}

function extractRetailLocation(input) {
  if (/(münchen|muenchen|munich|慕尼黑)/i.test(input)) {
    return "Munich, Germany";
  }

  return "Munich, Germany";
}

function extractRetailLookupType(input) {
  const asksPrice = /(price|cost|how much|价格|多少钱|多少)/i.test(input);
  const asksAvailability = /(availability|available|in stock|stock|有货|库存|有没有|有无|卖不卖|有卖|买得到|可以买)/i.test(input);

  if (asksPrice && asksAvailability) {
    return "price_and_availability";
  }

  if (asksPrice) {
    return "price";
  }

  if (asksAvailability) {
    return "availability";
  }

  return "product_info";
}

function extractRetailDate(input) {
  return /(today|今天|current|当前|now|现在)/i.test(input)
    ? new Date().toISOString().slice(0, 10)
    : null;
}

function extractOfferPeriod(input) {
  if (/(today|今天)/i.test(input)) {
    return "today";
  }

  if (/(week|weekly|本周|这周|近期|最近|current|当前|now|现在)/i.test(input)) {
    return "current_week";
  }

  return "current_week";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeProfileRequest(input) {
  return /(profile|profil|账户|账号|个人|余额|预算|资产|财务状况|account|balance|budget)/i.test(input);
}

function looksLikeProfileUpdateRequest(input) {
  const hasUpdateVerb = /(change|set|update|edit|modify|rename|改|修改|设置|设为|改成|更新|编辑|叫|名字是|收入是|预算是|余额是)/i.test(
    input
  );
  const hasProfileField = /(name|income|salary|budget|balance|currency|saving|savings|goal|名字|姓名|收入|工资|月收入|预算|月预算|余额|货币|币种|储蓄|存款|目标)/i.test(
    input
  );

  return hasUpdateVerb && hasProfileField;
}

function extractProfileUpdateArgs(input) {
  return {
    name: extractProfileName(input),
    baseCurrency: extractProfileBaseCurrency(input),
    currentBalance: extractProfileMoneyField(input, [
      /(?:balance|current balance)\s*(?:is|to|:)?\s*(?:€|eur|euro|euros|欧元?|美元?|\$|cny|rmb|人民币|¥)?\s*(\d+(?:[.,]\d{1,2})?)/i,
      /(?:余额|当前余额)(?:改成|改为|设置为|设为|是|为|:)?\s*(?:€|eur|euro|euros|欧元?|美元?|\$|cny|rmb|人民币|¥)?\s*(\d+(?:[.,]\d{1,2})?)/i
    ]),
    monthlyIncome: extractProfileMoneyField(input, [
      /(?:monthly income|income|salary)\s*(?:is|to|:)?\s*(?:€|eur|euro|euros|欧元?|美元?|\$|cny|rmb|人民币|¥)?\s*(\d+(?:[.,]\d{1,2})?)/i,
      /(?:月收入|收入|工资)(?:改成|改为|设置为|设为|是|为|:)?\s*(?:€|eur|euro|euros|欧元?|美元?|\$|cny|rmb|人民币|¥)?\s*(\d+(?:[.,]\d{1,2})?)/i
    ]),
    monthlyBudget: extractProfileMoneyField(input, [
      /(?:monthly budget|budget)\s*(?:is|to|:)?\s*(?:€|eur|euro|euros|欧元?|美元?|\$|cny|rmb|人民币|¥)?\s*(\d+(?:[.,]\d{1,2})?)/i,
      /(?:月预算|预算)(?:改成|改为|设置为|设为|是|为|:)?\s*(?:€|eur|euro|euros|欧元?|美元?|\$|cny|rmb|人民币|¥)?\s*(\d+(?:[.,]\d{1,2})?)/i
    ]),
    savingsGoalName: extractSavingsGoalName(input),
    savingsGoalTargetAmount: extractProfileMoneyField(input, [
      /(?:savings goal target|saving goal target|goal target)\s*(?:is|to|:)?\s*(?:€|eur|euro|euros|欧元?|美元?|\$|cny|rmb|人民币|¥)?\s*(\d+(?:[.,]\d{1,2})?)/i,
      /(?:储蓄目标|存款目标|目标金额)(?:改成|改为|设置为|设为|是|为|:)?\s*(?:€|eur|euro|euros|欧元?|美元?|\$|cny|rmb|人民币|¥)?\s*(\d+(?:[.,]\d{1,2})?)/i
    ]),
    savingsGoalSavedAmount: extractProfileMoneyField(input, [
      /(?:saved amount|already saved|savings saved)\s*(?:is|to|:)?\s*(?:€|eur|euro|euros|欧元?|美元?|\$|cny|rmb|人民币|¥)?\s*(\d+(?:[.,]\d{1,2})?)/i,
      /(?:已存|已经存了|已储蓄|已攒)(?:金额)?(?:改成|改为|设置为|设为|是|为|:)?\s*(?:€|eur|euro|euros|欧元?|美元?|\$|cny|rmb|人民币|¥)?\s*(\d+(?:[.,]\d{1,2})?)/i
    ])
  };
}

function extractProfileName(input) {
  const patterns = [
    /(?:my name|name)\s*(?:is|to|:)\s*([^,.，。!?？]+)$/i,
    /(?:rename me to|call me)\s+([^,.，。!?？]+)$/i,
    /(?:名字|姓名)(?:改成|改为|设置为|设为|是|叫|为|:)\s*([^，。,.!?？]+)$/i,
    /(?:把我(?:的)?名字)(?:改成|改为|设置为|设为|叫)\s*([^，。,.!?？]+)$/i
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);

    if (match?.[1]) {
      return cleanupProfileText(match[1]);
    }
  }

  return null;
}

function extractProfileBaseCurrency(input) {
  if (!/(base currency|default currency|currency|默认货币|基础货币|币种|货币)/i.test(input)) {
    return null;
  }

  return extractCurrency(input);
}

function extractSavingsGoalName(input) {
  const patterns = [
    /(?:savings goal|saving goal|goal name)\s*(?:is|to|:)\s*([^,.，。!?？]+)$/i,
    /(?:储蓄目标|存款目标|攒钱目标)(?:名字)?(?:改成|改为|设置为|设为|是|为|:)\s*([^，。,.!?？]+)$/i
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);

    if (match?.[1] && !/\d/.test(match[1])) {
      return cleanupProfileText(match[1]);
    }
  }

  return null;
}

function extractProfileMoneyField(input, patterns) {
  for (const pattern of patterns) {
    const match = input.match(pattern);

    if (match?.[1]) {
      return Number.parseFloat(match[1].replace(",", "."));
    }
  }

  return null;
}

function cleanupProfileText(value) {
  return String(value || "")
    .replace(/^(to|为|成|叫)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeSummaryRequest(input) {
  return /(summary|summarize|统计|总结|汇总|花了多少|消费多少|支出多少|支出情况|消费情况|本月.*花|这个月.*花)/i.test(input);
}

function looksLikeOverviewRequest(input) {
  return /(overview|full summary|financial situation|current situation|整体|总览|全面|总结一下当前|当前.*情况|财务状况)/i.test(input);
}

function looksLikeDeleteRequest(input) {
  return /(delete|remove|cancel|删除|删掉|移除|取消).*(expense|spending|支出|消费|那笔|记录)|^(delete|remove|删除|删掉)/i.test(input);
}

function looksLikeWishlistRequest(input) {
  return /(wishlist|wish list|purchase plan|buying plan|want to buy|plan to buy|save for|愿望清单|心愿单|购买计划|计划买|想买|攒钱买)/i.test(input);
}

function looksLikeWishlistCreateRequest(input) {
  return /(\badd\b|\bcreate\b|\bplan\b|\bsave for\b|\bwant to buy\b|\bplan to buy\b|加入|添加|新增|计划买|想买|攒钱买)/i.test(input);
}

function looksLikeWishlistAmountQuestion(input) {
  return /(amount|total|cost|budget|how much|多少钱|金额|总额|预算)/i.test(input);
}

function looksLikeListRequest(input) {
  return /(\bshow\b|\bview\b|\blist\b|\bcheck\b|查看|看看|列出|显示)/i.test(input);
}

function looksLikeExpenseRequest(input) {
  return /(记录|记一笔|支出|花了|消费|买了|spent|expense|paid|cost|lunch|coffee|dinner|breakfast|午饭|午餐|晚饭|早餐|咖啡)/i.test(input);
}

function looksLikeEmailRequest(input) {
  return /(send|email|mail|发邮件|邮件|发送邮件|寄邮件)/i.test(input);
}

function looksLikeSendFinalAnswerEmailRequest(input) {
  const asksForEmail = looksLikeEmailRequest(input) || /(发到.*邮箱|发给我)/i.test(input);
  const explicitFinalAnswerEmailRequest =
    /(send|email|mail|发邮件|邮件|发送邮件|寄邮件|发到.*邮箱|发给我).*(answer|result|summary|final|report|答案|结果|总结|回复|内容)|把.*(answer|result|summary|final|report|答案|结果|总结|回复|内容).*(send|email|mail|发邮件|邮件|发送邮件|寄邮件|发给我|发到.*邮箱)/i.test(
      input
    );
  const asksForInformationThenEmail =
    asksForEmail &&
    (looksLikeSummaryRequest(input) ||
      looksLikeOverviewRequest(input) ||
      looksLikeRetailOfferRequest(input) ||
      looksLikeRetailLookupRequest(input) ||
      looksLikeLocalDealRequest(input));

  return explicitFinalAnswerEmailRequest || asksForInformationThenEmail;
}

function buildFinalAnswerEmailSubject(input) {
  if (/(discount|deal|offer|angebote|打折|折扣|优惠|促销)/i.test(input)) {
    return "Retail offers lookup result";
  }

  if (/(肉松|pork floss|rousong|商品|price|availability|价格|库存|有卖)/i.test(input)) {
    return "Retail product lookup result";
  }

  return "Financial App result";
}

function extractCategory(input) {
  if (/(午饭|午餐|晚饭|早餐|咖啡|餐|饭|food|lunch|dinner|breakfast|coffee|restaurant|grocery|groceries)/i.test(input)) {
    return "food";
  }

  if (/(交通|通勤|地铁|公交|火车|出租|uber|taxi|transport|transit|train|bus)/i.test(input)) {
    return "transport";
  }

  if (/(购物|衣服|鞋|shopping|clothes|clothing)/i.test(input)) {
    return "shopping";
  }

  if (/(账单|房租|水电|电费|bill|rent|utility)/i.test(input)) {
    return "bills";
  }

  if (/(电影|游戏|娱乐|movie|game|entertainment)/i.test(input)) {
    return "entertainment";
  }

  if (/(药|医院|医生|health|doctor|medicine)/i.test(input)) {
    return "health";
  }

  if (/(课程|书|education|course|book)/i.test(input)) {
    return "education";
  }

  if (/(旅行|酒店|机票|travel|hotel|flight)/i.test(input)) {
    return "travel";
  }

  return "other";
}

function extractSpecificCategory(input) {
  const category = extractCategory(input);
  return category === "other" ? null : category;
}

function extractNote(input, category) {
  const knownMerchant = extractKnownMerchantName(input);

  if (knownMerchant) {
    const productContext = extractPurchasedItemText(input) || extractLocalDealProductQuery(input);

    return [knownMerchant, productContext].filter(Boolean).join(" ").trim();
  }

  if (/(午饭|午餐|lunch)/i.test(input)) {
    return "lunch";
  }

  if (/(晚饭|dinner)/i.test(input)) {
    return "dinner";
  }

  if (/(早餐|breakfast)/i.test(input)) {
    return "breakfast";
  }

  if (/(咖啡|coffee)/i.test(input)) {
    return "coffee";
  }

  return category;
}

function extractPurchasedItemText(input) {
  const patterns = [
    /(?:买了|购买了|点了|吃了|消费了)\s*(.+?)(?:[。.!?？]|$)/i,
    /(?:bought|purchased|ordered|paid for)\s+(.+?)(?:[。.!?？]|$)/i
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);

    if (match?.[1]) {
      const cleaned = match[1]
        .replace(/\d+(?:[.,]\d{1,2})?\s*(?:块钱的?|块的?|元的?|欧元的?|欧的?|eur|euro|euros|€|cny|rmb|人民币|¥)?/gi, " ")
        .replace(/^(的|了)\s*/, "")
        .replace(/\s+/g, " ")
        .trim();

      return cleanupLocalDealText(cleaned) || null;
    }
  }

  return null;
}

function extractPriority(input) {
  if (/(high|urgent|important|高优先级|重要)/i.test(input)) {
    return "high";
  }

  if (/(low|not urgent|低优先级|不急)/i.test(input)) {
    return "low";
  }

  return "medium";
}

function extractWishlistItemName(input) {
  const normalized = input
    .replace(/\d+(?:[.,]\d{1,2})?/g, "")
    .replace(/(euros?|eur|€|欧元?|dollars?|usd|\$|美元|wishlist|wish list|purchase plan|buying plan|计划买|想买|愿望清单|心愿单|购买计划|帮我|add|create|with|budget|of|for|to my|a|an|the)/gi, " ")
    .trim();

  return normalized || "planned purchase";
}

function extractPeriod(input) {
  if (/(今天|today)/i.test(input)) {
    return "today";
  }

  if (/(本周|这周|current week|this week)/i.test(input)) {
    return "current_week";
  }

  if (/(所有|全部|all time|overall)/i.test(input)) {
    return "all_time";
  }

  return "current_month";
}
