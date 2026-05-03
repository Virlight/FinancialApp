import { GoogleGenAI } from "@google/genai";

const defaultTranscriptionModel = "gemini-3-flash-preview";
const fallbackTranscriptionModel = "gemini-2.5-flash";
const defaultTtsModel = "gemini-3.1-flash-tts-preview";
const fallbackTtsModel = "gemini-2.5-flash-preview-tts";
const defaultTtsVoice = "Iapetus";
const unsupportedLanguageToken = "UNSUPPORTED_LANGUAGE";

export async function transcribeAudio({ audioBase64, mimeType }) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required for voice transcription.");
  }

  if (!audioBase64 || !mimeType) {
    throw new Error("audioBase64 and mimeType are required.");
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });
  const models = uniqueValues([
    process.env.GEMINI_TRANSCRIPTION_MODEL,
    defaultTranscriptionModel,
    fallbackTranscriptionModel
  ]);
  const prompt = `
Transcribe this voice command for a financial app assistant.
Voice input supports English only.
Return only the spoken English words as plain text.
If the audio is not primarily English or is too unclear to transcribe confidently, return exactly ${unsupportedLanguageToken}.
Do not translate non-English speech. Do not answer the command. Do not add explanations. Do not add markdown.
`.trim();
  let lastError = null;

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: audioBase64
            }
          }
        ],
        config: {
          temperature: 0
        }
      });
      const transcript = cleanupTranscript(response.text || "");

      return {
        provider: "gemini",
        model,
        transcript,
        supportedLanguage: transcript !== unsupportedLanguageToken,
        debug: {
          transcriptionPrompt: prompt,
          inputMimeType: mimeType,
          rawTranscriptionOutput: response.text || "",
          attemptedModels: models
        }
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Gemini transcription failed.");
}

export async function synthesizeSpeech(text) {
  if (!process.env.GEMINI_API_KEY) {
    return {
      ok: false,
      warning: "GEMINI_API_KEY is required for Gemini TTS."
    };
  }

  const speakableText = String(text || "").trim();

  if (!speakableText) {
    return {
      ok: false,
      warning: "No text was provided for speech synthesis."
    };
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });
  const models = uniqueValues([process.env.GEMINI_TTS_MODEL, defaultTtsModel, fallbackTtsModel]);
  const voiceName = process.env.GEMINI_TTS_VOICE || defaultTtsVoice;
  const ttsPrompt = `Read this English finance assistant response clearly, naturally, and at a steady pace. Say exactly this text: ${speakableText}`;
  let lastError = null;

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text: ttsPrompt }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName
              }
            }
          }
        }
      });
      const inlineData = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)
        ?.inlineData;

      if (!inlineData?.data) {
        lastError = new Error("Gemini TTS returned no audio data.");
        continue;
      }

      const pcmBuffer = Buffer.from(inlineData.data, "base64");
      const wavBuffer = createWavBuffer(pcmBuffer);

      return {
        ok: true,
        provider: "gemini",
        model,
        voiceName,
        mimeType: "audio/wav",
        audioBase64: wavBuffer.toString("base64"),
        debug: {
          ttsPrompt,
          rawMimeType: inlineData.mimeType || "audio/pcm",
          attemptedModels: models
        }
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    warning: `Gemini TTS failed: ${lastError?.message || "unknown error"}`,
    model: models[0],
    voiceName
  };
}

export function isUnsupportedVoiceLanguage(transcript) {
  return String(transcript || "").trim().toUpperCase() === unsupportedLanguageToken;
}

function uniqueValues(values) {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function cleanupTranscript(text) {
  return text
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/^transcript:\s*/i, "")
    .trim();
}

function createWavBuffer(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}
