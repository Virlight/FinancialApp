# Financial App AI Assistant MVP

This is a local MVP for validating the core assistant chain:

`voice/text input -> Gemini transcription or function calling -> internal app function -> visible UI update -> optional Gemini TTS reply`

The web UI is English-only. Text commands can be English or Chinese. Voice input is English-only for better recognition quality.

## Supported App Actions

- `create_expense`: record an expense.
- `delete_expense`: delete a matching expense by id or natural-language selectors such as amount, category, or note.
- `get_profile`: show the demo user profile, balance, and budget.
- `get_spending_summary`: show spending totals and category breakdowns.
- `get_financial_overview`: show balance, spending, latest expenses, and wishlist together.
- `create_wishlist_item`: create a purchase plan or wishlist item.
- `get_wishlist`: list planned wishlist items.
- `send_email`: send a plain-text email through configured Gmail SMTP credentials.
- `lookup_store_product`: research current Munich retailer product price, stock, or availability. Configured official channels run first; Gemini Grounding with Google Search is used as fallback.

## First-Time Setup

```bash
cd /Users/haoliang/Projects/FinancialApp
npm install
cp .env.example .env
```

Edit `.env` and set your Gemini API key:

```bash
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-2.5-flash
RETAIL_SEARCH_MODEL=gemini-2.5-flash
GEMINI_TRANSCRIPTION_MODEL=gemini-3-flash-preview
GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview
GEMINI_TTS_VOICE=Iapetus
PORT=3000

EMAIL_PROVIDER=gmail
GMAIL_USER=your_gmail_address@gmail.com
GMAIL_APP_PASSWORD=your_16_character_app_password
EMAIL_FROM="Financial App <your_gmail_address@gmail.com>"
EMAIL_DRY_RUN=true
```

Start the local server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Restarting The Server

Restart after changing `.env`, changing model names, or if the page still shows `mock`.

If the server terminal is visible:

```bash
# Press Ctrl+C in the terminal running npm run dev
npm run dev
```

If port 3000 is already occupied:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
kill <PID>
npm run dev
```

You usually do not need a manual restart after editing `src/` while using `npm run dev`, because Node watch restarts automatically. If you only edit `public/`, refresh the browser.

## Voice Input And Voice Output

Voice input flow:

```text
English microphone recording -> browser encodes WAV -> /api/transcribe -> Gemini transcript -> /api/assistant -> app action
```

Voice output flow:

```text
final assistant response -> Gemini TTS -> WAV audio -> browser audio player
```

Text commands use the `Play Gemini TTS reply` checkbox. Voice commands send `inputMode: "voice"` to `/api/assistant`, and the backend always requests a Gemini TTS audio reply after the app action finishes. Non-English voice input is rejected before function calling instead of being translated.

Default speech models:

```text
Voice transcription: gemini-3-flash-preview
TTS: gemini-3.1-flash-tts-preview
TTS fallback: gemini-2.5-flash-preview-tts
Voice: Iapetus
```

The microphone works on `localhost` because browsers treat it as a secure origin. The implementation is not real-time streaming; it records a short command, then transcribes after you stop recording.

## Gmail Email Sending

Email sending uses `nodemailer` with Gmail SMTP. For Gmail, do not use your normal Google password. Use a Gmail App Password generated from your Google Account after enabling 2-Step Verification.

Keep this enabled while testing:

```bash
EMAIL_DRY_RUN=true
```

Dry-run is the default unless `EMAIL_DRY_RUN=false`. With dry-run enabled, the assistant parses the email request, executes `send_email`, and records an email activity item, but no real email is sent. To send real email after configuring Gmail credentials:

```bash
EMAIL_DRY_RUN=false
```

Then restart the server.

## Retail Product Lookup

Retail lookup is implemented as one registered function, `lookup_store_product`, with an internal retailer router. Supported retailer ids:

```text
mediamarkt, saturn, edeka, asian_grocery, rossmann, rewe, penny, lidl, aldi, ikea, all_supported
```

The assistant request uses a standard function-calling workflow:

```text
user text
  -> Gemini function calling
  -> execute registered app function
  -> function returns structured tool result
  -> Gemini final response synthesis
  -> frontend displays final answer
```

For retail lookup, `lookup_store_product` is still one registered function. It can collect both price and availability in one tool result when `lookupType` is `price_and_availability`.

Retail lookup uses a two-channel evidence workflow:

1. Official direct channel when configured. EDEKA uses its public official product search API. MediaMarkt and Saturn use their official search pages and parse the JSON-LD product list when available.
2. Gemini Grounding with Google Search for missing prices, stock, store-specific availability, or retailers without a direct channel. Grounding now returns structured evidence (`confirmed`, `strongLeads`, `onlineOnly`, `notConfirmed`, `caveats`) instead of the final user-facing answer. The final response model summarizes that tool result afterward.

The retail implementation is grouped by data source/query mechanism instead of one file per retailer:

```text
src/retail/
  lookupStoreProduct.js
  retailerConfig.js
  retailerRouter.js
  providers/
    mediaSaturnProvider.js
    ikeaProvider.js
    supermarketProvider.js
    drugstoreProvider.js
    asianGroceryProvider.js
    asianStoreDiscoveryProvider.js
    asianProductLookupProvider.js
    fallbackGroundingProvider.js
  parsers/
    jsonLdParser.js
    priceParser.js
    availabilityParser.js
  prompts/
    buildGroundingPrompt.js
  utils/
    fetchWithTimeout.js
    normalizeProductQuery.js
    dedupeResults.js
```

`mediaSaturnProvider` supports both MediaMarkt and Saturn because they share the same search-page structure. `supermarketProvider` groups EDEKA, REWE, PENNY, Lidl, and ALDI; EDEKA currently has an official API implementation while the others use official search entry points plus fallback grounding. `ikeaProvider` is isolated because IKEA store and stock lookup will likely need its own product/store model.

`asianGroceryProvider` is a virtual retailer category for Munich Asian supermarket discovery. It now runs two internal steps:

1. `asianStoreDiscoveryProvider` discovers candidate Asian grocery stores. If `GOOGLE_PLACES_API_KEY` is configured, it calls Google Places Text Search; otherwise it uses a local Munich seed list such as Go Asia, Orient Shop, Asia Markt City, Shanghai Markt, Vinh-Loi, and iShop.
2. `asianProductLookupProvider` builds store-specific product lookup queries using multilingual product terms such as 肉松, pork floss, rousong, and meat floss. It then hands those store/product candidates to grounding so the answer can separate confirmed product pages from likely leads.

Optional Google Places configuration:

```bash
GOOGLE_PLACES_API_KEY=your_google_places_api_key
```

The Google fallback prioritizes official retailer domains:

```text
mediamarkt.de, saturn.de, edeka.de, rossmann.de, rewe.de, penny.de, lidl.de, aldi-sued.de, ikea.com/de/de
```

This avoids browser automation and ad-hoc scraping. The app returns channel metadata, structured evidence, search query metadata, and source links. If exact Munich physical-store price or availability is not visible from official sources, the assistant should say that clearly instead of inventing a number.

Official-channel caveats: EDEKA product search can confirm catalog matches such as product names, descriptions, GTINs, and product pages, but it does not return local Munich store inventory or exact prices. MediaMarkt and Saturn search pages can expose online prices through JSON-LD, but they do not directly prove Munich single-store stock or local in-store price. In those cases the app falls back to grounded search and labels the fallback separately.

For a production retailer app with guaranteed prices and inventory, replace or augment the grounded-search provider with retailer partner APIs, product feeds, or contracted data providers. The current provider is best treated as live web research with citations, not an inventory guarantee.

## Debug Flow

Each command displays:

```text
0. Voice Transcription        Only shown for microphone input
1. User Input                 The final text command
2. Input And System Instruction Sent To Gemini
3. Expected Model Output Contract, including registered function declarations
4. Raw Model Output           Gemini's returned function call
5. Function Call Selected By Gemini
6. App Function Call          Executed internal function name and arguments
7. Final Response Synthesis   Final answer model input/output
8. Gemini TTS Debug           Only shown when TTS succeeds
Retail Product Lookup Sources Only shown for retail product lookup
```

You can also inspect the API directly:

```bash
curl -s -X POST http://localhost:3000/api/assistant \
  -H 'Content-Type: application/json' \
  -d '{"message":"Record a 12 euro lunch expense","speak":true}'
```

## Example Commands

```text
Record a 12 euro lunch expense
Delete the 12 euro lunch expense
Show my profile
How much did I spend this month?
How much did I spend on transport this month?
Summarize my current financial situation
Add a camera to my wishlist with a budget of 800 euros
Show my wishlist
Send an email to lee@example.com with subject Budget update saying I spent 12 euros on lunch
今天慕尼黑 REWE 牛奶价格多少？
Check if IKEA Munich has Billy bookcase in stock today
Compare coffee prices at Lidl and Aldi in Munich today
帮我记录一笔 12 欧的午饭支出
总结一下当前我的支出情况
我的本月交通花费是多少
查看我的购买计划
```

## Tests

```bash
npm test
```
