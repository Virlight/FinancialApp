import assert from "node:assert/strict";
import test from "node:test";
import { executeAssistantFunctionCall } from "../src/actions.js";
import { appState, resetAppState } from "../src/appState.js";
import { parseAssistantFunctionCall, parsePostResponseFunctionCall } from "../src/assistantParser.js";
import { composeFinalAssistantResponse, composePostActionFinalResponse } from "../src/finalResponse.js";
import { lookupLocalDeals } from "../src/localDeals/lookupLocalDeals.js";
import { renderAssistantMessage } from "../public/assistantMarkdown.js";
import { discoverRetailerPlaces } from "../src/retail/placesDiscovery.js";
import {
  buildEdekaSearchTerms,
  buildAsianGrocerySearchTerms,
  buildMediaSaturnSearchTerms,
  getProvidersForRetailer,
  lookupOfficialRetailProduct
} from "../src/officialRetailSearch.js";
import { buildMapPlacesFromChannels } from "../src/retail/utils/mapPlaces.js";

test("mock parser records a lunch expense through the app action dispatcher", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const startingBalance = appState.profile.currentBalance;
  const parsed = await parseAssistantFunctionCall("帮我记录一笔 12 欧的午饭支出");
  const execution = await executeAssistantFunctionCall(parsed.functionCall);

  assert.equal(parsed.provider, "mock");
  assert.equal(parsed.functionCall.name, "create_expense");
  assert.equal(parsed.functionCall.args.amount, 12);
  assert.equal(parsed.functionCall.args.currency, "EUR");
  assert.equal(parsed.functionCall.args.category, "food");
  assert.equal(execution.executedAction.functionName, "create_expense");
  assert.equal(execution.result.ok, true);
  assert.equal(appState.profile.currentBalance, startingBalance - 12);
});

test("mock parser maps profile request to get_profile", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("查看我的 profile");
  const execution = await executeAssistantFunctionCall(parsed.functionCall);

  assert.equal(parsed.functionCall.name, "get_profile");
  assert.equal(execution.executedAction.functionName, "get_profile");
  assert.equal(execution.result.profile.name, "Alex Chen");
});

test("mock parser updates profile name and monthly income", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const nameParsed = await parseAssistantFunctionCall("把我的名字改成 Haoliang Huang");
  const nameExecution = await executeAssistantFunctionCall(nameParsed.functionCall);

  assert.equal(nameParsed.functionCall.name, "update_profile");
  assert.equal(nameParsed.functionCall.args.name, "Haoliang Huang");
  assert.equal(nameExecution.executedAction.functionName, "update_profile");
  assert.equal(nameExecution.result.profile.name, "Haoliang Huang");

  const incomeParsed = await parseAssistantFunctionCall("我的月收入设置为 4200 欧元");
  const incomeExecution = await executeAssistantFunctionCall(incomeParsed.functionCall);

  assert.equal(incomeParsed.functionCall.name, "update_profile");
  assert.equal(incomeParsed.functionCall.args.monthlyIncome, 4200);
  assert.equal(incomeExecution.result.profile.monthlyIncome, 4200);
});

test("mock parser maps spending question to get_spending_summary", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("这个月我花了多少？");
  const execution = await executeAssistantFunctionCall(parsed.functionCall);

  assert.equal(parsed.functionCall.name, "get_spending_summary");
  assert.equal(parsed.functionCall.args.period, "current_month");
  assert.equal(execution.executedAction.functionName, "get_spending_summary");
  assert.equal(execution.result.summary.currency, "EUR");
});

test("mock parser deletes a matching expense", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const createParsed = await parseAssistantFunctionCall("Record a 12 euro lunch expense");
  await executeAssistantFunctionCall(createParsed.functionCall);

  const parsed = await parseAssistantFunctionCall("Delete the 12 euro lunch expense");
  const execution = await executeAssistantFunctionCall(parsed.functionCall);

  assert.equal(parsed.functionCall.name, "delete_expense");
  assert.equal(execution.executedAction.functionName, "delete_expense");
  assert.equal(execution.result.ok, true);
  assert.equal(appState.expenses.some((expense) => expense.note === "lunch"), false);
});

test("mock parser creates a wishlist item", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("Add a camera to my wishlist with a budget of 800 euros");
  const execution = await executeAssistantFunctionCall(parsed.functionCall);

  assert.equal(parsed.functionCall.name, "create_wishlist_item");
  assert.equal(parsed.functionCall.args.targetAmount, 800);
  assert.equal(execution.executedAction.functionName, "create_wishlist_item");
  assert.equal(execution.result.ok, true);
  assert.equal(appState.wishlist[0].targetAmount, 800);
});

test("spending summary includes category-specific totals", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("我的本月交通花费是多少");
  const execution = await executeAssistantFunctionCall(parsed.functionCall);

  assert.equal(parsed.functionCall.name, "get_spending_summary");
  assert.equal(parsed.functionCall.args.category, "transport");
  assert.equal(execution.executedAction.functionName, "get_spending_summary");
  assert.equal(execution.result.summary.requestedCategoryTotal, 49);
  assert.match(execution.result.message, /transport/);
});

test("overview summarizes multiple app data areas", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("总结一下当前我的支出情况");
  const execution = await executeAssistantFunctionCall(parsed.functionCall);

  assert.equal(parsed.functionCall.name, "get_financial_overview");
  assert.equal(execution.executedAction.functionName, "get_financial_overview");
  assert.match(execution.result.message, /Category breakdown/);
  assert.match(execution.result.message, /Wishlist/);
  assert.match(execution.result.message, /Latest expenses/);
});

test("wishlist query returns item details and known total", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("What's my wishlist amount?");
  const execution = await executeAssistantFunctionCall(parsed.functionCall);

  assert.equal(parsed.functionCall.name, "get_wishlist");
  assert.equal(execution.executedAction.functionName, "get_wishlist");
  assert.equal(execution.result.wishlistTotal, 180);
  assert.match(execution.result.message, /known total target/);
  assert.match(execution.result.message, /Noise-cancelling headphones/);
});

test("mock parser maps email request to send_email and records a dry run", async () => {
  delete process.env.GEMINI_API_KEY;
  process.env.EMAIL_DRY_RUN = "true";
  resetAppState();

  const parsed = await parseAssistantFunctionCall(
    "Send an email to lee@example.com with subject Budget update saying I spent 12 euros on lunch"
  );
  const execution = await executeAssistantFunctionCall(parsed.functionCall);

  assert.equal(parsed.functionCall.name, "send_email");
  assert.equal(parsed.functionCall.args.recipientEmail, "lee@example.com");
  assert.deepEqual(parsed.functionCall.args.recipientEmails, ["lee@example.com"]);
  assert.equal(parsed.functionCall.args.emailSubject, "Budget update");
  assert.equal(parsed.functionCall.args.emailBody, "I spent 12 euros on lunch");
  assert.equal(execution.executedAction.functionName, "send_email");
  assert.equal(execution.result.ok, true);
  assert.equal(execution.result.email.status, "dry_run");
  assert.equal(appState.emailLog[0].to, "lee@example.com");

  delete process.env.EMAIL_DRY_RUN;
});

test("mock parser maps Munich retail price lookup to lookup_store_product", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("今天慕尼黑 REWE 牛奶价格多少？");
  const execution = await executeAssistantFunctionCall(parsed.functionCall);

  assert.equal(parsed.functionCall.name, "lookup_store_product");
  assert.equal(parsed.functionCall.args.productQuery, "牛奶");
  assert.deepEqual(parsed.functionCall.args.retailers, ["rewe"]);
  assert.equal(parsed.functionCall.args.location, "Munich, Germany");
  assert.equal(parsed.functionCall.args.lookupType, "price");
  assert.equal(execution.executedAction.functionName, "lookup_store_product");
  assert.equal(execution.result.ok, false);
  assert.equal(execution.result.retailSearch.code, "retail_search_not_configured");
});

test("mock parser maps EDEKA availability and price lookup cleanly", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("看一下edika里有没有整鸡这个商品，有的话多少钱");

  assert.equal(parsed.functionCall.name, "lookup_store_product");
  assert.equal(parsed.functionCall.args.productQuery, "整鸡");
  assert.deepEqual(parsed.functionCall.args.retailers, ["edeka"]);
  assert.equal(parsed.functionCall.args.lookupType, "price_and_availability");
});

test("mock parser routes unspecified electronics lookup to MediaMarkt and Saturn", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("帮我查查 ipad pencil 2代的价格");

  assert.equal(parsed.functionCall.name, "lookup_store_product");
  assert.equal(parsed.functionCall.args.productQuery, "ipad pencil 2代");
  assert.deepEqual(parsed.functionCall.args.retailers, ["mediamarkt", "saturn"]);
  assert.equal(parsed.functionCall.args.lookupType, "price");
});

test("mock parser routes Asian grocery discovery to asian_grocery", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("肉松在munich哪个亚洲超市有卖");

  assert.equal(parsed.functionCall.name, "lookup_store_product");
  assert.equal(parsed.functionCall.args.productQuery, "肉松");
  assert.deepEqual(parsed.functionCall.args.retailers, ["asian_grocery"]);
  assert.equal(parsed.functionCall.args.lookupType, "availability");
});

test("mock parser routes EDEKA discount question to retail offers lookup", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("能否帮我看一下edika近期有哪些打折");

  assert.equal(parsed.functionCall.name, "lookup_retail_offers");
  assert.deepEqual(parsed.functionCall.args.retailers, ["edeka"]);
  assert.equal(parsed.functionCall.args.location, "Munich, Germany");
  assert.equal(parsed.functionCall.args.period, "current_week");
});

test("mock parser routes MediaMarkt and Saturn discount question to retail offers lookup", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("看一下MediaMarkt和Saturn近期有哪些打折");

  assert.equal(parsed.functionCall.name, "lookup_retail_offers");
  assert.deepEqual(parsed.functionCall.args.retailers, ["mediamarkt", "saturn"]);
  assert.equal(parsed.functionCall.args.location, "Munich, Germany");
  assert.equal(parsed.functionCall.args.period, "current_week");
});

test("mock parser routes McDonald's discount question to local deals lookup", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("能帮我看看最近麦当劳有什么折扣吗");

  assert.equal(parsed.functionCall.name, "lookup_local_deals");
  assert.equal(parsed.functionCall.args.merchantQuery, "McDonald's");
  assert.equal(parsed.functionCall.args.category, "food");
  assert.equal(parsed.functionCall.args.location, "Munich, Germany");
  assert.equal(parsed.functionCall.args.period, "current_week");
});

test("mock parser keeps restaurant expense as expense and defaults ambiguous kuai to EUR", async () => {
  delete process.env.GEMINI_API_KEY;
  resetAppState();

  const parsed = await parseAssistantFunctionCall("增加一个expense: 我在麦当劳买了11块钱的汉堡套餐");

  assert.equal(parsed.functionCall.name, "create_expense");
  assert.equal(parsed.functionCall.args.amount, 11);
  assert.equal(parsed.functionCall.args.currency, "EUR");
  assert.equal(parsed.functionCall.args.category, "food");
  assert.equal(parsed.functionCall.args.note, "McDonald's 汉堡套餐");
});

test("post-response parser sends the final answer body by email", async () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalGmailUser = process.env.GMAIL_USER;
  delete process.env.GEMINI_API_KEY;
  process.env.GMAIL_USER = "me@example.com";

  const parsed = await parsePostResponseFunctionCall({
    input: "能否帮我看一下edika近期有哪些打折，并把最后答案send email给我",
    finalMessage: "这是最终答案。\n\n信源:\nhttps://www.edeka.de/"
  });

  assert.equal(parsed.functionCall.name, "send_email");
  assert.equal(parsed.functionCall.args.recipientEmail, "me@example.com");
  assert.deepEqual(parsed.functionCall.args.recipientEmails, ["me@example.com"]);
  assert.equal(parsed.functionCall.args.emailBody, "这是最终答案。\n\n信源:\nhttps://www.edeka.de/");

  if (originalGeminiKey) {
    process.env.GEMINI_API_KEY = originalGeminiKey;
  }

  if (originalGmailUser) {
    process.env.GMAIL_USER = originalGmailUser;
  } else {
    delete process.env.GMAIL_USER;
  }
});

test("post-response parser supports explicit recipient plus user's own mailbox", async () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalGmailUser = process.env.GMAIL_USER;
  delete process.env.GEMINI_API_KEY;
  process.env.GMAIL_USER = "me@example.com";

  const parsed = await parsePostResponseFunctionCall({
    input: "请总结当前的消费记录, 并发送邮件到wumengfanrui@163.com 以及 我 自己的邮箱",
    finalMessage: "当前消费总结。"
  });

  assert.equal(parsed.functionCall.name, "send_email");
  assert.deepEqual(parsed.functionCall.args.recipientEmails, [
    "wumengfanrui@163.com",
    "me@example.com"
  ]);
  assert.equal(parsed.functionCall.args.recipientEmail, "wumengfanrui@163.com");
  assert.equal(parsed.functionCall.args.emailBody, "当前消费总结。");

  if (originalGeminiKey) {
    process.env.GEMINI_API_KEY = originalGeminiKey;
  }

  if (originalGmailUser) {
    process.env.GMAIL_USER = originalGmailUser;
  } else {
    delete process.env.GMAIL_USER;
  }
});

test("EDEKA official search terms include German whole-chicken retail terms", () => {
  const terms = buildEdekaSearchTerms("整鸡");

  assert.ok(terms.includes("Brathähnchen"));
  assert.ok(terms.includes("ganzes Hähnchen"));
});

test("MediaMarkt Saturn official terms include Apple Pencil German query", () => {
  const terms = buildMediaSaturnSearchTerms("ipad pencil 2代");

  assert.ok(terms.includes("Apple Pencil 2"));
  assert.ok(terms.includes("Apple Pencil 2. Generation"));
});

test("Asian grocery terms include multilingual pork floss names", () => {
  const terms = buildAsianGrocerySearchTerms("肉松");

  assert.ok(terms.includes("肉松"));
  assert.ok(terms.includes("pork floss"));
  assert.ok(terms.includes("rousong"));
});

test("Asian grocery provider runs store discovery before product lookup", async () => {
  const originalPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
  delete process.env.GOOGLE_PLACES_API_KEY;

  const results = await lookupOfficialRetailProduct({
    retailers: ["asian_grocery"],
    retailerNames: "Asian grocery stores in Munich",
    retailerDomains: [],
    openDiscovery: true,
    productQuery: "肉松",
    location: "Munich, Germany",
    lookupType: "price_and_availability",
    requestedDate: "2026-05-09"
  });

  assert.deepEqual(
    results.map((result) => result.provider),
    ["asian_store_seed_discovery", "asian_product_lookup"]
  );
  assert.ok(results[0].candidateStores.some((store) => /Go Asia/i.test(store.name)));
  assert.ok(results[1].candidateQueries.some((query) => /Go Asia/i.test(query)));

  if (originalPlacesKey) {
    process.env.GOOGLE_PLACES_API_KEY = originalPlacesKey;
  }
});

test("retail provider registry groups retailers by query mechanism", () => {
  assert.deepEqual(
    getProvidersForRetailer("mediamarkt").map((provider) => provider.id),
    ["media_saturn"]
  );
  assert.deepEqual(
    getProvidersForRetailer("saturn").map((provider) => provider.id),
    ["media_saturn"]
  );
  assert.deepEqual(
    getProvidersForRetailer("rewe").map((provider) => provider.id),
    ["supermarket_search"]
  );
  assert.deepEqual(
    getProvidersForRetailer("rossmann").map((provider) => provider.id),
    ["drugstore_search"]
  );
  assert.deepEqual(
    getProvidersForRetailer("ikea").map((provider) => provider.id),
    ["ikea"]
  );
  assert.deepEqual(
    getProvidersForRetailer("asian_grocery").map((provider) => provider.id),
    ["asian_grocery"]
  );
});

test("map place utility extracts deduped coordinates from retail channels", () => {
  const places = buildMapPlacesFromChannels([
    {
      provider: "google_places_text_search",
      stores: [
        {
          placeId: "place-1",
          name: "EDEKA Test",
          address: "Teststraße 1, München",
          latitude: 48.13,
          longitude: 11.57,
          googleMapsUri: "https://maps.google.com/?cid=1"
        },
        {
          placeId: "place-1",
          name: "EDEKA Test duplicate",
          address: "Teststraße 1, München",
          latitude: 48.13,
          longitude: 11.57
        },
        {
          name: "Missing coordinates"
        }
      ]
    }
  ]);

  assert.equal(places.length, 1);
  assert.equal(places[0].name, "EDEKA Test");
  assert.equal(places[0].latitude, 48.13);
  assert.equal(places[0].longitude, 11.57);
});

test("retailer places discovery returns map places from Google Places payload", async () => {
  const originalPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = "test-key";

  const result = await discoverRetailerPlaces(
    {
      retailers: ["mediamarkt"],
      location: "Munich, Germany"
    },
    {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            places: [
              {
                id: "place-1",
                displayName: {
                  text: "MediaMarkt München Test"
                },
                formattedAddress: "Teststraße 1, 80331 München",
                location: {
                  latitude: 48.13,
                  longitude: 11.57
                },
                googleMapsUri: "https://maps.google.com/?cid=1",
                websiteUri: "https://www.mediamarkt.de/de/store/test"
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        )
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.provider, "google_places_text_search");
  assert.equal(result.mapPlaces.length, 1);
  assert.equal(result.mapPlaces[0].name, "MediaMarkt München Test");
  assert.equal(result.mapPlaces[0].latitude, 48.13);
  assert.equal(result.mapPlaces[0].longitude, 11.57);

  if (originalPlacesKey) {
    process.env.GOOGLE_PLACES_API_KEY = originalPlacesKey;
  } else {
    delete process.env.GOOGLE_PLACES_API_KEY;
  }
});

test("local deals lookup discovers mapped merchant places with a mocked provider", async () => {
  const originalPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  delete process.env.GEMINI_API_KEY;

  const result = await lookupLocalDeals(
    {
      merchantQuery: "麦当劳",
      productQuery: "汉堡套餐",
      location: "Munich, Germany",
      period: "current_week"
    },
    {
      fetcher: async (url) => {
        if (String(url).includes("places:searchText")) {
          return new Response(
            JSON.stringify({
              places: [
                {
                  id: "mcd-place-1",
                  displayName: {
                    text: "McDonald's München Test"
                  },
                  formattedAddress: "Teststraße 2, 80331 München",
                  location: {
                    latitude: 48.14,
                    longitude: 11.58
                  },
                  googleMapsUri: "https://maps.google.com/?cid=2",
                  websiteUri: "https://www.mcdonalds.com/de/de-de.html"
                }
              ]
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json"
              }
            }
          );
        }

        return new Response(
          "<html><head><title>McDonald's Angebote</title></head><body><a href='/de/de-de/angebote.html'>Angebote</a> Coupon Menü 4,99 €</body></html>",
          {
            status: 200,
            headers: {
              "content-type": "text/html"
            }
          }
        );
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.request.merchantQuery, "McDonald's");
  assert.equal(result.mapPlaces.length, 1);
  assert.equal(result.mapPlaces[0].name, "McDonald's München Test");
  assert.ok(result.sources.some((source) => /McDonald's/i.test(source.title)));

  if (originalPlacesKey) {
    process.env.GOOGLE_PLACES_API_KEY = originalPlacesKey;
  } else {
    delete process.env.GOOGLE_PLACES_API_KEY;
  }

  if (originalGeminiKey) {
    process.env.GEMINI_API_KEY = originalGeminiKey;
  }
});

test("assistant message renderer converts markdown links and inline bullets to HTML", () => {
  const html = renderAssistantMessage(
    "信源: * [MediaMarkt 官方优惠页](https://www.mediamarkt.de/de/campaign/angebote-aktionen) * https://www.saturn.de/de/specials"
  );

  assert.match(html, /<ul>/);
  assert.match(html, /href="https:\/\/www\.mediamarkt\.de\/de\/campaign\/angebote-aktionen"/);
  assert.match(html, />MediaMarkt 官方优惠页<\/a>/);
  assert.match(html, /href="https:\/\/www\.saturn\.de\/de\/specials"/);
  assert.match(html, />saturn\.de \/ specials<\/a>/);
  assert.doesNotMatch(html, />https:\/\/www\.saturn\.de\/de\/specials<\/a>/);
});

test("final response composer falls back to tool message without Gemini key", async () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const finalResponse = await composeFinalAssistantResponse({
    input: "show my balance",
    functionCall: {
      name: "get_profile",
      args: {}
    },
    execution: {
      result: {
        ok: true,
        message: "Alex Chen's balance is €2,340.50."
      }
    }
  });

  assert.equal(finalResponse.provider, "local");
  assert.equal(finalResponse.message, "Alex Chen's balance is €2,340.50.");

  if (originalGeminiKey) {
    process.env.GEMINI_API_KEY = originalGeminiKey;
  }
});

test("post-action final response composer appends email status without Gemini key", async () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const finalResponse = await composePostActionFinalResponse({
    input: "把最后答案发邮件给我",
    priorAssistantMessage: "这是最终答案。",
    postFunctionCall: {
      name: "send_email",
      args: {
        recipientEmail: "me@example.com",
        emailSubject: "Retail offers lookup result",
        emailBody: "这是最终答案。"
      }
    },
    postExecution: {
      result: {
        ok: true,
        message: "Prepared email to me@example.com. Dry run is enabled, so no email was sent."
      }
    }
  });

  assert.equal(finalResponse.provider, "local");
  assert.match(finalResponse.message, /这是最终答案/);
  assert.match(finalResponse.message, /Prepared email to me@example.com/);

  if (originalGeminiKey) {
    process.env.GEMINI_API_KEY = originalGeminiKey;
  }
});
