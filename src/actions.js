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

  if (intent.intent === "delete_expense") {
    return deleteExpense(intent);
  }

  if (intent.intent === "create_wishlist_item") {
    return createWishlistItem(intent);
  }

  if (intent.intent === "get_wishlist") {
    return getWishlist();
  }

  if (intent.intent === "get_profile") {
    return getProfile();
  }

  if (intent.intent === "get_spending_summary") {
    return getSpendingSummary(intent);
  }

  if (intent.intent === "get_financial_overview") {
    return getFinancialOverview(intent);
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

function deleteExpense(intent) {
  const expenseIndex = findExpenseIndex(intent);

  if (expenseIndex === -1) {
    return {
      executedAction: {
        functionName: "delete_expense",
        arguments: buildDeleteExpenseArguments(intent)
      },
      result: {
        ok: false,
        message: "I could not find a matching expense to delete."
      },
      state: getAppSnapshot()
    };
  }

  const [deletedExpense] = appState.expenses.splice(expenseIndex, 1);

  if (deletedExpense.currency === appState.profile.baseCurrency) {
    appState.profile.currentBalance = roundMoney(
      appState.profile.currentBalance + deletedExpense.amount
    );
  }

  return {
    executedAction: {
      functionName: "delete_expense",
      arguments: {
        ...buildDeleteExpenseArguments(intent),
        deletedExpenseId: deletedExpense.id
      }
    },
    result: {
      ok: true,
      message: `Deleted ${formatMoney(deletedExpense.amount, deletedExpense.currency)} for ${deletedExpense.note}.`,
      expense: deletedExpense
    },
    state: getAppSnapshot()
  };
}

function createWishlistItem(intent) {
  const item = {
    id: `wish_${Date.now()}`,
    itemName: intent.itemName,
    targetAmount: intent.targetAmount === null ? null : roundMoney(intent.targetAmount),
    currency: intent.currency || appState.profile.baseCurrency,
    priority: intent.priority || "medium",
    dueDate: intent.dueDate,
    note: intent.note,
    status: "planned",
    createdAt: new Date().toISOString()
  };

  appState.wishlist.unshift(item);

  return {
    executedAction: {
      functionName: "create_wishlist_item",
      arguments: {
        itemName: item.itemName,
        targetAmount: item.targetAmount,
        currency: item.currency,
        priority: item.priority,
        dueDate: item.dueDate,
        note: item.note
      }
    },
    result: {
      ok: true,
      message: `Added ${item.itemName} to the wishlist${item.targetAmount ? ` with a target of ${formatMoney(item.targetAmount, item.currency)}` : ""}.`,
      item
    },
    state: getAppSnapshot()
  };
}

function getWishlist() {
  const snapshot = getAppSnapshot();
  const wishlistTotal = snapshot.wishlist.reduce(
    (sum, item) =>
      item.currency === snapshot.profile.baseCurrency && item.targetAmount
        ? sum + item.targetAmount
        : sum,
    0
  );
  const topItems = snapshot.wishlist.slice(0, 5);

  return {
    executedAction: {
      functionName: "get_wishlist",
      arguments: {}
    },
    result: {
      ok: true,
      message:
        snapshot.wishlist.length === 0
          ? "Your wishlist is empty."
          : `Your wishlist has ${snapshot.wishlist.length} planned item${snapshot.wishlist.length === 1 ? "" : "s"} with a known total target of ${formatMoney(roundMoney(wishlistTotal), snapshot.profile.baseCurrency)}. ${formatWishlistDetails(topItems)}`,
      wishlist: snapshot.wishlist,
      wishlistTotal: roundMoney(wishlistTotal),
      displayedItems: topItems
    },
    state: snapshot
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
  const categoryAmount = intent.category ? summary.byCategory[intent.category] || 0 : null;
  const budgetRemaining = roundMoney(appState.profile.monthlyBudget - summary.total);
  const message = intent.category
    ? `You spent ${formatMoney(categoryAmount, summary.currency)} on ${intent.category} in ${period.replaceAll("_", " ")}. Total spending for the same period is ${formatMoney(summary.total, summary.currency)}.`
    : `Spending for ${period.replaceAll("_", " ")} is ${formatMoney(summary.total, summary.currency)} across ${Object.keys(summary.byCategory).length} categories. ${formatCategoryBreakdown(summary)} Budget remaining this month is ${formatMoney(budgetRemaining, summary.currency)}. ${formatLatestExpenses(appState.expenses)}`;

  return {
    executedAction: {
      functionName: "get_spending_summary",
      arguments: {
        period,
        category: intent.category
      }
    },
    result: {
      ok: true,
      message,
      summary: {
        ...summary,
        requestedCategory: intent.category,
        requestedCategoryTotal: categoryAmount
      }
    },
    state: getAppSnapshot()
  };
}

function getFinancialOverview(intent) {
  const period = intent.period || "current_month";
  const snapshot = getAppSnapshot();
  const summary = buildSpendingSummary(appState.expenses, appState.profile.baseCurrency, period);
  const budgetRemaining = roundMoney(snapshot.profile.monthlyBudget - summary.total);

  return {
    executedAction: {
      functionName: "get_financial_overview",
      arguments: {
        period
      }
    },
    result: {
      ok: true,
      message: [
        `Here is your ${period.replaceAll("_", " ")} overview.`,
        `Your balance is ${formatMoney(snapshot.profile.currentBalance, snapshot.profile.baseCurrency)}.`,
        `Spending is ${formatMoney(summary.total, summary.currency)} across ${summary.count} expenses.`,
        formatCategoryBreakdown(summary),
        `Budget remaining this month is ${formatMoney(budgetRemaining, summary.currency)}.`,
        formatLatestExpenses(snapshot.expenses),
        formatWishlistSummary(snapshot.wishlist)
      ]
        .filter(Boolean)
        .join(" "),
      profile: snapshot.profile,
      summary,
      wishlist: snapshot.wishlist
    },
    state: snapshot
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
      message:
        "This MVP supports expenses, deleting expenses, profile, spending summaries, and wishlist planning."
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

function formatCategoryBreakdown(summary) {
  const entries = Object.entries(summary.byCategory);

  if (entries.length === 0) {
    return "There is no category spending yet.";
  }

  return `Category breakdown: ${entries
    .map(([category, amount]) => `${category} ${formatMoney(amount, summary.currency)}`)
    .join(", ")}.`;
}

function formatLatestExpenses(expenses) {
  if (expenses.length === 0) {
    return "There are no recent expenses.";
  }

  return `Latest expenses: ${expenses
    .slice(0, 3)
    .map((expense) => `${expense.note} ${formatMoney(expense.amount, expense.currency)}`)
    .join(", ")}.`;
}

function formatWishlistSummary(wishlist) {
  if (wishlist.length === 0) {
    return "Your wishlist is empty.";
  }

  return `Wishlist: ${wishlist
    .slice(0, 3)
    .map((item) =>
      item.targetAmount
        ? `${item.itemName} ${formatMoney(item.targetAmount, item.currency)}`
        : item.itemName
    )
    .join(", ")}.`;
}

function formatWishlistDetails(wishlist) {
  if (wishlist.length === 0) {
    return "";
  }

  return `Top items: ${wishlist
    .map((item) => {
      const amount = item.targetAmount
        ? formatMoney(item.targetAmount, item.currency)
        : "no target amount";
      return `${item.itemName} (${amount}, ${item.priority} priority)`;
    })
    .join("; ")}.`;
}

function findExpenseIndex(intent) {
  if (intent.expenseId) {
    return appState.expenses.findIndex((expense) => expense.id === intent.expenseId);
  }

  return appState.expenses.findIndex((expense) => {
    if (intent.amount !== null && roundMoney(expense.amount) !== roundMoney(intent.amount)) {
      return false;
    }

    if (intent.category && expense.category !== intent.category) {
      return false;
    }

    if (intent.note && !expense.note.toLowerCase().includes(intent.note.toLowerCase())) {
      return false;
    }

    return true;
  });
}

function buildDeleteExpenseArguments(intent) {
  return {
    expenseId: intent.expenseId,
    amount: intent.amount,
    currency: intent.currency,
    category: intent.category,
    note: intent.note
  };
}
