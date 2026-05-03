import { appState, buildSpendingSummary, getAppSnapshot, roundMoney } from "./appState.js";
import { validateIntent } from "./intentSchema.js";

export function executeAssistantIntent(intent) {
  const validation = validateIntent(intent);

  if (!validation.ok) {
    return {
      executedAction: {
        functionName: "reject_intent",
        arguments: {
          errors: validation.errors
        }
      },
      result: {
        ok: false,
        message: "I could not execute this request because the parsed JSON is incomplete.",
        errors: validation.errors
      },
      state: getAppSnapshot()
    };
  }

  if (intent.intent === "create_expense") {
    return createExpense(intent);
  }

  if (intent.intent === "get_profile") {
    return getProfile();
  }

  if (intent.intent === "get_spending_summary") {
    return getSpendingSummary(intent);
  }

  return unsupported(intent);
}

function createExpense(intent) {
  const expense = {
    id: `exp_${Date.now()}`,
    amount: roundMoney(intent.amount),
    currency: intent.currency || appState.profile.baseCurrency,
    category: intent.category || "other",
    note: intent.note || "expense",
    date: intent.date || new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString()
  };

  appState.expenses.unshift(expense);

  if (expense.currency === appState.profile.baseCurrency) {
    appState.profile.currentBalance = roundMoney(appState.profile.currentBalance - expense.amount);
  }

  return {
    executedAction: {
      functionName: "create_expense",
      arguments: {
        amount: expense.amount,
        currency: expense.currency,
        category: expense.category,
        note: expense.note,
        date: expense.date
      }
    },
    result: {
      ok: true,
      message: `Recorded ${formatMoney(expense.amount, expense.currency)} for ${expense.note}.`,
      expense
    },
    state: getAppSnapshot()
  };
}

function getProfile() {
  const snapshot = getAppSnapshot();

  return {
    executedAction: {
      functionName: "get_profile",
      arguments: {}
    },
    result: {
      ok: true,
      message: `${snapshot.profile.name}'s balance is ${formatMoney(
        snapshot.profile.currentBalance,
        snapshot.profile.baseCurrency
      )}. Current month spending is ${formatMoney(
        snapshot.summary.total,
        snapshot.summary.currency
      )}.`,
      profile: snapshot.profile,
      summary: snapshot.summary
    },
    state: snapshot
  };
}

function getSpendingSummary(intent) {
  const period = intent.period || "current_month";
  const summary = buildSpendingSummary(appState.expenses, appState.profile.baseCurrency, period);

  return {
    executedAction: {
      functionName: "get_spending_summary",
      arguments: {
        period
      }
    },
    result: {
      ok: true,
      message: `Spending for ${period.replaceAll("_", " ")} is ${formatMoney(
        summary.total,
        summary.currency
      )}.`,
      summary
    },
    state: getAppSnapshot()
  };
}

function unsupported(intent) {
  return {
    executedAction: {
      functionName: "unsupported",
      arguments: {
        reason: intent.note || "The requested task is outside this MVP."
      }
    },
    result: {
      ok: false,
      message: "This MVP only supports recording expenses, viewing profile, and spending summaries."
    },
    state: getAppSnapshot()
  };
}

function formatMoney(amount, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency
  }).format(amount);
}
