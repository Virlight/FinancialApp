import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeAssistantFunctionCall } from "./actions.js";
import { getAppSnapshot, resetAppState } from "./appState.js";
import { parseAssistantFunctionCall, parsePostResponseFunctionCall } from "./assistantParser.js";
import { maybeStartDiscountLookupJob } from "./discountJobs.js";
import { composeFinalAssistantResponse, composePostActionFinalResponse } from "./finalResponse.js";
import {
  attachRealtime,
  completeRealtimeJob,
  createRealtimeJob,
  emitRealtimeJobProgress,
  failRealtimeJob,
  getRealtimeSnapshot,
  throwIfRealtimeJobCancelled
} from "./realtime.js";
import { synthesizeSpeech, transcribeAudio } from "./speech.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

const app = express();
const port = Number(process.env.PORT || 3000);
const server = createServer(app);

attachRealtime(server);

app.use(express.json({ limit: "25mb" }));
app.use(express.static(publicDir));

app.get("/api/state", (_request, response) => {
  response.json(getAppSnapshot());
});

app.get("/api/realtime", (_request, response) => {
  response.json(getRealtimeSnapshot());
});

app.post("/api/assistant", async (request, response) => {
  const message = String(request.body?.message || "").trim();
  const clientId = normalizeClientId(request.body?.clientId);
  const responseLanguage = normalizeResponseLanguage(request.body?.responseLanguage);
  const realtimeJob = createRealtimeJob({
    clientId,
    type: "assistant_request",
    label: "Assistant request",
    metadata: {
      inputMode: request.body?.inputMode === "voice" ? "voice" : "text",
      responseLanguage,
      preview: message.slice(0, 120)
    }
  });

  if (!message) {
    failRealtimeJob(realtimeJob, new Error("message is required"));
    response.status(400).json({
      error: "message is required"
    });
    return;
  }

  try {
    emitRealtimeJobProgress(realtimeJob, {
      stage: "function_calling_started",
      message: "Routing user input with Gemini function calling."
    });
    const parsed = await parseAssistantFunctionCall(message);
    emitRealtimeJobProgress(realtimeJob, {
      stage: "function_call_selected",
      message: `Selected function: ${parsed.functionCall.name}`,
      data: {
        functionCall: parsed.functionCall
      }
    });
    throwIfRealtimeJobCancelled(realtimeJob);

    emitRealtimeJobProgress(realtimeJob, {
      stage: "app_function_started",
      message: `Running app function: ${parsed.functionCall.name}`
    });
    const execution = await executeAssistantFunctionCall(parsed.functionCall);
    emitRealtimeJobProgress(realtimeJob, {
      stage: "app_function_done",
      message: `Finished app function: ${execution.executedAction.functionName}`,
      data: {
        executedAction: execution.executedAction,
        mapPlaces: execution.result?.mapPlaces || []
      }
    });
    throwIfRealtimeJobCancelled(realtimeJob);

    emitRealtimeJobProgress(realtimeJob, {
      stage: "final_response_started",
      message: "Synthesizing final answer."
    });
    const finalResponse = await composeFinalAssistantResponse({
      input: message,
      functionCall: parsed.functionCall,
      execution,
      responseLanguage
    });
    emitRealtimeJobProgress(realtimeJob, {
      stage: "final_response_done",
      message: "Final answer synthesis completed."
    });
    let result = {
      ...execution.result,
      toolMessage: execution.result.message,
      message: finalResponse.message
    };
    let state = execution.state;
    let postParsed = null;
    let postExecution = null;
    let postFinalResponse = null;

    postParsed = await parsePostResponseFunctionCall({
      input: message,
      finalMessage: finalResponse.message
    });

    if (postParsed?.functionCall) {
      throwIfRealtimeJobCancelled(realtimeJob);
      emitRealtimeJobProgress(realtimeJob, {
        stage: "post_function_call_selected",
        message: `Selected post-response function: ${postParsed.functionCall.name}`,
        data: {
          functionCall: postParsed.functionCall
        }
      });
      postExecution = await executeAssistantFunctionCall(postParsed.functionCall);
      emitRealtimeJobProgress(realtimeJob, {
        stage: "post_function_done",
        message: `Finished post-response function: ${postExecution.executedAction.functionName}`,
        data: {
          executedAction: postExecution.executedAction
        }
      });
      postFinalResponse = await composePostActionFinalResponse({
        input: message,
        priorAssistantMessage: finalResponse.message,
        postFunctionCall: postParsed.functionCall,
        postExecution,
        responseLanguage
      });
      result = {
        ...result,
        postToolMessage: postExecution.result.message,
        postActionResult: postExecution.result,
        message: postFinalResponse.message
      };
      state = postExecution.state;
    }

    const shouldSpeak = Boolean(request.body?.speak || request.body?.inputMode === "voice");
    emitRealtimeJobProgress(realtimeJob, {
      stage: shouldSpeak ? "speech_started" : "response_ready",
      message: shouldSpeak ? "Generating speech reply." : "Response is ready."
    });
    const backgroundDiscountJob = maybeStartDiscountLookupJob({
      clientId,
      execution,
      responseLanguage
    });
    const speech = shouldSpeak ? await synthesizeSpeech(result.message, { responseLanguage }) : null;
    completeRealtimeJob(realtimeJob, {
      message: result.message,
      hasSpeech: Boolean(speech),
      mapPlaces:
        result.mapPlaces ||
        result.retailSearch?.mapPlaces ||
        result.retailOffers?.mapPlaces ||
        result.localDeals?.mapPlaces ||
        [],
      backgroundJobs: backgroundDiscountJob ? [backgroundDiscountJob] : []
    });

    response.json({
      realtimeJobId: realtimeJob?.id || null,
      backgroundJobs: backgroundDiscountJob ? [backgroundDiscountJob] : [],
      input: message,
      inputMode: request.body?.inputMode === "voice" ? "voice" : "text",
      responseLanguage,
      parser: {
        provider: parsed.provider,
        model: parsed.model,
        warning: parsed.warning || null
      },
      debug: parsed.debug,
      finalResponse,
      postParser: postParsed
        ? {
            provider: postParsed.provider,
            model: postParsed.model,
            warning: postParsed.warning || null
          }
        : null,
      postDebug: postParsed?.debug || null,
      postFunctionCall: postParsed?.functionCall || null,
      postExecutedAction: postExecution?.executedAction || null,
      postResult: postExecution?.result || null,
      postFinalResponse,
      functionCall: parsed.functionCall,
      executedAction: execution.executedAction,
      result,
      speech,
      state
    });
  } catch (error) {
    failRealtimeJob(realtimeJob, error);
    response.status(error.code === "realtime_job_cancelled" ? 409 : 500).json({
      error: error.code === "realtime_job_cancelled" ? "assistant_request_cancelled" : "assistant_request_failed",
      message: error.message,
      realtimeJobId: realtimeJob?.id || null
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

server.listen(port, () => {
  console.log(`Financial App AI assistant MVP running at http://localhost:${port}`);
});

function normalizeClientId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeResponseLanguage(value) {
  return value === "en" ? "en" : "zh";
}
