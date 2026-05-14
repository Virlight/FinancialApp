import { appState, buildSpendingSummary, getAppSnapshot, roundMoney } from "./appState.js";
import { sendEmail } from "./email.js";
import { normalizeFunctionCall, validateFunctionCall } from "./functionSchema.js";
import { lookupStoreProduct } from "./retailSearch.js";
import { lookupRetailOffers } from "./retailOffers/lookupRetailOffers.js";
import { lookupLocalDeals } from "./localDeals/lookupLocalDeals.js";

export async function executeAssistantFunctionCall(rawFunctionCall) {
  const functionCall = normalizeFunctionCall(rawFunctionCall);
  const validation = validateFunctionCall(functionCall);

  if (!validation.ok) {
    return {
      executedAction: {
        functionName: "reject_function_call",
        arguments: {
          functionName: functionCall.name,
          args: functionCall.args,
          errors: validation.errors
        }
      },
      result: {
        ok: false,
        message: "I could not execute this request because the function call is incomplete.",
        errors: validation.errors
      },
      state: getAppSnapshot()
    };
  }

  if (functionCall.name === "create_expense") {
    return createExpense(functionCall.args);
  }

  if (functionCall.name === "delete_expense") {
    return deleteExpense(functionCall.args);
  }

  if (functionCall.name === "create_wishlist_item") {
    return createWishlistItem(functionCall.args);
  }

  if (functionCall.name === "get_wishlist") {
    return getWishlist();
  }

  if (functionCall.name === "send_email") {
    return sendEmailAction(functionCall.args);
  }

  if (functionCall.name === "lookup_store_product") {
    return lookupStoreProductAction(functionCall.args);
  }

  if (functionCall.name === "lookup_retail_offers") {
    return lookupRetailOffersAction(functionCall.args);
  }

  if (functionCall.name === "lookup_local_deals") {
    return lookupLocalDealsAction(functionCall.args);
  }

  if (functionCall.name === "update_profile") {
    return updateProfile(functionCall.args);
  }

  if (functionCall.name === "get_profile") {
    return getProfile();
  }

  if (functionCall.name === "get_spending_summary") {
    return getSpendingSummary(functionCall.args);
  }

  if (functionCall.name === "get_financial_overview") {
    return getFinancialOverview(functionCall.args);
  }

  return unsupported(functionCall.args);
}

function createExpense(args) {
  const expense = {
    id: `exp_${Date.now()}`,
    amount: roundMoney(args.amount),
    currency: args.currency || appState.profile.baseCurrency,
    category: args.category || "other",
    note: args.note || "expense",
    date: args.date || new Date().toISOString().slice(0, 10),
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

function deleteExpense(args) {
  const expenseIndex = findExpenseIndex(args);

  if (expenseIndex === -1) {
    return {
      executedAction: {
        functionName: "delete_expense",
        arguments: buildDeleteExpenseArguments(args)
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
        ...buildDeleteExpenseArguments(args),
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

function createWishlistItem(args) {
  const item = {
    id: `wish_${Date.now()}`,
    itemName: args.itemName,
    targetAmount: args.targetAmount === undefined ? null : roundMoney(args.targetAmount),
    currency: args.currency || appState.profile.baseCurrency,
    priority: args.priority || "medium",
    dueDate: args.dueDate,
    note: args.note,
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

async function sendEmailAction(args) {
  const recipientEmails = args.recipientEmails?.length
    ? args.recipientEmails
    : [args.recipientEmail].filter(Boolean);
  const recipientLabel = formatRecipients(recipientEmails);
  const emailArguments = {
    recipientEmail: args.recipientEmail || recipientEmails[0],
    recipientEmails,
    emailSubject: args.emailSubject,
    emailBody: args.emailBody
  };

  try {
    const emailResult = await sendEmail({
      to: recipientEmails,
      subject: args.emailSubject,
      body: args.emailBody
    });
    const emailLogEntry = createEmailLogEntry(args, emailResult);

    appState.emailLog.unshift(emailLogEntry);

    return {
      executedAction: {
        functionName: "send_email",
        arguments: emailArguments
      },
      result: {
        ok: emailResult.ok,
        message: emailResult.ok
          ? emailResult.dryRun
            ? `Prepared email to ${recipientLabel}. Dry run is enabled, so no email was sent.`
            : `Sent email to ${recipientLabel}.`
          : emailResult.message,
        email: emailLogEntry,
        providerResult: emailResult
      },
      state: getAppSnapshot()
    };
  } catch (error) {
    const emailLogEntry = createEmailLogEntry(args, {
      ok: false,
      dryRun: false,
      provider: process.env.EMAIL_PROVIDER || "gmail",
      message: error.message
    });

    appState.emailLog.unshift(emailLogEntry);

    return {
      executedAction: {
        functionName: "send_email",
        arguments: emailArguments
      },
      result: {
        ok: false,
        message: `Email sending failed: ${error.message}`,
        email: emailLogEntry
      },
      state: getAppSnapshot()
    };
  }
}

async function lookupStoreProductAction(args) {
  const retailArguments = {
    productQuery: args.productQuery,
    retailers: args.retailers,
    location: args.location,
    lookupType: args.lookupType,
    date: args.date
  };

  try {
    const retailResult = await lookupStoreProduct(args);

    return {
      executedAction: {
        functionName: "lookup_store_product",
        arguments: retailArguments
      },
      result: {
        ok: retailResult.ok,
        message: retailResult.ok ? retailResult.answer : retailResult.message,
        retailSearch: retailResult,
        mapPlaces: retailResult.mapPlaces || []
      },
      state: getAppSnapshot()
    };
  } catch (error) {
    return {
      executedAction: {
        functionName: "lookup_store_product",
        arguments: retailArguments
      },
      result: {
        ok: false,
        message: `Retail product lookup failed: ${error.message}`,
        retailSearch: {
          ok: false,
          request: retailArguments,
          message: error.message
        }
      },
      state: getAppSnapshot()
    };
  }
}

async function lookupRetailOffersAction(args) {
  const offerArguments = {
    retailers: args.retailers,
    location: args.location,
    period: args.period,
    date: args.date
  };

  try {
    const offerResult = await lookupRetailOffers(args);

    return {
      executedAction: {
        functionName: "lookup_retail_offers",
        arguments: offerArguments
      },
      result: {
        ok: offerResult.ok,
        message: offerResult.ok ? offerResult.answer : offerResult.message,
        retailOffers: offerResult,
        mapPlaces: offerResult.mapPlaces || []
      },
      state: getAppSnapshot()
    };
  } catch (error) {
    return {
      executedAction: {
        functionName: "lookup_retail_offers",
        arguments: offerArguments
      },
      result: {
        ok: false,
        message: `Retail offers lookup failed: ${error.message}`,
        retailOffers: {
          ok: false,
          request: offerArguments,
          message: error.message
        }
      },
      state: getAppSnapshot()
    };
  }
}

async function lookupLocalDealsAction(args) {
  const localDealArguments = {
    merchantQuery: args.merchantQuery,
    productQuery: args.productQuery,
    category: args.category,
    location: args.location,
    period: args.period,
    date: args.date
  };

  try {
    const localDealResult = await lookupLocalDeals(args);

    return {
      executedAction: {
        functionName: "lookup_local_deals",
        arguments: localDealArguments
      },
      result: {
        ok: localDealResult.ok,
        message: localDealResult.ok ? localDealResult.answer : localDealResult.message,
        localDeals: localDealResult,
        mapPlaces: localDealResult.mapPlaces || []
      },
      state: getAppSnapshot()
    };
  } catch (error) {
    return {
      executedAction: {
        functionName: "lookup_local_deals",
        arguments: localDealArguments
      },
      result: {
        ok: false,
        message: `Local deal lookup failed: ${error.message}`,
        localDeals: {
          ok: false,
          request: localDealArguments,
          message: error.message
        }
      },
      state: getAppSnapshot()
    };
  }
}

function updateProfile(args) {
  const before = getAppSnapshot().profile;
  const changes = {};

  if (args.name !== undefined) {
    appState.profile.name = args.name;
    changes.name = {
      from: before.name,
      to: appState.profile.name
    };
  }

  if (args.baseCurrency !== undefined) {
    appState.profile.baseCurrency = args.baseCurrency;
    changes.baseCurrency = {
      from: before.baseCurrency,
      to: appState.profile.baseCurrency
    };
  }

  if (args.currentBalance !== undefined) {
    appState.profile.currentBalance = roundMoney(args.currentBalance);
    changes.currentBalance = {
      from: before.currentBalance,
      to: appState.profile.currentBalance
    };
  }

  if (args.monthlyIncome !== undefined) {
    appState.profile.monthlyIncome = roundMoney(args.monthlyIncome);
    changes.monthlyIncome = {
      from: before.monthlyIncome,
      to: appState.profile.monthlyIncome
    };
  }

  if (args.monthlyBudget !== undefined) {
    appState.profile.monthlyBudget = roundMoney(args.monthlyBudget);
    changes.monthlyBudget = {
      from: before.monthlyBudget,
      to: appState.profile.monthlyBudget
    };
  }

  if (args.savingsGoalName !== undefined) {
    appState.profile.savingsGoal.name = args.savingsGoalName;
    changes.savingsGoalName = {
      from: before.savingsGoal.name,
      to: appState.profile.savingsGoal.name
    };
  }

  if (args.savingsGoalTargetAmount !== undefined) {
    appState.profile.savingsGoal.targetAmount = roundMoney(args.savingsGoalTargetAmount);
    changes.savingsGoalTargetAmount = {
      from: before.savingsGoal.targetAmount,
      to: appState.profile.savingsGoal.targetAmount
    };
  }

  if (args.savingsGoalSavedAmount !== undefined) {
    appState.profile.savingsGoal.savedAmount = roundMoney(args.savingsGoalSavedAmount);
    changes.savingsGoalSavedAmount = {
      from: before.savingsGoal.savedAmount,
      to: appState.profile.savingsGoal.savedAmount
    };
  }

  const snapshot = getAppSnapshot();

  return {
    executedAction: {
      functionName: "update_profile",
      arguments: args
    },
    result: {
      ok: true,
      message: `Updated profile: ${formatProfileChanges(changes, snapshot.profile.baseCurrency)}`,
      profile: snapshot.profile,
      changes
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
      )}. Monthly income is ${formatMoney(
        snapshot.profile.monthlyIncome,
        snapshot.profile.baseCurrency
      )}. Monthly budget is ${formatMoney(
        snapshot.profile.monthlyBudget,
        snapshot.profile.baseCurrency
      )}. Current month spending is ${formatMoney(snapshot.summary.total, snapshot.summary.currency)}.`,
      profile: snapshot.profile,
      summary: snapshot.summary
    },
    state: snapshot
  };
}

function getSpendingSummary(args) {
  const period = args.period || "current_month";
  const summary = buildSpendingSummary(appState.expenses, appState.profile.baseCurrency, period);
  const categoryAmount = args.category ? summary.byCategory[args.category] || 0 : null;
  const budgetRemaining = roundMoney(appState.profile.monthlyBudget - summary.total);
  const message = args.category
    ? `You spent ${formatMoney(categoryAmount, summary.currency)} on ${args.category} in ${period.replaceAll("_", " ")}. Total spending for the same period is ${formatMoney(summary.total, summary.currency)}.`
    : `Spending for ${period.replaceAll("_", " ")} is ${formatMoney(summary.total, summary.currency)} across ${Object.keys(summary.byCategory).length} categories. ${formatCategoryBreakdown(summary)} Budget remaining this month is ${formatMoney(budgetRemaining, summary.currency)}. ${formatLatestExpenses(appState.expenses)}`;

  return {
    executedAction: {
      functionName: "get_spending_summary",
      arguments: {
        period,
        category: args.category
      }
    },
    result: {
      ok: true,
      message,
      summary: {
        ...summary,
        requestedCategory: args.category,
        requestedCategoryTotal: categoryAmount
      }
    },
    state: getAppSnapshot()
  };
}

function getFinancialOverview(args) {
  const period = args.period || "current_month";
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
        `Monthly income is ${formatMoney(snapshot.profile.monthlyIncome, snapshot.profile.baseCurrency)}.`,
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

function unsupported(args) {
  return {
    executedAction: {
      functionName: "unsupported",
      arguments: {
        reason: args.reason || "The requested task is outside this MVP."
      }
    },
    result: {
      ok: false,
      message:
        "This MVP supports expenses, deleting expenses, profile updates, spending summaries, wishlist planning, email, Munich retail product lookup, Munich retail offer lookup, and local merchant deal lookup."
    },
    state: getAppSnapshot()
  };
}

function formatProfileChanges(changes, currency) {
  const labels = {
    name: "name",
    baseCurrency: "base currency",
    currentBalance: "current balance",
    monthlyIncome: "monthly income",
    monthlyBudget: "monthly budget",
    savingsGoalName: "savings goal name",
    savingsGoalTargetAmount: "savings goal target",
    savingsGoalSavedAmount: "savings goal saved amount"
  };
  const moneyFields = new Set([
    "currentBalance",
    "monthlyIncome",
    "monthlyBudget",
    "savingsGoalTargetAmount",
    "savingsGoalSavedAmount"
  ]);
  const entries = Object.entries(changes);

  if (!entries.length) {
    return "no fields changed.";
  }

  return `${entries
    .map(([field, change]) => {
      const value = moneyFields.has(field) ? formatMoney(change.to, currency) : change.to;

      return `${labels[field] || field} to ${value}`;
    })
    .join(", ")}.`;
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

function findExpenseIndex(args) {
  if (args.expenseId) {
    return appState.expenses.findIndex((expense) => expense.id === args.expenseId);
  }

  return appState.expenses.findIndex((expense) => {
    if (args.amount !== undefined && roundMoney(expense.amount) !== roundMoney(args.amount)) {
      return false;
    }

    if (args.category && expense.category !== args.category) {
      return false;
    }

    if (args.note && !expense.note.toLowerCase().includes(args.note.toLowerCase())) {
      return false;
    }

    return true;
  });
}

function buildDeleteExpenseArguments(args) {
  return {
    expenseId: args.expenseId,
    amount: args.amount,
    currency: args.currency,
    category: args.category,
    note: args.note
  };
}

function createEmailLogEntry(args, emailResult) {
  const recipientEmails = args.recipientEmails?.length
    ? args.recipientEmails
    : [args.recipientEmail].filter(Boolean);

  return {
    id: `email_${Date.now()}`,
    to: formatRecipients(recipientEmails),
    recipients: recipientEmails,
    subject: args.emailSubject,
    body: args.emailBody,
    status: emailResult.ok ? (emailResult.dryRun ? "dry_run" : "sent") : "failed",
    provider: emailResult.provider || "gmail",
    messageId: emailResult.messageId || null,
    error: emailResult.ok ? null : emailResult.message,
    createdAt: new Date().toISOString()
  };
}

function formatRecipients(recipients) {
  return (recipients || []).filter(Boolean).join(", ");
}
