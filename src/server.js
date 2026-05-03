import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeAssistantIntent } from "./actions.js";
import { getAppSnapshot, resetAppState } from "./appState.js";
import { parseAssistantIntent } from "./assistantParser.js";
import { synthesizeSpeech, transcribeAudio } from "./speech.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "25mb" }));
app.use(express.static(publicDir));

app.get("/api/state", (_request, response) => {
  response.json(getAppSnapshot());
});

app.post("/api/assistant", async (request, response) => {
  const message = String(request.body?.message || "").trim();

  if (!message) {
    response.status(400).json({
      error: "message is required"
    });
    return;
  }

  try {
    const parsed = await parseAssistantIntent(message);
    const execution = executeAssistantIntent(parsed.parsedIntent);
    const shouldSpeak = Boolean(request.body?.speak || request.body?.inputMode === "voice");
    const speech = shouldSpeak ? await synthesizeSpeech(execution.result.message) : null;

    response.json({
      input: message,
      inputMode: request.body?.inputMode === "voice" ? "voice" : "text",
      parser: {
        provider: parsed.provider,
        model: parsed.model,
        warning: parsed.warning || null
      },
      debug: parsed.debug,
      parsedIntent: parsed.parsedIntent,
      executedAction: execution.executedAction,
      result: execution.result,
      speech,
      state: execution.state
    });
  } catch (error) {
    response.status(500).json({
      error: "assistant_request_failed",
      message: error.message
    });
  }
});

app.post("/api/transcribe", async (request, response) => {
  try {
    const audioBase64 = String(request.body?.audioBase64 || "");
    const mimeType = String(request.body?.mimeType || "");

    if (!audioBase64 || !mimeType) {
      response.status(400).json({
        error: "audioBase64 and mimeType are required"
      });
      return;
    }

    response.json(await transcribeAudio({ audioBase64, mimeType }));
  } catch (error) {
    response.status(500).json({
      error: "transcription_failed",
      message: error.message
    });
  }
});

app.post("/api/reset", (_request, response) => {
  response.json(resetAppState());
});

app.listen(port, () => {
  console.log(`Financial App AI assistant MVP running at http://localhost:${port}`);
});
