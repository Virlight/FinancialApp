export const supportedIntents = [
  "create_expense",
  "delete_expense",
  "create_wishlist_item",
  "get_wishlist",
  "get_profile",
  "get_spending_summary",
  "get_financial_overview",
  "unsupported"
];

export const supportedCategories = [
  "food",
  "transport",
  "shopping",
  "bills",
  "entertainment",
  "health",
  "education",
  "travel",
  "other"
];

export const supportedCurrencies = ["EUR", "USD", "GBP", "CNY"];

export const supportedPeriods = [
  "today",
  "current_week",
  "current_month",
  "all_time"
];

export const supportedPriorities = ["low", "medium", "high"];

export const intentJsonSchema = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: supportedIntents,
      description: "The internal app action the user wants to perform."
    },
    amount: {
      type: ["number", "null"],
      description: "Expense amount. Required only for create_expense."
    },
    currency: {
      type: ["string", "null"],
      description: "ISO currency code, for example EUR. Use EUR if the user says euros."
    },
    category: {
      type: ["string", "null"],
      description: "Expense category. Use one of the supported finance categories."
    },
    note: {
      type: ["string", "null"],
      description: "Short user-facing note for the action, such as lunch. Also used as a delete selector when the user references an expense by description."
    },
    period: {
      type: ["string", "null"],
      description: "Summary period for get_spending_summary."
    },
    date: {
      type: ["string", "null"],
      description: "ISO date YYYY-MM-DD if the user mentions a date, otherwise null."
    },
    expenseId: {
      type: ["string", "null"],
      description: "Expense id to delete when the user explicitly references an id, otherwise null."
    },
    itemName: {
      type: ["string", "null"],
      description: "Wishlist or purchase plan item name."
    },
    targetAmount: {
      type: ["number", "null"],
      description: "Target price or budget for a wishlist item."
    },
    priority: {
      type: ["string", "null"],
      description: "Wishlist item priority: low, medium, or high."
    },
    dueDate: {
      type: ["string", "null"],
      description: "ISO date YYYY-MM-DD for a wishlist or purchase plan target date, otherwise null."
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Confidence that the parsed intent matches the user's request."
    }
  },
  required: [
    "intent",
    "amount",
    "currency",
    "category",
    "note",
    "period",
    "date",
    "expenseId",
    "itemName",
    "targetAmount",
    "priority",
    "dueDate",
    "confidence"
  ],
  additionalProperties: false
};

export function normalizeIntent(rawIntent) {
  const intent = rawIntent && typeof rawIntent === "object" ? rawIntent : {};
  const normalizedIntent = supportedIntents.includes(intent.intent)
    ? intent.intent
    : "unsupported";

  return {
    intent: normalizedIntent,
    amount:
      typeof intent.amount === "number" && Number.isFinite(intent.amount)
        ? intent.amount
        : null,
    currency: normalizeCurrency(intent.currency),
    category: normalizeCategory(intent.category),
    note: typeof intent.note === "string" && intent.note.trim() ? intent.note.trim() : null,
    period: normalizePeriod(intent.period),
    date: normalizeDate(intent.date),
    expenseId:
      typeof intent.expenseId === "string" && intent.expenseId.trim()
        ? intent.expenseId.trim()
        : null,
    itemName:
      typeof intent.itemName === "string" && intent.itemName.trim()
        ? intent.itemName.trim()
        : null,
    targetAmount:
      typeof intent.targetAmount === "number" && Number.isFinite(intent.targetAmount)
        ? intent.targetAmount
        : null,
    priority: normalizePriority(intent.priority),
    dueDate: normalizeDate(intent.dueDate),
    confidence:
      typeof intent.confidence === "number" && Number.isFinite(intent.confidence)
        ? Math.max(0, Math.min(1, intent.confidence))
        : 0
  };
}

export function validateIntent(intent) {
  const errors = [];

  if (!supportedIntents.includes(intent.intent)) {
    errors.push(`Unsupported intent: ${intent.intent}`);
  }

  if (intent.intent === "create_expense") {
    if (typeof intent.amount !== "number" || intent.amount <= 0) {
      errors.push("create_expense requires a positive amount.");
    }

    if (!intent.currency) {
      errors.push("create_expense requires a currency.");
    }
  }

  if (intent.intent === "delete_expense") {
    if (!intent.expenseId && !intent.note && !intent.category && !intent.amount) {
      errors.push("delete_expense requires an expense id or at least one selector.");
    }
  }

  if (intent.intent === "create_wishlist_item") {
    if (!intent.itemName) {
      errors.push("create_wishlist_item requires an item name.");
    }

    if (intent.targetAmount !== null && intent.targetAmount <= 0) {
      errors.push("create_wishlist_item targetAmount must be positive when provided.");
    }
  }

  if (intent.currency && !supportedCurrencies.includes(intent.currency)) {
    errors.push(`Unsupported currency: ${intent.currency}`);
  }

  if (intent.category && !supportedCategories.includes(intent.category)) {
    errors.push(`Unsupported category: ${intent.category}`);
  }

  if (intent.period && !supportedPeriods.includes(intent.period)) {
    errors.push(`Unsupported period: ${intent.period}`);
  }

  if (intent.priority && !supportedPriorities.includes(intent.priority)) {
    errors.push(`Unsupported priority: ${intent.priority}`);
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function normalizeCurrency(currency) {
  if (typeof currency !== "string" || !currency.trim()) {
    return null;
  }

  const upperCurrency = currency.trim().toUpperCase();
  const currencyAliases = {
    EURO: "EUR",
    EUROS: "EUR",
    EUR: "EUR",
    USD: "USD",
    DOLLAR: "USD",
    DOLLARS: "USD",
    GBP: "GBP",
    POUND: "GBP",
    POUNDS: "GBP",
    CNY: "CNY",
    RMB: "CNY"
  };

  return currencyAliases[upperCurrency] || upperCurrency;
}

function normalizeCategory(category) {
  if (typeof category !== "string" || !category.trim()) {
    return null;
  }

  const value = category.trim().toLowerCase();
  return supportedCategories.includes(value) ? value : "other";
}

function normalizePeriod(period) {
  if (typeof period !== "string" || !period.trim()) {
    return null;
  }

  const value = period.trim().toLowerCase();
  return supportedPeriods.includes(value) ? value : null;
}

function normalizeDate(date) {
  if (typeof date !== "string" || !date.trim()) {
    return null;
  }

  const value = date.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function normalizePriority(priority) {
  if (typeof priority !== "string" || !priority.trim()) {
    return null;
  }

  const value = priority.trim().toLowerCase();
  return supportedPriorities.includes(value) ? value : "medium";
}
