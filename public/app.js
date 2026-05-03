const form = document.querySelector("#assistant-form");
const input = document.querySelector("#message-input");
const resetButton = document.querySelector("#reset-button");
const recordButton = document.querySelector("#record-button");
const speakToggle = document.querySelector("#speak-toggle");
const voiceStatus = document.querySelector("#voice-status");
const conversation = document.querySelector("#conversation");
const profileName = document.querySelector("#profile-name");
const profileBalance = document.querySelector("#profile-balance");
const profileBudget = document.querySelector("#profile-budget");
const summaryTotal = document.querySelector("#summary-total");
const categoryList = document.querySelector("#category-list");
const expenseList = document.querySelector("#expense-list");
const wishlistList = document.querySelector("#wishlist-list");

const formatters = new Map();
let activeRecorder = null;

loadState();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();

  if (!message) {
    input.focus();
    return;
  }

  await runAssistant(message);
});

recordButton.addEventListener("click", async () => {
  if (activeRecorder) {
    await stopVoiceInput();
    return;
  }

  await startVoiceInput();
});

resetButton.addEventListener("click", async () => {
  setLoading(true);

  try {
    const response = await fetch("/api/reset", {
      method: "POST"
    });
    const state = await response.json();
    renderState(state);
    conversation.innerHTML = `
      <div class="empty-state">
        Demo data has been reset. Enter or record a command to verify the full flow again.
      </div>
    `;
  } finally {
    setLoading(false);
  }
});

document.querySelectorAll("[data-example]").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.example;
    input.focus();
  });
});

async function runAssistant(message, options = {}) {
  setLoading(true);

  try {
    const response = await fetch("/api/assistant", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        inputMode: options.inputMode || "text",
        speak: options.forceSpeech || speakToggle.checked
      })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || payload.error || "Request failed");
    }

    payload.transcription = options.transcription || null;
    renderTurn(payload);
    renderState(payload.state);
    playAssistantAudio();
    input.value = "";
  } catch (error) {
    conversation.innerHTML = `
      <article class="turn">
        <div class="turn-header">
          <p><strong>Request failed</strong></p>
        </div>
        <div class="turn-body">
          <div class="result-message">${escapeHtml(error.message)}</div>
        </div>
      </article>
    `;
  } finally {
    setLoading(false);
  }
}

async function startVoiceInput() {
  if (!navigator.mediaDevices?.getUserMedia) {
    voiceStatus.textContent = "This browser does not support microphone recording.";
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const chunks = [];

    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    activeRecorder = {
      stream,
      audioContext,
      source,
      processor,
      chunks,
      startedAt: Date.now()
    };
    recordButton.textContent = "Stop and transcribe";
    voiceStatus.textContent = "Recording... speak a finance command in English only.";
  } catch (error) {
    voiceStatus.textContent = `Microphone unavailable: ${error.message}`;
  }
}

async function stopVoiceInput() {
  const recorder = activeRecorder;
  activeRecorder = null;
  recordButton.textContent = "Start voice input";

  if (!recorder) {
    return;
  }

  recorder.processor.disconnect();
  recorder.source.disconnect();
  recorder.stream.getTracks().forEach((track) => track.stop());

  const sampleRate = recorder.audioContext.sampleRate;
  await recorder.audioContext.close();

  if (Date.now() - recorder.startedAt < 500 || recorder.chunks.length === 0) {
    voiceStatus.textContent = "Recording was too short. Try again.";
    return;
  }

  const wavBlob = encodeWav(recorder.chunks, sampleRate);
  voiceStatus.textContent = "Transcribing voice with Gemini...";
  setLoading(true);

  try {
    const audioBase64 = await blobToBase64(wavBlob);
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        audioBase64,
        mimeType: "audio/wav"
      })
    });
    const transcription = await response.json();

    if (!response.ok) {
      throw new Error(transcription.message || transcription.error || "Transcription failed");
    }

    if (transcription.supportedLanguage === false) {
      voiceStatus.textContent = "Voice input supports English only. Please try again in English.";
      renderUnsupportedVoiceLanguage(transcription);
      return;
    }

    input.value = transcription.transcript;
    voiceStatus.textContent = `Transcript: ${transcription.transcript}`;
    await runAssistant(transcription.transcript, {
      transcription,
      inputMode: "voice",
      forceSpeech: true
    });
  } catch (error) {
    voiceStatus.textContent = `Voice input failed: ${error.message}`;
  } finally {
    setLoading(false);
  }
}

function renderUnsupportedVoiceLanguage(transcription) {
  conversation.innerHTML = `
    <article class="turn">
      <div class="turn-header">
        <p><strong>Voice input rejected</strong></p>
        <p><strong>Transcription model:</strong> ${escapeHtml(transcription.provider)} / ${escapeHtml(transcription.model)}</p>
      </div>
      <div class="turn-body">
        <div class="result-message"><span>Assistant response:</span> Voice input supports English only. Please try again in English.</div>
        <details class="debug-full" open>
          <summary>0. Voice Transcription</summary>
          <pre>${escapeHtml(JSON.stringify(transcription, null, 2))}</pre>
        </details>
      </div>
    </article>
  `;
}

async function loadState() {
  const response = await fetch("/api/state");
  const state = await response.json();
  renderState(state);
}

function renderTurn(payload) {
  const warning = payload.parser.warning
    ? `<div class="warning">${escapeHtml(payload.parser.warning)}</div>`
    : "";
  const ttsWarning = payload.speech?.warning
    ? `<div class="warning">${escapeHtml(payload.speech.warning)}</div>`
    : "";
  const prompt = payload.debug?.promptSentToModel || "No prompt was sent.";
  const rawModelOutput = payload.debug?.rawModelOutput || "No raw model output.";
  const outputContract = payload.debug?.modelOutputContract
    ? JSON.stringify(payload.debug.modelOutputContract, null, 2)
    : "No output contract.";
  const transcriptionBlock = payload.transcription
    ? `
        <details class="debug-full" open>
          <summary>0. Voice Transcription</summary>
          <pre>${escapeHtml(
            JSON.stringify(
              {
                provider: payload.transcription.provider,
                model: payload.transcription.model,
                transcript: payload.transcription.transcript,
                debug: payload.transcription.debug
              },
              null,
              2
            )
          )}</pre>
        </details>
      `
    : "";
  const audioBlock = payload.speech?.ok
    ? `
        <div class="assistant-audio">
          <p class="code-label">Gemini TTS Audio Reply</p>
          <audio controls src="data:${escapeHtml(payload.speech.mimeType)};base64,${payload.speech.audioBase64}"></audio>
          <small>${escapeHtml(payload.speech.model)} / ${escapeHtml(payload.speech.voiceName)}</small>
        </div>
      `
    : "";
  const ttsDebugBlock = payload.speech?.debug
    ? `
        <details class="debug-full">
          <summary>7. Gemini TTS Debug</summary>
          <pre>${escapeHtml(JSON.stringify(payload.speech.debug, null, 2))}</pre>
        </details>
      `
    : "";

  conversation.innerHTML = `
    <article class="turn">
      <div class="turn-header">
        <p><strong>User input:</strong> ${escapeHtml(payload.input)}</p>
        <p><strong>Input mode:</strong> ${escapeHtml(payload.inputMode || "text")}</p>
        <p><strong>Parser:</strong> ${escapeHtml(payload.parser.provider)} / ${escapeHtml(payload.parser.model)}</p>
      </div>
      <div class="turn-body">
        <div class="result-message"><span>Assistant response:</span> ${escapeHtml(payload.result.message)}</div>
        ${warning}
        ${ttsWarning}
        ${audioBlock}
        ${ttsDebugBlock}
        ${transcriptionBlock}
        <details class="debug-full" open>
          <summary>1. User Input</summary>
          <pre>${escapeHtml(payload.input)}</pre>
        </details>
        <details class="debug-full" open>
          <summary>2. Prompt Sent To Gemini</summary>
          <pre>${escapeHtml(prompt)}</pre>
        </details>
        <details class="debug-full">
          <summary>3. Expected Model Output Contract</summary>
          <pre>${escapeHtml(outputContract)}</pre>
        </details>
        <details class="debug-full" open>
          <summary>4. Raw Model Output</summary>
          <pre>${escapeHtml(rawModelOutput)}</pre>
        </details>
        <div>
          <p class="code-label">5. Normalized Intent JSON</p>
          <pre>${escapeHtml(JSON.stringify(payload.parsedIntent, null, 2))}</pre>
        </div>
        <div>
          <p class="code-label">6. App Function Call</p>
          <pre>${escapeHtml(JSON.stringify(payload.executedAction, null, 2))}</pre>
        </div>
      </div>
    </article>
  `;
}

function renderState(state) {
  profileName.textContent = state.profile.name;
  profileBalance.textContent = formatMoney(state.profile.currentBalance, state.profile.baseCurrency);
  profileBudget.textContent = formatMoney(state.profile.monthlyBudget, state.profile.baseCurrency);
  summaryTotal.textContent = formatMoney(state.summary.total, state.summary.currency);

  const categoryEntries = Object.entries(state.summary.byCategory);
  categoryList.innerHTML = categoryEntries.length
    ? categoryEntries
        .map(
          ([category, amount]) => `
            <div class="category-row">
              <span>${escapeHtml(category)}</span>
              <strong>${formatMoney(amount, state.summary.currency)}</strong>
            </div>
          `
        )
        .join("")
    : `<div class="category-row"><span>No spending yet</span><strong>-</strong></div>`;

  expenseList.innerHTML = state.expenses
    .slice(0, 6)
    .map(
      (expense) => `
        <div class="expense-row">
          <div class="expense-main">
            <strong>${escapeHtml(expense.note)}</strong>
            <small>${escapeHtml(expense.id)} · ${escapeHtml(expense.category)} · ${escapeHtml(expense.date)}</small>
          </div>
          <strong>${formatMoney(expense.amount, expense.currency)}</strong>
        </div>
      `
    )
    .join("");

  wishlistList.innerHTML = state.wishlist.length
    ? state.wishlist
        .slice(0, 6)
        .map(
          (item) => `
            <div class="wishlist-row">
              <div class="expense-main">
                <strong>${escapeHtml(item.itemName)}</strong>
                <small>${escapeHtml(item.id)} · ${escapeHtml(item.priority)} priority${item.dueDate ? ` · ${escapeHtml(item.dueDate)}` : ""}</small>
              </div>
              <strong>${item.targetAmount ? formatMoney(item.targetAmount, item.currency) : "No budget"}</strong>
            </div>
          `
        )
        .join("")
    : `<div class="wishlist-row"><span>No wishlist items</span><strong>-</strong></div>`;
}

function formatMoney(value, currency) {
  const key = currency || "EUR";

  if (!formatters.has(key)) {
    formatters.set(
      key,
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: key
      })
    );
  }

  return formatters.get(key).format(value);
}

function encodeWav(chunks, sampleRate) {
  const samples = mergeFloat32Chunks(chunks);
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;

  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}

function mergeFloat32Chunks(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function playAssistantAudio() {
  const audio = conversation.querySelector("audio");

  if (!audio) {
    return;
  }

  audio.play().catch(() => {
    voiceStatus.textContent = "Audio reply is ready. Press play if the browser blocked autoplay.";
  });
}

function setLoading(isLoading) {
  document.body.classList.toggle("loading", isLoading);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
