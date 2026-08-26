document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("#chat-form");
  const prompt = document.querySelector("#prompt");
  const messages = document.querySelector("#messages");
  const modelSelect = document.querySelector("#model-select");
  const harnessSelect = document.querySelector("#harness-select");
  const backendStatus = document.querySelector("#backend-status");
  const endpointStatus = document.querySelector("#endpoint-status");
  const turnCount = document.querySelector("#turn-count");
  const modelCard = document.querySelector("#model-card");
  const refreshStatus = document.querySelector("#refresh-status");
  const activeOwnership = document.querySelector("#active-ownership");
  const recommendedList = document.querySelector("#recommended-list");
  const modelError = document.querySelector("#model-error");
  const activeBanner = document.querySelector("#active-model-banner");
  const refreshModels = document.querySelector("#refresh-models");
  const sessionCurrent = document.querySelector("#session-current");
  const sessionTurns = document.querySelector("#session-turns");
  const navItems = document.querySelectorAll(".nav-item[data-view]");
  const views = document.querySelectorAll(".view");

  if (!form || !prompt || !messages) {
    return;
  }

  function addMessage(role, content) {
    const row = document.createElement("div");
    row.className = `message ${role}`;
    row.textContent = content;
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
  }

  function setStatusPanel(status) {
    if (backendStatus) {
      backendStatus.textContent = status.harness ?? "local";
    }
    if (endpointStatus && status.endpoint) {
      endpointStatus.textContent = String(status.endpoint).replace(/^https?:\/\//, "");
    }
    const turns = status.memory?.turns ?? 0;
    if (turnCount) {
      turnCount.textContent = String(turns);
    }
    if (sessionTurns) {
      sessionTurns.textContent = `${turns} ${turns === 1 ? "turn" : "turns"}`;
    }
  }

  async function loadStatus() {
    try {
      const response = await globalThis.fetch("/api/status");
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const status = await response.json();
      setStatusPanel(status);
    } catch {
      if (backendStatus) {
        backendStatus.textContent = "offline";
      }
      if (endpointStatus) {
        endpointStatus.textContent = "127.0.0.1:11434";
      }
    }
  }

  async function loadHarnesses() {
    if (!harnessSelect) {
      return;
    }

    try {
      const response = await globalThis.fetch("/api/harnesses");
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      const harnesses = Array.isArray(data.harnesses) ? data.harnesses : [];
      harnessSelect.innerHTML = "";
      for (const harness of harnesses) {
        const option = document.createElement("option");
        option.value = harness;
        option.textContent = harness;
        harnessSelect.appendChild(option);
      }
      const active = document.querySelector("#backend-status");
      if (active && active.textContent) {
        harnessSelect.value = active.textContent;
      }
    } catch {
      // Ignore harness-load failures; local mode remains a valid fallback.
    }
  }

  async function loadHistory() {
    try {
      const response = await globalThis.fetch("/api/history");
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      const history = Array.isArray(data.history) ? data.history : [];
      messages.innerHTML = "";
      for (const item of history) {
        if (item && item.role && item.content) {
          addMessage(item.role, `${item.role === "user" ? "You" : "Assistant"}: ${item.content}`);
        }
      }
    } catch {
      // Ignore stale history failures.
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = prompt.value.trim();
    if (!value) {
      return;
    }

    addMessage("user", `You: ${value}`);
    prompt.value = "";

    const requestModel = modelSelect && modelSelect.value ? modelSelect.value : "demo-model";

    const response = await globalThis.fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: requestModel,
        messages: [{ role: "user", content: value }],
      }),
    });

    if (!response.ok || !response.body) {
      addMessage("system", "Request failed.");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new globalThis.TextDecoder();
    let reply = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      const lines = text.split("\n\n");
      for (const line of lines) {
        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice("data:".length).trim();
        if (!payload) {
          continue;
        }
        const event = JSON.parse(payload);
        if (event.type === "delta") {
          reply += event.content;
          const current = messages.lastElementChild;
          if (current && current.classList.contains("assistant")) {
            current.textContent = `Assistant: ${reply}`;
          } else {
            const last = document.createElement("div");
            last.className = "message assistant";
            last.textContent = `Assistant: ${reply}`;
            messages.appendChild(last);
            messages.scrollTop = messages.scrollHeight;
          }
        }
        if (event.type === "done") {
          await loadStatus();
          return;
        }
        if (event.type === "error") {
          addMessage("system", `Error: ${event.message}`);
          return;
        }
      }
    }
  });

  if (harnessSelect) {
    harnessSelect.addEventListener("change", async () => {
      const value = harnessSelect.value;
      if (!value) {
        return;
      }
      await globalThis.fetch("/api/harness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ harness: value }),
      });
      await loadStatus();
    });
  }

  if (refreshStatus) {
    refreshStatus.addEventListener("click", async () => {
      await loadStatus();
      await loadActive();
      await loadHistory();
      await loadHarnesses();
    });
  }

  if (sessionCurrent) {
    sessionCurrent.addEventListener("click", async () => {
      switchView("chat");
      await loadHistory();
      await loadStatus();
    });
  }

  function switchView(view) {
    for (const item of navItems) {
      item.classList.toggle("active", item.dataset.view === view);
    }
    for (const section of views) {
      section.classList.toggle("active", section.id === `view-${view}`);
    }
    if (view === "models") {
      loadModels();
    }
  }

  for (const item of navItems) {
    item.addEventListener("click", () => switchView(item.dataset.view));
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "unknown";
    }
    const gb = bytes / 1024 ** 3;
    if (gb >= 1) {
      return `${gb.toFixed(1)} GB`;
    }
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  function formatThroughput(throughput) {
    if (!throughput || !throughput.known) {
      return "unknown";
    }
    return `${throughput.lowTokPerSec}–${throughput.highTokPerSec} tok/s`;
  }

  function ensureModelOption(id) {
    if (!modelSelect || !id) {
      return;
    }
    const exists = Array.from(modelSelect.options).some((option) => option.value === id);
    if (!exists) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      modelSelect.appendChild(option);
    }
  }

  function renderActive(active) {
    if (modelCard) {
      modelCard.textContent = active ? active.modelId : "No model running";
    }
    if (activeOwnership) {
      if (active) {
        activeOwnership.hidden = false;
        activeOwnership.textContent = active.ownership === "owned" ? "started by workspace" : "attached";
        activeOwnership.dataset.ownership = active.ownership;
      } else {
        activeOwnership.hidden = true;
      }
    }
    if (activeBanner) {
      if (active) {
        activeBanner.hidden = false;
        activeBanner.textContent = `${active.modelId} is running on ${active.backend} at ${active.endpoint}`;
      } else {
        activeBanner.hidden = true;
      }
    }
    if (active && endpointStatus && active.endpoint) {
      endpointStatus.textContent = String(active.endpoint).replace(/^https?:\/\//, "");
    }
    if (active) {
      ensureModelOption(active.modelId);
      if (modelSelect) {
        modelSelect.value = active.modelId;
      }
    }
  }

  function verdictLabel(verdict) {
    if (verdict === "yes") {
      return "Runs well";
    }
    if (verdict === "slow") {
      return "Runs slowly";
    }
    return "Won't fit";
  }

  async function startModel(id, button) {
    if (modelError) {
      modelError.hidden = true;
    }
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Starting…";
    try {
      const response = await globalThis.fetch("/api/models/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `request failed (${response.status})`);
      }
      renderActive(data.active);
      switchView("chat");
      await loadStatus();
    } catch (error) {
      if (modelError) {
        modelError.hidden = false;
        modelError.textContent = `Could not start ${id}: ${error.message}`;
      }
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function renderRecommended(models, active) {
    if (!recommendedList) {
      return;
    }
    recommendedList.innerHTML = "";
    if (!models.length) {
      const empty = document.createElement("div");
      empty.className = "recommended-empty";
      empty.textContent = "No recommended models for this machine.";
      recommendedList.appendChild(empty);
      return;
    }
    for (const model of models) {
      ensureModelOption(model.id);
      const isActive = active && active.modelId === model.id;
      const card = document.createElement("article");
      card.className = "model-card-item";

      const head = document.createElement("div");
      head.className = "model-card-head";
      const title = document.createElement("div");
      title.className = "model-card-title";
      title.textContent = model.id;
      const badge = document.createElement("span");
      badge.className = `verdict-badge verdict-${model.verdict}`;
      badge.textContent = verdictLabel(model.verdict);
      head.appendChild(title);
      head.appendChild(badge);

      const meta = document.createElement("div");
      meta.className = "model-card-meta";
      meta.textContent = `${model.params} · ${model.quant} · ${formatSize(model.diskBytes)} · ${formatThroughput(model.throughput)}`;

      const actions = document.createElement("div");
      actions.className = "model-card-actions";
      const button = document.createElement("button");
      button.type = "button";
      if (isActive) {
        button.textContent = "Running";
        button.disabled = true;
      } else {
        button.textContent = model.verdict === "no" ? "Start anyway" : "Start";
        button.addEventListener("click", () => startModel(model.id, button));
      }
      actions.appendChild(button);

      card.appendChild(head);
      card.appendChild(meta);
      card.appendChild(actions);
      recommendedList.appendChild(card);
    }
  }

  async function loadActive() {
    try {
      const response = await globalThis.fetch("/api/models/active");
      if (!response.ok) {
        return null;
      }
      const data = await response.json();
      renderActive(data.active);
      return data.active;
    } catch {
      return null;
    }
  }

  async function loadModels() {
    if (modelError) {
      modelError.hidden = true;
    }
    const active = await loadActive();
    if (!recommendedList) {
      return;
    }
    try {
      const response = await globalThis.fetch("/api/models/recommended");
      if (!response.ok) {
        throw new Error(`request failed (${response.status})`);
      }
      const data = await response.json();
      const models = Array.isArray(data.models) ? data.models : [];
      renderRecommended(models, active);
    } catch (error) {
      recommendedList.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "recommended-empty";
      empty.textContent = `Could not load recommendations: ${error.message}`;
      recommendedList.appendChild(empty);
    }
  }

  if (refreshModels) {
    refreshModels.addEventListener("click", () => loadModels());
  }

  loadStatus();
  loadHistory();
  loadHarnesses();
  loadActive();
});
