export function createInitialState() {
  return {
    profile: {
      id: "user_demo_001",
      name: "Alex Chen",
      baseCurrency: "EUR",
      currentBalance: 1842.5,
      monthlyBudget: 1450,
      savingsGoal: {
        name: "Emergency fund",
        targetAmount: 5000,
        savedAmount: 2350
      }
    },
    expenses: [
      {
        id: "exp_seed_001",
        amount: 18.5,
        currency: "EUR",
        category: "food",
        note: "groceries",
        date: "2026-05-01",
        createdAt: "2026-05-01T18:30:00.000Z"
      },
      {
        id: "exp_seed_002",
        amount: 49,
        currency: "EUR",
        category: "transport",
        note: "monthly transit pass",
        date: "2026-05-02",
        createdAt: "2026-05-02T09:05:00.000Z"
      }
    ],
    wishlist: [
      {
        id: "wish_seed_001",
        itemName: "Noise-cancelling headphones",
        targetAmount: 180,
        currency: "EUR",
        priority: "medium",
        dueDate: null,
        note: "Compare prices before buying",
        status: "planned",
        createdAt: "2026-05-01T10:00:00.000Z"
      }
    ]
  };
}

export const appState = createInitialState();

export function resetAppState() {
  const initialState = createInitialState();
  appState.profile = initialState.profile;
  appState.expenses = initialState.expenses;
  appState.wishlist = initialState.wishlist;
  return getAppSnapshot();
}

export function getAppSnapshot() {
  return {
    profile: structuredClone(appState.profile),
    expenses: structuredClone(appState.expenses),
    wishlist: structuredClone(appState.wishlist),
    summary: buildSpendingSummary(appState.expenses, appState.profile.baseCurrency)
  };
}

export function buildSpendingSummary(expenses, baseCurrency, period = "current_month") {
  const filteredExpenses = filterExpensesByPeriod(expenses, period);
  const byCategory = {};
  let total = 0;

  for (const expense of filteredExpenses) {
    if (expense.currency !== baseCurrency) {
      continue;
    }

    total += expense.amount;
    byCategory[expense.category] = (byCategory[expense.category] || 0) + expense.amount;
  }

  return {
    period,
    currency: baseCurrency,
    total: roundMoney(total),
    count: filteredExpenses.length,
    byCategory: Object.fromEntries(
      Object.entries(byCategory)
        .sort(([, a], [, b]) => b - a)
        .map(([category, amount]) => [category, roundMoney(amount)])
    )
  };
}

export function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function filterExpensesByPeriod(expenses, period) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();
  const currentDay = today.toISOString().slice(0, 10);

  if (period === "all_time") {
    return expenses;
  }

  if (period === "today") {
    return expenses.filter((expense) => expense.date === currentDay);
  }

  if (period === "current_week") {
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay() + 1);
    weekStart.setHours(0, 0, 0, 0);

    return expenses.filter((expense) => {
      const expenseDate = new Date(`${expense.date}T00:00:00`);
      return expenseDate >= weekStart && expenseDate <= today;
    });
  }

  return expenses.filter((expense) => {
    const expenseDate = new Date(`${expense.date}T00:00:00`);
    return expenseDate.getFullYear() === currentYear && expenseDate.getMonth() === currentMonth;
  });
}
