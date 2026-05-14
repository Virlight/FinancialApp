import { renderAssistantMessage } from "./assistantMarkdown.js?v=20260510-7";

const form = document.querySelector("#assistant-form");
const input = document.querySelector("#message-input");
const resetButton = document.querySelector("#reset-button");
const recordButton = document.querySelector("#record-button");
const speakToggle = document.querySelector("#speak-toggle");
const languageButtons = document.querySelectorAll("[data-response-language]");
const voiceStatus = document.querySelector("#voice-status");
const conversation = document.querySelector("#conversation");
const profileName = document.querySelector("#profile-name");
const profileBalance = document.querySelector("#profile-balance");
const profileIncome = document.querySelector("#profile-income");
const profileBudget = document.querySelector("#profile-budget");
const summaryTotal = document.querySelector("#summary-total");
const categoryList = document.querySelector("#category-list");
const expenseList = document.querySelector("#expense-list");
const wishlistList = document.querySelector("#wishlist-list");
const emailLogList = document.querySelector("#email-log-list");
const realtimeStatus = document.querySelector("#realtime-status");
const realtimeJobList = document.querySelector("#realtime-job-list");

const debugMode = new URLSearchParams(window.location.search).get("debug") === "1";
let responseLanguage = normalizeResponseLanguage(localStorage.getItem("responseLanguage") || "zh");
const formatters = new Map();
let activeRecorder = null;
let mapRenderSequence = 0;
let realtimeSocket = null;
let realtimeClientId = null;
const realtimeJobs = new Map();

loadState();
connectRealtime();
renderLanguageButtons();

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

languageButtons.forEach((button) => {
  button.addEventListener("click", () => {
    responseLanguage = normalizeResponseLanguage(button.dataset.responseLanguage);
    localStorage.setItem("responseLanguage", responseLanguage);
    renderLanguageButtons();
  });
});

realtimeJobList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-cancel-job]");

  if (!button) {
    return;
  }

  sendRealtimeMessage({
    type: "cancel_job",
    jobId: button.dataset.cancelJob
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
        speak: options.forceSpeech || speakToggle.checked,
        clientId: realtimeClientId,
        responseLanguage
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
          <div class="result-message">${renderAssistantMessage(error.message)}</div>
        </div>
      </article>
    `;
  } finally {
    setLoading(false);
  }
}

function connectRealtime() {
  if (!("WebSocket" in window)) {
    realtimeStatus.textContent = "WebSocket is not supported in this browser.";
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  realtimeSocket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  realtimeStatus.textContent = "Connecting...";

  realtimeSocket.addEventListener("open", () => {
    realtimeStatus.textContent = "Connected. Waiting for server id...";
  });

  realtimeSocket.addEventListener("message", (event) => {
    handleRealtimeEvent(JSON.parse(event.data));
  });

  realtimeSocket.addEventListener("close", () => {
    realtimeStatus.textContent = "Disconnected. Reconnecting...";
    setTimeout(connectRealtime, 1500);
  });

  realtimeSocket.addEventListener("error", () => {
    realtimeStatus.textContent = "WebSocket error. Retrying if connection closes.";
  });
}

function handleRealtimeEvent(event) {
  if (event.type === "ws_connected") {
    realtimeClientId = event.clientId;
    realtimeStatus.textContent = `Connected: ${event.clientId.slice(0, 8)}`;
    (event.jobs || []).forEach((job) => {
      realtimeJobs.set(job.id, job);
    });
    renderRealtimeJobs();
    return;
  }

  if (event.type === "job_started") {
    realtimeJobs.set(event.job.id, event.job);
    renderRealtimeJobs();
    return;
  }

  if (event.type === "job_progress") {
    const job = realtimeJobs.get(event.jobId) || {
      id: event.jobId,
      type: "job",
      label: "Background job",
      status: event.status || "running",
      events: []
    };

    job.status = event.status || job.status;
    job.events = [
      ...(job.events || []),
      {
        stage: event.stage,
        message: event.message,
        data: event.data,
        createdAt: event.createdAt
      }
    ].slice(-8);
    job.updatedAt = event.createdAt;

    if (event.stage === "places_search_done" && event.data?.mapPlaces?.length) {
      job.latestMapPlaces = event.data.mapPlaces;
      upsertDiscountInsightCard(event.jobId, {
        productQuery: event.data.productQuery || job.metadata?.productQuery || job.label || "Discount lookup",
        message: buildStoreDiscoveryMessage(event.data.mapPlaces.length),
        mapPlaces: event.data.mapPlaces,
        sources: [],
        statusLabel: responseLanguage === "en" ? "Store discovery" : "门店发现"
      });
    }

    realtimeJobs.set(job.id, job);
    renderRealtimeJobs();
    return;
  }

  if (event.type === "llm_token") {
    const job = realtimeJobs.get(event.jobId) || {
      id: event.jobId,
      type: "discount_lookup",
      label: "Background job",
      status: event.status || "running",
      events: []
    };

    job.status = event.status || job.status;
    job.streamingText = event.accumulatedText || `${job.streamingText || ""}${event.text || ""}`;
    job.updatedAt = event.createdAt;
    realtimeJobs.set(job.id, job);
    renderRealtimeJobs();

    updateDiscountInsightMessage(event.jobId, {
      productQuery: job.metadata?.productQuery || job.label || "Discount lookup",
      message: job.streamingText,
      statusLabel: "Streaming summary"
    });
    return;
  }

  if (["job_completed", "job_failed", "job_cancelled"].includes(event.type)) {
    const job = realtimeJobs.get(event.jobId) || {
      id: event.jobId,
      type: "job",
      label: "Background job",
      events: []
    };

    job.status = event.status;
    job.result = event.result || null;
    job.error = event.error || null;
    job.reason = event.reason || null;
    job.updatedAt = new Date().toISOString();
    realtimeJobs.set(job.id, job);
    renderRealtimeJobs();

    if (event.type === "job_completed" && event.result?.discountInsight) {
      upsertDiscountInsightCard(event.jobId, {
        ...event.result.discountInsight,
        statusLabel: "Discount insight"
      });
    }
  }
}

function sendRealtimeMessage(message) {
  if (!realtimeSocket || realtimeSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  realtimeSocket.send(JSON.stringify(message));
}

function renderLanguageButtons() {
  languageButtons.forEach((button) => {
    const isActive = button.dataset.responseLanguage === responseLanguage;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function normalizeResponseLanguage(value) {
  return value === "en" ? "en" : "zh";
}

function buildStoreDiscoveryMessage(mapPlaceCount) {
  if (responseLanguage === "en") {
    return `The background discount check is still running. I found ${mapPlaceCount} nearby store(s) first and updated the map; next I am checking official pages and grounding.`;
  }

  return `后台优惠查询正在继续。已先找到 ${mapPlaceCount} 个附近门店，地图已更新；接下来继续查官方页面和 grounding。`;
}

function renderRealtimeJobs() {
  const jobs = [...realtimeJobs.values()].sort((left, right) =>
    String(right.updatedAt || right.createdAt || "").localeCompare(
      String(left.updatedAt || left.createdAt || "")
    )
  );

  realtimeJobList.innerHTML = jobs.length
    ? jobs
        .slice(0, 6)
        .map((job) => renderRealtimeJob(job))
        .join("")
    : `<div class="realtime-empty">No live jobs yet.</div>`;
}

function renderRealtimeJob(job) {
  const latestEvent = (job.events || []).at(-1);
  const isRunning = job.status === "running";
  const statusText = job.error || job.reason || latestEvent?.message || job.status;

  return `
    <article class="realtime-job realtime-job-${escapeHtml(job.status || "unknown")}">
      <div class="realtime-job-main">
        <strong>${escapeHtml(job.label || job.type || "Background job")}</strong>
        <small>${escapeHtml(statusText || "")}</small>
      </div>
      <span class="realtime-pill">${escapeHtml(job.status || "unknown")}</span>
      ${
        isRunning
          ? `<button type="button" class="realtime-cancel" data-cancel-job="${escapeHtml(job.id)}">Cancel</button>`
          : ""
      }
      ${
        latestEvent?.data?.mapPlaces?.length
          ? `<small class="realtime-meta">${latestEvent.data.mapPlaces.length} map place(s) ready</small>`
          : ""
      }
    </article>
  `;
}

function upsertDiscountInsightCard(jobId, insight) {
  const mapPlaces = (insight.mapPlaces || []).map(normalizeMapPlace).filter(Boolean).slice(0, 8);
  const cardId = getDiscountCardId(jobId);
  const mapId = `${cardId}-map-${mapRenderSequence}`;
  mapRenderSequence += 1;
  const mapBlock = mapPlaces.length ? renderMapBlock(mapId, mapPlaces) : "";
  const sourceList = (insight.sources || [])
    .slice(0, 6)
    .map(
      (source) => `
        <li>
          <a href="${escapeHtml(source.uri)}" target="_blank" rel="noreferrer">
            ${escapeHtml(source.title || source.uri)}
          </a>
        </li>
      `
    )
    .join("");

  const html = `
      <article class="turn background-insight" id="${escapeHtml(cardId)}" data-job-id="${escapeHtml(jobId)}">
        <div class="turn-header">
          <p><strong>Background discount check:</strong> ${escapeHtml(insight.productQuery)}</p>
        </div>
        <div class="turn-body">
          <div class="result-message">
            <p class="result-label">${escapeHtml(insight.statusLabel || "Discount insight")}</p>
            ${renderAssistantMessage(insight.message)}
          </div>
          ${mapBlock}
          ${
            sourceList
              ? `
                <details class="source-details">
                  <summary>Sources</summary>
                  <div class="source-block">
                    <ul>${sourceList}</ul>
                  </div>
                </details>
              `
              : ""
          }
        </div>
      </article>
    `;
  const existingCard = document.getElementById(cardId);

  if (existingCard) {
    existingCard.outerHTML = html;
  } else {
    conversation.insertAdjacentHTML("beforeend", html);
  }

  if (mapPlaces.length) {
    requestAnimationFrame(() => renderPlacesMap(mapId, mapPlaces));
  }
}

function updateDiscountInsightMessage(jobId, insight) {
  const card = document.getElementById(getDiscountCardId(jobId));

  if (!card) {
    upsertDiscountInsightCard(jobId, {
      ...insight,
      mapPlaces: [],
      sources: []
    });
    return;
  }

  const messageElement = card.querySelector(".result-message");

  if (!messageElement) {
    return;
  }

  messageElement.innerHTML = `
    <p class="result-label">${escapeHtml(insight.statusLabel || "Discount insight")}</p>
    ${renderAssistantMessage(insight.message || "")}
  `;
}

function getDiscountCardId(jobId) {
  return `discount-card-${String(jobId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "")}`;
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
  const transcriptionDebug = debugMode
    ? `
        <details class="debug-full" open>
          <summary>Voice Transcription</summary>
          <pre>${escapeHtml(JSON.stringify(transcription, null, 2))}</pre>
        </details>
      `
    : "";

  conversation.innerHTML = `
    <article class="turn">
      <div class="turn-header">
        <p><strong>Voice input rejected</strong></p>
      </div>
      <div class="turn-body">
        <div class="result-message">
          <p class="result-label">Assistant response</p>
          ${renderAssistantMessage("Voice input supports English only. Please try again in English.")}
        </div>
        ${transcriptionDebug}
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
  const warning = debugMode && payload.parser.warning
    ? `<div class="warning">${escapeHtml(payload.parser.warning)}</div>`
    : "";
  const ttsWarning = debugMode && payload.speech?.warning
    ? `<div class="warning">${escapeHtml(payload.speech.warning)}</div>`
    : "";
  const audioBlock = payload.speech?.ok
    ? `
        <div class="assistant-audio">
          <p class="code-label">Audio Reply</p>
          <audio controls src="data:${escapeHtml(payload.speech.mimeType)};base64,${payload.speech.audioBase64}"></audio>
          ${
            debugMode
              ? `<small>${escapeHtml(payload.speech.model)} / ${escapeHtml(payload.speech.voiceName)}</small>`
              : ""
          }
        </div>
      `
    : "";
  const retailSearchBlock = debugMode && payload.result?.retailSearch
    ? renderRetailSearchBlock(payload.result.retailSearch)
    : "";
  const retailOffersBlock = debugMode && payload.result?.retailOffers
    ? renderRetailOffersBlock(payload.result.retailOffers)
    : "";
  const localDealsBlock = debugMode && payload.result?.localDeals
    ? renderLocalDealsBlock(payload.result.localDeals)
    : "";
  const debugBlocks = debugMode ? renderTurnDebugBlocks(payload) : "";
  const mapPlaces = collectMapPlaces(payload);
  const mapId = `places-map-${Date.now()}-${mapRenderSequence}`;
  mapRenderSequence += 1;
  const mapBlock = mapPlaces.length ? renderMapBlock(mapId, mapPlaces) : "";

  conversation.innerHTML = `
    <article class="turn">
      <div class="turn-header">
        <p><strong>You:</strong> ${escapeHtml(payload.input)}</p>
      </div>
      <div class="turn-body">
        <div class="result-message">
          <p class="result-label">Assistant response</p>
          ${renderAssistantMessage(payload.result.message)}
        </div>
        ${warning}
        ${ttsWarning}
        ${mapBlock}
        ${retailSearchBlock}
        ${retailOffersBlock}
        ${localDealsBlock}
        ${audioBlock}
        ${debugBlocks}
      </div>
    </article>
  `;

  if (mapPlaces.length) {
    requestAnimationFrame(() => renderPlacesMap(mapId, mapPlaces));
  }
}

function renderTurnDebugBlocks(payload) {
  const prompt = payload.debug?.promptSentToModel
    ? formatDebugValue(payload.debug.promptSentToModel)
    : "No prompt was sent.";
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
  const ttsDebugBlock = payload.speech?.debug
    ? `
        <details class="debug-full">
          <summary>10. Gemini TTS Debug</summary>
          <pre>${escapeHtml(JSON.stringify(payload.speech.debug, null, 2))}</pre>
        </details>
      `
    : "";
  const finalResponseDebugBlock = payload.finalResponse
    ? `
        <details class="debug-full" open>
          <summary>7. Final Response Synthesis</summary>
          <pre>${escapeHtml(JSON.stringify(payload.finalResponse, null, 2))}</pre>
        </details>
      `
    : "";
  const postActionDebugBlock = payload.postFunctionCall || payload.postExecutedAction || payload.postResult
    ? `
        <details class="debug-full" open>
          <summary>8. Post-Response Function Call</summary>
          <pre>${escapeHtml(
            JSON.stringify(
              {
                parser: payload.postParser,
                debug: payload.postDebug,
                functionCall: payload.postFunctionCall,
                executedAction: payload.postExecutedAction,
                result: payload.postResult
              },
              null,
              2
            )
          )}</pre>
        </details>
      `
    : "";
  const postFinalResponseDebugBlock = payload.postFinalResponse
    ? `
        <details class="debug-full" open>
          <summary>9. Post-Action Final Response Synthesis</summary>
          <pre>${escapeHtml(JSON.stringify(payload.postFinalResponse, null, 2))}</pre>
        </details>
      `
    : "";

  return `
    ${transcriptionBlock}
    <details class="debug-full" open>
      <summary>1. User Input</summary>
      <pre>${escapeHtml(payload.input)}</pre>
    </details>
    <details class="debug-full" open>
      <summary>2. Input And System Instruction Sent To Gemini</summary>
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
      <p class="code-label">5. Function Call Selected By Gemini</p>
      <pre>${escapeHtml(JSON.stringify(payload.functionCall, null, 2))}</pre>
    </div>
    <div>
      <p class="code-label">6. App Function Call</p>
      <pre>${escapeHtml(JSON.stringify(payload.executedAction, null, 2))}</pre>
    </div>
    ${finalResponseDebugBlock}
    ${postActionDebugBlock}
    ${postFinalResponseDebugBlock}
    ${ttsDebugBlock}
  `;
}

function renderState(state) {
  profileName.textContent = state.profile.name;
  profileBalance.textContent = formatMoney(state.profile.currentBalance, state.profile.baseCurrency);
  profileIncome.textContent = formatMoney(state.profile.monthlyIncome, state.profile.baseCurrency);
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

  const emailLog = state.emailLog || [];
  emailLogList.innerHTML = emailLog.length
    ? emailLog
        .slice(0, 4)
        .map(
          (email) => `
            <div class="wishlist-row">
              <div class="expense-main">
                <strong>${escapeHtml(email.subject)}</strong>
                <small>${escapeHtml(email.to)} · ${escapeHtml(email.status)}</small>
              </div>
              <strong>${escapeHtml(email.provider)}</strong>
            </div>
          `
        )
        .join("")
    : `<div class="wishlist-row"><span>No email activity</span><strong>-</strong></div>`;
}

function renderRetailSearchBlock(retailSearch) {
  const sources = retailSearch.sources || [];
  const sourceList = sources.length
    ? sources
        .slice(0, 8)
        .map(
          (source) => `
            <li>
              <a href="${escapeHtml(source.uri)}" target="_blank" rel="noreferrer">
                ${escapeHtml(source.title || source.uri)}
              </a>
            </li>
          `
        )
        .join("")
    : "<li>No grounded source links returned.</li>";
  const queries = retailSearch.searchQueries?.length
    ? retailSearch.searchQueries.join(" | ")
    : "No search query metadata returned.";
  const channels = retailSearch.channels?.length
    ? retailSearch.channels
        .map((channel) => `${channel.channel || channel.provider}: ${channel.status || channel.provider}`)
        .join(" | ")
    : retailSearch.provider || "Unknown";
  const officialTerms = retailSearch.channels
    ?.flatMap((channel) => channel.officialSearchTerms || [])
    .filter(Boolean);
  const officialTermsLine = officialTerms?.length
    ? `<p><strong>Official terms:</strong> ${escapeHtml([...new Set(officialTerms)].join(" | "))}</p>`
    : "";

  return `
    <details class="debug-full" open>
      <summary>Retail Product Lookup Sources</summary>
      <div class="source-block">
        <p><strong>Channels:</strong> ${escapeHtml(channels)}</p>
        <p><strong>Retailers:</strong> ${escapeHtml(retailSearch.request?.retailerNames || "")}</p>
        <p><strong>Product:</strong> ${escapeHtml(retailSearch.request?.productQuery || "")}</p>
        <p><strong>Location:</strong> ${escapeHtml(retailSearch.request?.location || "")}</p>
        ${officialTermsLine}
        <p><strong>Search queries:</strong> ${escapeHtml(queries)}</p>
        <ul>${sourceList}</ul>
      </div>
    </details>
  `;
}

function renderRetailOffersBlock(retailOffers) {
  const sources = retailOffers.sources || [];
  const sourceList = sources.length
    ? sources
        .slice(0, 12)
        .map(
          (source) => `
            <li>
              <a href="${escapeHtml(source.uri)}" target="_blank" rel="noreferrer">
                ${escapeHtml(source.title || source.uri)}
              </a>
            </li>
          `
        )
        .join("")
    : "<li>No grounded source links returned.</li>";
  const queries = retailOffers.searchQueries?.length
    ? retailOffers.searchQueries.join(" | ")
    : "No search query metadata returned.";
  const channels = retailOffers.channels?.length
    ? retailOffers.channels
        .map((channel) => `${channel.channel || channel.provider}: ${channel.status || channel.provider}`)
        .join(" | ")
    : retailOffers.provider || "Unknown";
  const officialPages = retailOffers.channels
    ?.flatMap((channel) => channel.officialOfferPages || [])
    .filter((page) => page.uri)
    .slice(0, 8);
  const officialPageList = officialPages?.length
    ? `
        <p><strong>Official pages:</strong></p>
        <ul>
          ${officialPages
            .map(
              (page) => `
                <li>
                  <a href="${escapeHtml(page.uri)}" target="_blank" rel="noreferrer">
                    ${escapeHtml(page.title || page.uri)}
                  </a>
                </li>
              `
            )
            .join("")}
        </ul>
      `
    : "";

  return `
    <details class="debug-full" open>
      <summary>Retail Offers Lookup Sources</summary>
      <div class="source-block">
        <p><strong>Channels:</strong> ${escapeHtml(channels)}</p>
        <p><strong>Retailers:</strong> ${escapeHtml(retailOffers.request?.retailerNames || "")}</p>
        <p><strong>Location:</strong> ${escapeHtml(retailOffers.request?.location || "")}</p>
        <p><strong>Period:</strong> ${escapeHtml(retailOffers.request?.period || "")}</p>
        <p><strong>Search queries:</strong> ${escapeHtml(queries)}</p>
        ${officialPageList}
        <p><strong>Sources:</strong></p>
        <ul>${sourceList}</ul>
      </div>
    </details>
  `;
}

function renderLocalDealsBlock(localDeals) {
  const sources = localDeals.sources || [];
  const sourceList = sources.length
    ? sources
        .slice(0, 12)
        .map(
          (source) => `
            <li>
              <a href="${escapeHtml(source.uri)}" target="_blank" rel="noreferrer">
                ${escapeHtml(source.title || source.uri)}
              </a>
            </li>
          `
        )
        .join("")
    : "<li>No grounded source links returned.</li>";
  const queries = localDeals.searchQueries?.length
    ? localDeals.searchQueries.join(" | ")
    : "No search query metadata returned.";
  const channels = localDeals.channels?.length
    ? localDeals.channels
        .map((channel) => `${channel.channel || channel.provider}: ${channel.status || channel.provider}`)
        .join(" | ")
    : localDeals.provider || "Unknown";

  return `
    <details class="debug-full" open>
      <summary>Local Deal Lookup Sources</summary>
      <div class="source-block">
        <p><strong>Channels:</strong> ${escapeHtml(channels)}</p>
        <p><strong>Merchant:</strong> ${escapeHtml(localDeals.request?.merchantQuery || "")}</p>
        <p><strong>Location:</strong> ${escapeHtml(localDeals.request?.location || "")}</p>
        <p><strong>Period:</strong> ${escapeHtml(localDeals.request?.period || "")}</p>
        <p><strong>Search queries:</strong> ${escapeHtml(queries)}</p>
        <p><strong>Sources:</strong></p>
        <ul>${sourceList}</ul>
      </div>
    </details>
  `;
}

function collectMapPlaces(payload) {
  const places = [
    ...(payload.result?.mapPlaces || []),
    ...(payload.result?.retailSearch?.mapPlaces || []),
    ...(payload.result?.retailOffers?.mapPlaces || []),
    ...(payload.result?.localDeals?.mapPlaces || [])
  ]
    .map(normalizeMapPlace)
    .filter(Boolean);
  const deduped = dedupeMapPlaces(places);
  const responseText = String(payload.result?.message || "").toLowerCase();
  const mentionedPlaces = deduped.filter((place) => {
    const name = String(place.name || "").toLowerCase();
    const address = String(place.address || "").toLowerCase();

    return (
      (name && responseText.includes(name)) ||
      (address && responseText.includes(address)) ||
      (address && responseText.includes(address.split(",")[0]))
    );
  });

  return (mentionedPlaces.length ? mentionedPlaces : deduped).slice(0, 12);
}

function normalizeMapPlace(place) {
  const latitude = Number.parseFloat(place?.latitude);
  const longitude = Number.parseFloat(place?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    placeId: place.placeId || "",
    name: place.name || "Place",
    address: place.address || "",
    latitude,
    longitude,
    googleMapsUri: place.googleMapsUri || "",
    websiteUri: place.websiteUri || "",
    sourceUrl: place.sourceUrl || place.googleMapsUri || place.websiteUri || ""
  };
}

function dedupeMapPlaces(places) {
  const seen = new Set();
  const deduped = [];

  for (const place of places) {
    const key =
      place.placeId ||
      `${place.name.toLowerCase()}|${place.address.toLowerCase()}|${place.latitude.toFixed(5)},${place.longitude.toFixed(5)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(place);
  }

  return deduped;
}

function renderMapBlock(mapId, places) {
  const placeList = places
    .map(
      (place, index) => `
        <li>
          <span class="map-place-index">${index + 1}</span>
          <div>
            <strong>${escapeHtml(place.name)}</strong>
            ${place.address ? `<small>${escapeHtml(place.address)}</small>` : ""}
            ${
              place.googleMapsUri
                ? `<a href="${escapeHtml(place.googleMapsUri)}" target="_blank" rel="noreferrer">Open in Google Maps</a>`
                : ""
            }
          </div>
        </li>
      `
    )
    .join("");

  return `
    <section class="map-panel" aria-label="Places mentioned in this answer">
      <div class="map-header">
        <p class="code-label">Places Map</p>
        <span>${places.length} place${places.length === 1 ? "" : "s"}</span>
      </div>
      <div class="places-map" id="${escapeHtml(mapId)}"></div>
      <ol class="map-place-list">${placeList}</ol>
    </section>
  `;
}

function renderPlacesMap(mapId, places) {
  const mapElement = document.getElementById(mapId);

  if (!mapElement || !window.L) {
    return;
  }

  const map = window.L.map(mapElement, {
    scrollWheelZoom: false
  });
  const markerPositions = [];

  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  places.forEach((place, index) => {
    const position = [place.latitude, place.longitude];
    const marker = window.L.marker(position).addTo(map);
    const link = place.googleMapsUri
      ? `<p><a href="${escapeHtml(place.googleMapsUri)}" target="_blank" rel="noreferrer">Open in Google Maps</a></p>`
      : "";

    marker.bindPopup(`
      <div class="map-popup">
        <strong>${index + 1}. ${escapeHtml(place.name)}</strong>
        ${place.address ? `<p>${escapeHtml(place.address)}</p>` : ""}
        ${link}
      </div>
    `);
    markerPositions.push(position);
  });

  if (markerPositions.length === 1) {
    map.setView(markerPositions[0], 14);
    return;
  }

  map.fitBounds(window.L.latLngBounds(markerPositions), {
    padding: [28, 28],
    maxZoom: 14
  });
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

function formatDebugValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
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
