import {
  normalizeRetailLookupType,
  normalizeRetailerIdsForProduct,
  supportedRetailLookupTypes,
  supportedRetailerIds
} from "./retailerConfig.js";

export const supportedFunctionNames = [
  "create_expense",
  "delete_expense",
  "create_wishlist_item",
  "get_wishlist",
  "send_email",
  "lookup_store_product",
  "lookup_retail_offers",
  "lookup_local_deals",
  "update_profile",
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

export const supportedPeriods = ["today", "current_week", "current_month", "all_time"];

export const supportedPriorities = ["low", "medium", "high"];

export function normalizeFunctionCall(rawFunctionCall) {
  const source = rawFunctionCall && typeof rawFunctionCall === "object" ? rawFunctionCall : {};
  const name = supportedFunctionNames.includes(source.name) ? source.name : "unsupported";
  const args = source.args && typeof source.args === "object" ? source.args : {};

  return {
    name,
    args: normalizeFunctionArgs(name, args)
  };
}

export function validateFunctionCall(functionCall) {
  const errors = [];
  const { name, args } = normalizeFunctionCall(functionCall);

  if (!supportedFunctionNames.includes(name)) {
    errors.push(`Unsupported function: ${name}`);
  }

  if (name === "create_expense") {
    if (typeof args.amount !== "number" || args.amount <= 0) {
      errors.push("create_expense requires a positive amount.");
    }

    if (!args.currency) {
      errors.push("create_expense requires a currency.");
    }
  }

  if (name === "delete_expense") {
    if (!args.expenseId && !args.note && !args.category && !args.amount) {
      errors.push("delete_expense requires an expense id or at least one selector.");
    }
  }

  if (name === "create_wishlist_item") {
    if (!args.itemName) {
      errors.push("create_wishlist_item requires an item name.");
    }

    if (args.targetAmount !== undefined && args.targetAmount !== null && args.targetAmount <= 0) {
      errors.push("create_wishlist_item targetAmount must be positive when provided.");
    }
  }

  if (name === "send_email") {
    if (!args.recipientEmails?.length && !args.recipientEmail) {
      errors.push("send_email requires at least one recipient email.");
    }

    if (!args.emailSubject) {
      errors.push("send_email requires an emailSubject.");
    }

    if (!args.emailBody) {
      errors.push("send_email requires an emailBody.");
    }
  }

  if (name === "lookup_store_product") {
    if (!args.productQuery) {
      errors.push("lookup_store_product requires a productQuery.");
    }
  }

  if (name === "lookup_retail_offers") {
    if (!args.retailers?.length) {
      errors.push("lookup_retail_offers requires retailers.");
    }
  }

  if (name === "lookup_local_deals") {
    if (!args.merchantQuery) {
      errors.push("lookup_local_deals requires a merchantQuery.");
    }
  }

  if (name === "update_profile") {
    const profileFields = [
      "name",
      "baseCurrency",
      "currentBalance",
      "monthlyIncome",
      "monthlyBudget",
      "savingsGoalName",
      "savingsGoalTargetAmount",
      "savingsGoalSavedAmount"
    ];

    if (!profileFields.some((field) => args[field] !== undefined)) {
      errors.push("update_profile requires at least one profile field.");
    }

    for (const field of [
      "monthlyIncome",
      "monthlyBudget",
      "savingsGoalTargetAmount",
      "savingsGoalSavedAmount"
    ]) {
      if (args[field] !== undefined && args[field] < 0) {
        errors.push(`${field} must be zero or positive.`);
      }
    }
  }

  if (args.currency && !supportedCurrencies.includes(args.currency)) {
    errors.push(`Unsupported currency: ${args.currency}`);
  }

  if (args.baseCurrency && !supportedCurrencies.includes(args.baseCurrency)) {
    errors.push(`Unsupported baseCurrency: ${args.baseCurrency}`);
  }

  if (args.category && !supportedCategories.includes(args.category)) {
    errors.push(`Unsupported category: ${args.category}`);
  }

  if (args.period && !supportedPeriods.includes(args.period)) {
    errors.push(`Unsupported period: ${args.period}`);
  }

  if (args.priority && !supportedPriorities.includes(args.priority)) {
    errors.push(`Unsupported priority: ${args.priority}`);
  }

  if (args.lookupType && !supportedRetailLookupTypes.includes(args.lookupType)) {
    errors.push(`Unsupported retail lookup type: ${args.lookupType}`);
  }

  if (args.retailers?.some((retailer) => !supportedRetailerIds.includes(retailer))) {
    errors.push(`Unsupported retailer: ${args.retailers.join(", ")}`);
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function normalizeFunctionArgs(name, args) {
  if (name === "create_expense") {
    return compactObject({
      amount: normalizeNumber(args.amount),
      currency: normalizeCurrency(args.currency),
      category: normalizeCategory(args.category),
      note: normalizeText(args.note),
      date: normalizeDate(args.date)
    });
  }

  if (name === "delete_expense") {
    return compactObject({
      expenseId: normalizeText(args.expenseId),
      amount: normalizeNumber(args.amount),
      currency: normalizeCurrency(args.currency),
      category: normalizeCategory(args.category),
      note: normalizeText(args.note)
    });
  }

  if (name === "create_wishlist_item") {
    return compactObject({
      itemName: normalizeText(args.itemName),
      targetAmount: normalizeNumber(args.targetAmount),
      currency: normalizeCurrency(args.currency),
      priority: normalizePriority(args.priority),
      dueDate: normalizeDate(args.dueDate),
      note: normalizeText(args.note)
    });
  }

  if (name === "send_email") {
    const recipientEmails = normalizeEmailAddresses([
      args.recipientEmails,
      args.recipients,
      args.to,
      args.recipientEmail
    ]);

    return compactObject({
      recipientEmail: recipientEmails[0] || null,
      recipientEmails,
      emailSubject: normalizeText(args.emailSubject),
      emailBody: normalizeText(args.emailBody)
    });
  }

  if (name === "lookup_store_product") {
    const productQuery = normalizeText(args.productQuery);

    return compactObject({
      productQuery,
      retailers: normalizeRetailerIdsForProduct(args.retailers || args.retailer, productQuery),
      location: normalizeText(args.location) || "Munich, Germany",
      lookupType: normalizeRetailLookupType(args.lookupType),
      date: normalizeDate(args.date)
    });
  }

  if (name === "lookup_retail_offers") {
    return compactObject({
      retailers: normalizeRetailerIdsForProduct(args.retailers || args.retailer, ""),
      location: normalizeText(args.location) || "Munich, Germany",
      period: normalizePeriod(args.period) || "current_week",
      date: normalizeDate(args.date)
    });
  }

  if (name === "lookup_local_deals") {
    return compactObject({
      merchantQuery: normalizeText(args.merchantQuery || args.merchant || args.storeName),
      productQuery: normalizeText(args.productQuery || args.itemName),
      category: normalizeCategory(args.category) || "food",
      location: normalizeText(args.location) || "Munich, Germany",
      period: normalizePeriod(args.period) || "current_week",
      date: normalizeDate(args.date)
    });
  }

  if (name === "update_profile") {
    return compactObject({
      name: normalizeText(args.name),
      baseCurrency: normalizeCurrency(args.baseCurrency),
      currentBalance: normalizeNumber(args.currentBalance),
      monthlyIncome: normalizeNumber(args.monthlyIncome),
      monthlyBudget: normalizeNumber(args.monthlyBudget),
      savingsGoalName: normalizeText(args.savingsGoalName),
      savingsGoalTargetAmount: normalizeNumber(args.savingsGoalTargetAmount),
      savingsGoalSavedAmount: normalizeNumber(args.savingsGoalSavedAmount)
    });
  }

  if (name === "get_spending_summary") {
    return compactObject({
      period: normalizePeriod(args.period) || "current_month",
      category: normalizeCategory(args.category)
    });
  }

  if (name === "get_financial_overview") {
    return {
      period: normalizePeriod(args.period) || "current_month"
    };
  }

  if (name === "unsupported") {
    return {
      reason: normalizeText(args.reason) || normalizeText(args.note) || "The requested task is outside this MVP."
    };
  }

  return {};
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== null && entryValue !== undefined)
  );
}

function normalizeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeCurrency(currency) {
  const value = normalizeText(currency);

  if (!value) {
    return null;
  }

  const upperCurrency = value.toUpperCase();
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
  const value = normalizeText(category);

  if (!value) {
    return null;
  }

  const lowerCategory = value.toLowerCase();
  return supportedCategories.includes(lowerCategory) ? lowerCategory : "other";
}

function normalizePeriod(period) {
  const value = normalizeText(period);

  if (!value) {
    return null;
  }

  const lowerPeriod = value.toLowerCase();
  return supportedPeriods.includes(lowerPeriod) ? lowerPeriod : null;
}

function normalizeDate(date) {
  const value = normalizeText(date);

  if (!value) {
    return null;
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function normalizePriority(priority) {
  const value = normalizeText(priority);

  if (!value) {
    return null;
  }

  const lowerPriority = value.toLowerCase();
  return supportedPriorities.includes(lowerPriority) ? lowerPriority : "medium";
}

function normalizeEmailAddress(emailAddress) {
  const value = normalizeText(emailAddress);

  if (!value) {
    return null;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

function normalizeEmailAddresses(value) {
  const rawValues = (Array.isArray(value) ? value.flat(Infinity) : [value]).flatMap((entry) =>
    typeof entry === "string" ? entry.split(/[,\s;]+/) : []
  );
  const seen = new Set();
  const emailAddresses = [];

  for (const rawValue of rawValues) {
    const emailAddress = normalizeEmailAddress(rawValue);
    const key = emailAddress?.toLowerCase();

    if (emailAddress && !seen.has(key)) {
      seen.add(key);
      emailAddresses.push(emailAddress);
    }
  }

  return emailAddresses;
}
