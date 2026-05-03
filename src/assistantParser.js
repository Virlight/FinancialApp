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

4. unsupported
   Use this for transfers, investments, payments, loans, or anything outside this MVP.

Rules:
- Current date is ${today}.
- Use EUR when user says euro, euros, €, 欧, or 欧元.
- Use USD when user says dollar, dollars, or $.
- Translate common Chinese finance phrases into the schema values.
- For irrelevant fields, output null.
- confidence should be between 0 and 1.

User input:
${input}
`.trim();
}

function parseWithMockRules(input) {
  const lowerInput = input.toLowerCase();
  const amount = extractAmount(input);
  const currency = extractCurrency(input);

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

function looksLikeExpenseRequest(input) {
  return /(记录|记一笔|支出|花了|消费|买了|spent|expense|paid|cost|lunch|coffee|dinner|breakfast|午饭|午餐|晚饭|早餐|咖啡)/i.test(input);
}

function extractCategory(input) {
  if (/(午饭|午餐|晚饭|早餐|咖啡|餐|饭|food|lunch|dinner|breakfast|coffee|restaurant|grocery|groceries)/i.test(input)) {
    return "food";
  }

  if (/(地铁|公交|火车|出租|uber|taxi|transport|transit|train|bus)/i.test(input)) {
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
