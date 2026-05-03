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
