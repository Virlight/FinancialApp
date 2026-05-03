const form = document.querySelector("#assistant-form");
const input = document.querySelector("#message-input");
const resetButton = document.querySelector("#reset-button");
const conversation = document.querySelector("#conversation");
const profileName = document.querySelector("#profile-name");
const profileBalance = document.querySelector("#profile-balance");
const profileBudget = document.querySelector("#profile-budget");
const summaryTotal = document.querySelector("#summary-total");
const categoryList = document.querySelector("#category-list");
const expenseList = document.querySelector("#expense-list");

const formatters = new Map();

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
        Demo 数据已重置。输入一句自然语言请求，重新验证链路。
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

async function runAssistant(message) {
  setLoading(true);

  try {
    const response = await fetch("/api/assistant", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || payload.error || "Request failed");
    }

    renderTurn(payload);
    renderState(payload.state);
    input.value = "";
  } catch (error) {
    conversation.innerHTML = `
      <article class="turn">
        <div class="turn-header">
          <p><strong>执行失败</strong></p>
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

async function loadState() {
  const response = await fetch("/api/state");
  const state = await response.json();
  renderState(state);
}

function renderTurn(payload) {
  const warning = payload.parser.warning
    ? `<div class="warning">${escapeHtml(payload.parser.warning)}</div>`
    : "";
  const prompt = payload.debug?.promptSentToModel || "No prompt was sent.";
  const rawModelOutput = payload.debug?.rawModelOutput || "No raw model output.";
  const outputContract = payload.debug?.modelOutputContract
    ? JSON.stringify(payload.debug.modelOutputContract, null, 2)
    : "No output contract.";

  conversation.innerHTML = `
    <article class="turn">
      <div class="turn-header">
        <p><strong>用户输入：</strong>${escapeHtml(payload.input)}</p>
        <p><strong>Parser：</strong>${escapeHtml(payload.parser.provider)} / ${escapeHtml(payload.parser.model)}</p>
      </div>
      <div class="turn-body">
        <div class="result-message">${escapeHtml(payload.result.message)}</div>
        ${warning}
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
            <small>${escapeHtml(expense.category)} · ${escapeHtml(expense.date)}</small>
          </div>
          <strong>${formatMoney(expense.amount, expense.currency)}</strong>
        </div>
      `
    )
    .join("");
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
