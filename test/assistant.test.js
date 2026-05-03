import assert from "node:assert/strict";
import test from "node:test";
import { executeAssistantIntent } from "../src/actions.js";
import { appState, resetAppState } from "../src/appState.js";
import { parseAssistantIntent } from "../src/assistantParser.js";

test("mock parser records a lunch expense through the app action dispatcher", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const startingBalance = appState.profile.currentBalance;
  const parsed = await parseAssistantIntent("帮我记录一笔 12 欧的午饭支出");
  const execution = executeAssistantIntent(parsed.parsedIntent);

  assert.equal(parsed.provider, "mock");
  assert.equal(parsed.parsedIntent.intent, "create_expense");
  assert.equal(parsed.parsedIntent.amount, 12);
  assert.equal(parsed.parsedIntent.currency, "EUR");
  assert.equal(parsed.parsedIntent.category, "food");
  assert.equal(execution.executedAction.functionName, "create_expense");
  assert.equal(execution.result.ok, true);
  assert.equal(appState.profile.currentBalance, startingBalance - 12);
});

test("mock parser maps profile request to get_profile", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantIntent("查看我的 profile");
  const execution = executeAssistantIntent(parsed.parsedIntent);

  assert.equal(parsed.parsedIntent.intent, "get_profile");
  assert.equal(execution.executedAction.functionName, "get_profile");
  assert.equal(execution.result.profile.name, "Alex Chen");
});

test("mock parser maps spending question to get_spending_summary", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantIntent("这个月我花了多少？");
  const execution = executeAssistantIntent(parsed.parsedIntent);

  assert.equal(parsed.parsedIntent.intent, "get_spending_summary");
  assert.equal(parsed.parsedIntent.period, "current_month");
  assert.equal(execution.executedAction.functionName, "get_spending_summary");
  assert.equal(execution.result.summary.currency, "EUR");
});

test("mock parser deletes a matching expense", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const createParsed = await parseAssistantIntent("Record a 12 euro lunch expense");
  executeAssistantIntent(createParsed.parsedIntent);

  const parsed = await parseAssistantIntent("Delete the 12 euro lunch expense");
  const execution = executeAssistantIntent(parsed.parsedIntent);

  assert.equal(parsed.parsedIntent.intent, "delete_expense");
  assert.equal(execution.executedAction.functionName, "delete_expense");
  assert.equal(execution.result.ok, true);
  assert.equal(appState.expenses.some((expense) => expense.note === "lunch"), false);
});

test("mock parser creates a wishlist item", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantIntent("Add a camera to my wishlist with a budget of 800 euros");
  const execution = executeAssistantIntent(parsed.parsedIntent);

  assert.equal(parsed.parsedIntent.intent, "create_wishlist_item");
  assert.equal(parsed.parsedIntent.targetAmount, 800);
  assert.equal(execution.executedAction.functionName, "create_wishlist_item");
  assert.equal(execution.result.ok, true);
  assert.equal(appState.wishlist[0].targetAmount, 800);
});

test("spending summary includes category-specific totals", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantIntent("我的本月交通花费是多少");
  const execution = executeAssistantIntent(parsed.parsedIntent);

  assert.equal(parsed.parsedIntent.intent, "get_spending_summary");
  assert.equal(parsed.parsedIntent.category, "transport");
  assert.equal(execution.executedAction.functionName, "get_spending_summary");
  assert.equal(execution.result.summary.requestedCategoryTotal, 49);
  assert.match(execution.result.message, /transport/);
});

test("overview summarizes multiple app data areas", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantIntent("总结一下当前我的支出情况");
  const execution = executeAssistantIntent(parsed.parsedIntent);

  assert.equal(parsed.parsedIntent.intent, "get_financial_overview");
  assert.equal(execution.executedAction.functionName, "get_financial_overview");
  assert.match(execution.result.message, /Category breakdown/);
  assert.match(execution.result.message, /Wishlist/);
  assert.match(execution.result.message, /Latest expenses/);
});

test("wishlist query returns item details and known total", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantIntent("What's my wishlist amount?");
  const execution = executeAssistantIntent(parsed.parsedIntent);

  assert.equal(parsed.parsedIntent.intent, "get_wishlist");
  assert.equal(execution.executedAction.functionName, "get_wishlist");
  assert.equal(execution.result.wishlistTotal, 180);
  assert.match(execution.result.message, /known total target/);
  assert.match(execution.result.message, /Noise-cancelling headphones/);
});
