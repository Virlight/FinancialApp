import { GoogleGenAI } from "@google/genai";
import { intentJsonSchema, normalizeIntent } from "./intentSchema.js";

const defaultModel = "gemini-2.5-flash";

export async function parseAssistantIntent(userText) {
  const input = String(userText || "").trim();
  const prompt = input ? buildPrompt(input) : null;

  if (!input) {
    const parsedIntent = normalizeIntent({
      intent: "unsupported",
      amount: null,
      currency: null,
      category: null,
      note: "Empty input",
      period: null,
      date: null,
      confidence: 1
    });

    return {
      provider: "mock",
      model: "local-rule-parser",
      parsedIntent,
      debug: buildDebugPayload({
        input,
        prompt,
        rawModelOutput: JSON.stringify(parsedIntent, null, 2),
        parserMode: "empty-input"
      })
    };
  }

  if (!process.env.GEMINI_API_KEY) {
    const parsedIntent = normalizeIntent(parseWithMockRules(input));

    return {
      provider: "mock",
      model: "local-rule-parser",
      parsedIntent,
      warning: "GEMINI_API_KEY is not set. Used local mock parser for demo verification.",
      debug: buildDebugPayload({
        input,
        prompt,
        rawModelOutput: JSON.stringify(parsedIntent, null, 2),
        parserMode: "mock-fallback"
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
      contents: prompt,
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: intentJsonSchema
      }
    });
    const parsedIntent = normalizeIntent(JSON.parse(response.text));

    return {
      provider: "gemini",
      model,
      parsedIntent,
      rawText: response.text,
      debug: buildDebugPayload({
        input,
        prompt,
        rawModelOutput: response.text,
        parserMode: "gemini"
      })
    };
  } catch (error) {
    const parsedIntent = normalizeIntent(parseWithMockRules(input));

    return {
      provider: "mock",
      model: "local-rule-parser",
      parsedIntent,
      warning: `Gemini parsing failed. Used local mock parser instead: ${error.message}`,
      debug: buildDebugPayload({
        input,
        prompt,
        rawModelOutput: JSON.stringify(parsedIntent, null, 2),
        parserMode: "gemini-error-fallback",
        error: error.message
      })
    };
  }
}

function buildDebugPayload({ input, prompt, rawModelOutput, parserMode, error = null }) {
  return {
    parserMode,
    input,
    promptSentToModel: prompt,
    modelOutputContract: {
      responseMimeType: "application/json",
      schema: intentJsonSchema
    },
    rawModelOutput,
    normalizedIntentNote:
      "The app validates and normalizes the raw model JSON before dispatching an internal function.",
    error
  };
}

function buildPrompt(input) {
  const today = new Date().toISOString().slice(0, 10);

  return `
You are an intent parser for a Financial App voice assistant MVP.
Return one JSON object that matches the provided schema. Do not include markdown.

Supported internal app actions:
1. create_expense
   Use this when the user asks to record spending.
   Required business fields: amount, currency.
   category must be one of: food, transport, shopping, bills, entertainment, health, education, travel, other.
   Examples:
   - "帮我记录一笔 12 欧的午饭支出" means amount 12, currency EUR, category food, note lunch.
   - "I spent 8 euros on coffee" means amount 8, currency EUR, category food, note coffee.

2. get_profile
   Use this when the user asks to see profile, account info, balance, budget, or financial profile.
   Examples: "查看我的 profile", "show my balance", "我的账户情况".

3. get_spending_summary
   Use this when the user asks for spending summary, total spending, category breakdown, or how much was spent.
   period should be today, current_week, current_month, or all_time. Default to current_month when unclear.
   If the user asks about a specific category, set category too.
   Examples:
   - "How much did I spend on transport this month?" means category transport, period current_month.
   - "我的本月交通花费是多少" means category transport, period current_month.

4. delete_expense
   Use this when the user asks to remove or delete an existing expense.
   Prefer expenseId if the user gives an id. Otherwise set selectors like amount, category, and note.
   Examples:
   - "delete the 12 euro lunch expense" means amount 12, currency EUR, category food, note lunch.
   - "删除咖啡那笔支出" means category food, note coffee.
   - "remove my latest transport expense" means category transport, note null.

5. create_wishlist_item
   Use this when the user asks to create a purchase plan, savings plan for an item, or wishlist item.
   itemName is required. targetAmount is the intended price or budget when present.
   priority should be low, medium, or high. Default to medium when unclear.
   Examples:
   - "Add a MacBook to my wishlist with a budget of 1200 euros" means itemName MacBook, targetAmount 1200, currency EUR.
   - "帮我计划买一台 800 欧的相机" means itemName camera, targetAmount 800, currency EUR.

6. get_wishlist
   Use this when the user asks to view, list, check, or calculate purchase plans or wishlist items.
   If the user asks for wishlist amount, wishlist total, purchase plan budget, or planned purchase cost, use this intent.
   Examples: "show my wishlist", "what's my wishlist amount?", "wishlist total", "查看我的购买计划".

7. get_financial_overview
   Use this when the user asks for an overall summary, current financial situation, or a broad recap.
   The app will combine balance, spending summary, category breakdown, latest expenses, and wishlist.
   Examples:
   - "Summarize my current financial situation"
   - "总结一下当前我的支出情况"
   - "Give me a full overview"

8. unsupported
   Use this for transfers, investments, payments, loans, or anything outside this MVP.

Rules:
- Current date is ${today}.
- Use EUR when user says euro, euros, €, 欧, or 欧元.
- Use USD when user says dollar, dollars, or $.
- Translate common Chinese finance phrases into the schema values.
- For irrelevant fields, output null.
- Always include all fields required by the schema, even when their value is null.
- confidence should be between 0 and 1.

User input:
${input}
`.trim();
}

function parseWithMockRules(input) {
  const lowerInput = input.toLowerCase();
  const amount = extractAmount(input);
  const currency = extractCurrency(input);

  if (
    looksLikeWishlistRequest(lowerInput) &&
    !looksLikeWishlistCreateRequest(lowerInput) &&
    (looksLikeListRequest(lowerInput) || looksLikeWishlistAmountQuestion(lowerInput))
  ) {
    return baseIntent({
      intent: "get_wishlist",
      note: "wishlist request",
      confidence: 0.76
    });
  }

  if (looksLikeOverviewRequest(lowerInput)) {
    return baseIntent({
      intent: "get_financial_overview",
      note: "financial overview request",
      period: extractPeriod(lowerInput),
      confidence: 0.8
    });
  }

  if (looksLikeWishlistRequest(lowerInput)) {
    const itemName = extractWishlistItemName(input);

    return baseIntent({
      intent: "create_wishlist_item",
      itemName,
      targetAmount: amount,
      currency: currency || (amount === null ? null : "EUR"),
      priority: extractPriority(lowerInput),
      note: "purchase plan",
      confidence: 0.7
    });
  }

  if (looksLikeDeleteRequest(lowerInput)) {
    const category = extractCategory(lowerInput);
    const note = extractNote(lowerInput, category);

    return baseIntent({
      intent: "delete_expense",
      amount,
      currency,
      category,
      note: note === "other" ? null : note,
      confidence: 0.68
    });
  }

  if (looksLikeProfileRequest(lowerInput)) {
    return baseIntent({
      intent: "get_profile",
      note: "profile request",
      confidence: 0.82
    });
  }

  if (looksLikeSummaryRequest(lowerInput)) {
    return baseIntent({
      intent: "get_spending_summary",
      note: "spending summary request",
      period: extractPeriod(lowerInput),
      category: extractSpecificCategory(lowerInput),
      confidence: 0.78
    });
  }

  if (amount !== null && looksLikeExpenseRequest(lowerInput)) {
    const category = extractCategory(lowerInput);
    const note = extractNote(lowerInput, category);

    return baseIntent({
      intent: "create_expense",
      amount,
      currency: currency || "EUR",
      category,
      note,
      confidence: 0.72
    });
  }

  return baseIntent({
    intent: "unsupported",
    note: "The mock parser could not map this request to an MVP action.",
    confidence: 0.65
  });
}

function baseIntent(overrides) {
  return {
    intent: "unsupported",
    amount: null,
    currency: null,
    category: null,
    note: null,
    period: null,
    date: null,
    expenseId: null,
    itemName: null,
    targetAmount: null,
    priority: null,
    dueDate: null,
    confidence: 0,
    ...overrides
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

  if (/(cny|rmb|人民币|元)/i.test(input)) {
    return "CNY";
  }

  return null;
}

function looksLikeProfileRequest(input) {
  return /(profile|profil|账户|账号|个人|余额|预算|资产|财务状况|account|balance|budget)/i.test(input);
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
