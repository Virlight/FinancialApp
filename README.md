# Financial App AI Assistant MVP

This is a local MVP for validating the core assistant chain:

`voice/text input -> Gemini transcription or prompt -> structured JSON -> internal app function -> visible UI update -> optional Gemini TTS reply`

The web UI is English-only. Text commands can be English or Chinese. Voice input is English-only for better recognition quality.

## Supported App Actions

- `create_expense`: record an expense.
- `delete_expense`: delete a matching expense by id or natural-language selectors such as amount, category, or note.
- `get_profile`: show the demo user profile, balance, and budget.
- `get_spending_summary`: show spending totals and category breakdowns.
- `create_wishlist_item`: create a purchase plan or wishlist item.
- `get_wishlist`: list planned wishlist items.

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
GEMINI_TRANSCRIPTION_MODEL=gemini-3-flash-preview
GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview
GEMINI_TTS_VOICE=Iapetus
PORT=3000
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
app result text -> Gemini TTS -> WAV audio -> browser audio player
```

Text commands use the `Play Gemini TTS reply` checkbox. Voice commands send `inputMode: "voice"` to `/api/assistant`, and the backend always requests a Gemini TTS audio reply after the app action finishes. Non-English voice input is rejected before intent parsing instead of being translated.

Default speech models:

```text
Voice transcription: gemini-3-flash-preview
TTS: gemini-3.1-flash-tts-preview
TTS fallback: gemini-2.5-flash-preview-tts
Voice: Iapetus
```

The microphone works on `localhost` because browsers treat it as a secure origin. The implementation is not real-time streaming; it records a short command, then transcribes after you stop recording.

## Debug Flow

Each command displays:

```text
0. Voice Transcription        Only shown for microphone input
1. User Input                 The final text command
2. Prompt Sent To Gemini      The full intent-parsing prompt
3. Expected Model Output Contract
4. Raw Model Output           Gemini's raw JSON text
5. Normalized Intent JSON     App-cleaned JSON
6. App Function Call          Internal function name and arguments
7. Gemini TTS Debug           Only shown when TTS succeeds
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
帮我记录一笔 12 欧的午饭支出
总结一下当前我的支出情况
我的本月交通花费是多少
查看我的购买计划
```

## Tests

```bash
npm test
```
