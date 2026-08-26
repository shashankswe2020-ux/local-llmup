document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("#chat-form");
  const prompt = document.querySelector("#prompt");
  const messages = document.querySelector("#messages");
  const modelSelect = document.querySelector("#model-select");
  const harnessSelect = document.querySelector("#harness-select");
  const runtimeSelect = document.querySelector("#runtime-select");
  const runtimeStatus = document.querySelector("#runtime-status");
  const stageTitle = document.querySelector("#stage-title");
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
  const connectorForm = document.querySelector("#connector-form");
  const connectorTransport = document.querySelector("#connector-transport");
  const connectorStdioFields = document.querySelector("#connector-stdio-fields");
  const connectorHttpFields = document.querySelector("#connector-http-fields");
  const connectorList = document.querySelector("#connector-list");
  const connectorError = document.querySelector("#connector-error");
  const refreshConnectors = document.querySelector("#refresh-connectors");
  const connectorJson = document.querySelector("#connector-json");
  const connectorJsonReload = document.querySelector("#connector-json-reload");
  const connectorJsonApply = document.querySelector("#connector-json-apply");
  const connectorJsonStatus = document.querySelector("#connector-json-status");
  const hardwareStats = document.querySelector("#hardware-stats");
  const hardwareCard = document.querySelector("#hardware-card");
  const runtimeToggles = document.querySelector("#runtime-toggles");
  const runtimeError = document.querySelector("#runtime-error");
  const refreshRuntime = document.querySelector("#refresh-runtime");
  const agentSelect = document.querySelector("#agent-select");
  const skillChips = document.querySelector("#skill-chips");
  const agentSkillsPicker = document.querySelector("#agent-skills");
  const refreshLibrary = document.querySelector("#refresh-library");
  const agentForm = document.querySelector("#agent-form");
  const agentList = document.querySelector("#agent-list");
  const agentError = document.querySelector("#agent-error");
  const agentNew = document.querySelector("#agent-new");
  const agentCancel = document.querySelector("#agent-cancel");
  const skillForm = document.querySelector("#skill-form");
  const skillList = document.querySelector("#skill-list");
  const skillError = document.querySelector("#skill-error");
  const skillNew = document.querySelector("#skill-new");
  const skillCancel = document.querySelector("#skill-cancel");
  const navItems = document.querySelectorAll(".rail-item[data-view]");
  const views = document.querySelectorAll(".view");

  if (!form || !prompt || !messages) {
    return;
  }

  function roleLabel(role) {
    if (role === "user") {
      return "You";
    }
    if (role === "assistant") {
      return "Assistant";
    }
    return "System";
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Apply inline formatting to already HTML-escaped text. Only a fixed set of
  // safe tags is produced, and links are restricted to http(s) URLs, so model
  // output can never inject markup.
  function renderInline(escaped) {
    let out = escaped;
    // Inline images: ![alt](src). Rendered only for local artifact files and
    // inline data:image payloads; anything else falls back to its alt text.
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
      const safe = safeImageSrc(src);
      if (safe) {
        return `<img class="chat-image" src="${safe}" alt="${alt}" loading="lazy" />`;
      }
      return alt;
    });
    out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    return out;
  }

  // Resolve a markdown image src to a safe URL, or null to reject it. Only local
  // generated artifacts (served from /api/images) and inline data:image payloads
  // are allowed — never arbitrary remote or file URLs.
  function safeImageSrc(src) {
    const value = String(src).trim();
    if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)) {
      return value;
    }
    if (/^\/api\/images\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|gif|webp|svg)$/i.test(value)) {
      return value;
    }
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|gif|webp|svg)$/i.test(value)) {
      return `/api/images/${encodeURIComponent(value)}`;
    }
    return null;
  }

  // Minimal, XSS-safe Markdown renderer: escape first, then emit a fixed set of
  // block/inline tags. Handles fenced code, headings, ordered/unordered lists,
  // and paragraphs, tolerating an unclosed code fence mid-stream.
  function renderMarkdown(src) {
    const lines = src.split("\n");
    const html = [];
    let inCode = false;
    let codeLang = "";
    let codeLines = [];
    let listType = null;
    let listItems = [];
    let paragraph = [];

    const flushParagraph = () => {
      if (paragraph.length) {
        html.push(`<p>${renderInline(escapeHtml(paragraph.join(" ")))}</p>`);
        paragraph = [];
      }
    };
    const flushList = () => {
      if (listType) {
        const items = listItems.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join("");
        html.push(`<${listType}>${items}</${listType}>`);
        listType = null;
        listItems = [];
      }
    };
    const flushCode = () => {
      const code = escapeHtml(codeLines.join("\n"));
      const langAttr = codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : "";
      html.push(`<pre${langAttr}><code>${code}</code></pre>`);
      codeLines = [];
      codeLang = "";
    };

    for (const line of lines) {
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        if (inCode) {
          flushCode();
          inCode = false;
        } else {
          flushParagraph();
          flushList();
          inCode = true;
          codeLang = fence[1] || "";
        }
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      if (line.trim() === "") {
        flushParagraph();
        flushList();
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1].length;
        html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
        continue;
      }
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ul) {
        flushParagraph();
        if (listType && listType !== "ul") {
          flushList();
        }
        listType = "ul";
        listItems.push(ul[1]);
        continue;
      }
      if (ol) {
        flushParagraph();
        if (listType && listType !== "ol") {
          flushList();
        }
        listType = "ol";
        listItems.push(ol[1]);
        continue;
      }
      if (listType) {
        flushList();
      }
      paragraph.push(line.trim());
    }
    if (inCode) {
      flushCode();
    }
    flushParagraph();
    flushList();
    return html.join("");
  }

  // Add a "Copy" affordance to every rendered code block.
  function decorateCodeBlocks(container) {
    for (const pre of container.querySelectorAll("pre")) {
      if (pre.querySelector(".code-copy")) {
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy";
      button.textContent = "Copy";
      button.addEventListener("click", () => {
        const code = pre.querySelector("code");
        const text = code ? code.textContent : "";
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(
            () => {
              button.textContent = "Copied";
              setTimeout(() => {
                button.textContent = "Copy";
              }, 1200);
            },
            () => {},
          );
        }
      });
      pre.appendChild(button);
    }
  }

  function renderAssistantBody(body, text, streaming) {
    body.innerHTML = renderMarkdown(text);
    const row = body.closest(".message");
    if (row) {
      row.classList.toggle("streaming", Boolean(streaming));
    }
    if (!streaming) {
      decorateCodeBlocks(body);
    }
  }

  function addMessage(role, content) {
    const empty = messages.querySelector(".messages-empty");
    if (empty) {
      empty.remove();
    }
    const row = document.createElement("div");
    row.className = `message ${role}`;

    const label = document.createElement("div");
    label.className = "message-role";
    label.textContent = roleLabel(role);

    const body = document.createElement("div");
    body.className = "message-body";
    if (role === "user") {
      body.textContent = content;
    } else {
      renderAssistantBody(body, content, false);
    }

    row.append(label, body);
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
    return body;
  }

  function selectedRuntime() {
    return runtimeSelect && runtimeSelect.value ? runtimeSelect.value : "";
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

  async function loadRuntimes() {
    if (!runtimeSelect) {
      return;
    }
    try {
      const response = await globalThis.fetch("/api/runtimes");
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      const runtimes = Array.isArray(data.runtimes) ? data.runtimes : [];
      const previous = runtimeSelect.value;
      runtimeSelect.innerHTML = "";
      for (const runtime of runtimes) {
        const option = document.createElement("option");
        option.value = runtime;
        option.textContent = runtime;
        runtimeSelect.appendChild(option);
      }
      if (previous && runtimes.includes(previous)) {
        runtimeSelect.value = previous;
      }
      if (runtimeStatus && runtimeSelect.value) {
        runtimeStatus.textContent = runtimeSelect.value;
      }
    } catch {
      // Ignore runtime-load failures; recommendations fall back to the default runtime.
    }
  }

  function statRow(label, value) {
    const row = document.createElement("li");
    row.className = "stat-row";
    const key = document.createElement("span");
    key.className = "stat-label";
    key.textContent = label;
    const val = document.createElement("span");
    val.className = "stat-value";
    val.textContent = value;
    row.appendChild(key);
    row.appendChild(val);
    return row;
  }

  function gpuSummary(gpus) {
    if (!Array.isArray(gpus) || !gpus.length) {
      return "none detected";
    }
    return gpus
      .map((gpu) => {
        const vram = Number.isFinite(gpu.vramBytes) && gpu.vramBytes > 0 ? ` · ${formatSize(gpu.vramBytes)}` : "";
        return `${gpu.vendor}${vram}`;
      })
      .join(", ");
  }

  function renderHardware(hw) {
    const rows = [
      ["Platform", `${hw.platform} · ${hw.arch}`],
      ["RAM", `${formatSize(hw.freeRamBytes)} free / ${formatSize(hw.totalRamBytes)}`],
      ["GPU", gpuSummary(hw.gpu)],
      ["Disk free", formatSize(hw.freeDiskBytes)],
    ];
    for (const target of [hardwareStats, hardwareCard]) {
      if (!target) {
        continue;
      }
      target.innerHTML = "";
      for (const [label, value] of rows) {
        target.appendChild(statRow(label, value));
      }
    }
  }

  async function loadHardware() {
    if (!hardwareStats && !hardwareCard) {
      return;
    }
    try {
      const response = await globalThis.fetch("/api/hardware");
      if (!response.ok) {
        throw new Error(`request failed (${response.status})`);
      }
      const data = await response.json();
      if (data.hardware) {
        renderHardware(data.hardware);
      }
    } catch (error) {
      for (const target of [hardwareStats, hardwareCard]) {
        if (target) {
          target.innerHTML = "";
          target.appendChild(statRow("Hardware", `unavailable (${error.message})`));
        }
      }
    }
  }

  function runtimeStateLabel(runtime) {
    if (!runtime.installed) {
      return "Not installed";
    }
    if (runtime.running) {
      return runtime.ownedByUs ? "Running" : "Running (external)";
    }
    return "Stopped";
  }

  async function toggleRuntime(name, action, toggle) {
    if (runtimeError) {
      runtimeError.hidden = true;
    }
    toggle.setAttribute("aria-disabled", "true");
    toggle.classList.add("pending");
    const label = toggle.querySelector(".toggle-label");
    if (label) {
      label.textContent = action === "start" ? "Starting…" : "Stopping…";
    }
    try {
      const response = await globalThis.fetch(`/api/runtimes/${encodeURIComponent(name)}/${action}`, {
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `request failed (${response.status})`);
      }
      await loadRuntimeStatus();
    } catch (error) {
      if (runtimeError) {
        runtimeError.hidden = false;
        runtimeError.textContent = `Could not ${action} ${name}: ${error.message}`;
      }
      await loadRuntimeStatus();
    }
  }

  function renderRuntimeStatus(runtimes) {
    if (!runtimeToggles) {
      return;
    }
    runtimeToggles.innerHTML = "";
    if (!runtimes.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No runtimes detected.";
      runtimeToggles.appendChild(empty);
      return;
    }
    for (const runtime of runtimes) {
      const row = document.createElement("article");
      row.className = "runtime-row";

      const info = document.createElement("div");
      info.className = "runtime-info";
      const title = document.createElement("div");
      title.className = "runtime-name";
      title.textContent = runtime.name;
      const meta = document.createElement("div");
      meta.className = "runtime-meta";
      const endpoint = runtime.endpoint ? ` · ${String(runtime.endpoint).replace(/^https?:\/\//, "")}` : "";
      meta.textContent = `${runtimeStateLabel(runtime)}${endpoint}`;
      info.appendChild(title);
      info.appendChild(meta);
      if (runtime.detail) {
        const detail = document.createElement("div");
        detail.className = "runtime-detail";
        detail.textContent = runtime.detail;
        info.appendChild(detail);
      }

      const running = Boolean(runtime.running);
      // A running daemon can be toggled off (including a foreign one the server
      // stops after verifying ownership); a startable runtime can be toggled on.
      const interactive = running ? Boolean(runtime.canStop) : runtime.canStart && runtime.installed;
      const toggle = document.createElement("div");
      toggle.className = `toggle${running ? " on" : ""}${interactive ? "" : " disabled"}`;
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", running ? "true" : "false");
      if (!interactive) {
        toggle.setAttribute("aria-disabled", "true");
      }
      toggle.tabIndex = interactive ? 0 : -1;

      const track = document.createElement("span");
      track.className = "toggle-track";
      const thumb = document.createElement("span");
      thumb.className = "toggle-thumb";
      track.appendChild(thumb);
      const toggleLabel = document.createElement("span");
      toggleLabel.className = "toggle-label";
      toggleLabel.textContent = running ? "On" : "Off";
      toggle.appendChild(track);
      toggle.appendChild(toggleLabel);

      const fire = () => {
        if (toggle.getAttribute("aria-disabled") === "true") {
          return;
        }
        toggleRuntime(runtime.name, running ? "stop" : "start", toggle);
      };
      if (interactive) {
        toggle.addEventListener("click", fire);
        toggle.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            fire();
          }
        });
      }

      row.appendChild(info);
      row.appendChild(toggle);
      runtimeToggles.appendChild(row);
    }
  }

  async function loadRuntimeStatus() {
    if (!runtimeToggles) {
      return;
    }
    try {
      const response = await globalThis.fetch("/api/runtimes/status");
      if (!response.ok) {
        throw new Error(`request failed (${response.status})`);
      }
      const data = await response.json();
      renderRuntimeStatus(Array.isArray(data.runtimes) ? data.runtimes : []);
    } catch (error) {
      runtimeToggles.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = `Could not load runtimes: ${error.message}`;
      runtimeToggles.appendChild(empty);
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
          addMessage(item.role, item.content);
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

    addMessage("user", value);
    prompt.value = "";

    const requestModel = modelSelect && modelSelect.value ? modelSelect.value : "demo-model";

    const response = await globalThis.fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: requestModel,
        messages: [{ role: "user", content: value }],
        ...(agentSelect && agentSelect.value ? { agentId: agentSelect.value } : {}),
        ...(selectedSkills.size > 0 ? { skillIds: Array.from(selectedSkills) } : {}),
      }),
    });

    if (!response.ok || !response.body) {
      addMessage("system", "Request failed.");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new globalThis.TextDecoder();
    let reply = "";
    let assistantBody = null;
    const pendingTools = [];

    function nearBottom() {
      return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
    }

    function autoScroll(force) {
      if (force || nearBottom()) {
        messages.scrollTop = messages.scrollHeight;
      }
    }

    function addToolActivity(name) {
      const empty = messages.querySelector(".messages-empty");
      if (empty) {
        empty.remove();
      }
      const row = document.createElement("div");
      row.className = "tool-activity running";
      const dot = document.createElement("span");
      dot.className = "tool-dot";
      const text = document.createElement("span");
      text.className = "tool-text";
      text.textContent = `Calling ${name}`;
      row.append(dot, text);
      messages.appendChild(row);
      autoScroll(true);
      return { row, text };
    }

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
        if (event.type === "tool") {
          if (event.phase === "start") {
            pendingTools.push({ name: event.name, ...addToolActivity(event.name) });
          } else {
            const idx = pendingTools.findIndex((p) => p.name === event.name);
            if (idx !== -1) {
              const [{ row, text }] = pendingTools.splice(idx, 1);
              row.classList.remove("running");
              if (event.isError) {
                row.classList.add("error");
                text.textContent = `${event.name} failed`;
              } else {
                row.classList.add("done");
                text.textContent = `Used ${event.name}`;
              }
            }
          }
          continue;
        }
        if (event.type === "delta") {
          reply += event.content;
          if (!assistantBody) {
            assistantBody = addMessage("assistant", "");
          }
          renderAssistantBody(assistantBody, reply, true);
          autoScroll(false);
        }
        if (event.type === "done") {
          if (assistantBody) {
            renderAssistantBody(assistantBody, reply, false);
          }
          await loadStatus();
          return;
        }
        if (event.type === "error") {
          if (assistantBody) {
            renderAssistantBody(assistantBody, reply, false);
          }
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

  if (runtimeSelect) {
    runtimeSelect.addEventListener("change", async () => {
      if (runtimeStatus && runtimeSelect.value) {
        runtimeStatus.textContent = runtimeSelect.value;
      }
      await loadModels();
    });
  }

  if (refreshStatus) {
    refreshStatus.addEventListener("click", async () => {
      await loadStatus();
      await loadActive();
      await loadHistory();
      await loadHarnesses();
      await loadRuntimes();
      await loadLibrary();
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
    const titles = { chat: "Chat", models: "Models", connectors: "Connectors", library: "Agents & Skills", tools: "Runtime" };
    for (const item of navItems) {
      item.classList.toggle("active", item.dataset.view === view);
    }
    for (const section of views) {
      section.classList.toggle("active", section.id === `view-${view}`);
    }
    if (stageTitle && titles[view]) {
      stageTitle.textContent = titles[view];
    }
    if (view === "models") {
      loadModels();
    }
    if (view === "connectors") {
      loadConnectors();
    }
    if (view === "library") {
      loadLibrary();
    }
    if (view === "tools") {
      loadHardware();
      loadRuntimeStatus();
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
    if (active && active.backend) {
      if (runtimeStatus) {
        runtimeStatus.textContent = active.backend;
      }
      if (runtimeSelect && Array.from(runtimeSelect.options).some((option) => option.value === active.backend)) {
        runtimeSelect.value = active.backend;
      }
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

  async function startModel(id, button, backend) {
    if (modelError) {
      modelError.hidden = true;
    }
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Starting…";
    try {
      const payload = backend ? { model: id, backend } : { model: id };
      const response = await globalThis.fetch("/api/models/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
      const backends = Array.isArray(model.backends) ? model.backends : [];
      let backendSelect = null;
      if (backends.length > 1) {
        backendSelect = document.createElement("select");
        backendSelect.className = "model-backend-select";
        backendSelect.setAttribute("aria-label", `Runtime for ${model.id}`);
        const auto = document.createElement("option");
        auto.value = "";
        auto.textContent = "Auto";
        backendSelect.appendChild(auto);
        for (const name of backends) {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          backendSelect.appendChild(option);
        }
        actions.appendChild(backendSelect);
      }
      const button = document.createElement("button");
      button.type = "button";
      if (isActive) {
        button.textContent = "Running";
        button.disabled = true;
      } else {
        button.textContent = model.verdict === "no" ? "Start anyway" : "Start";
        button.addEventListener("click", () =>
          startModel(model.id, button, backendSelect ? backendSelect.value : ""),
        );
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
      const runtime = selectedRuntime();
      const query = runtime ? `?runtime=${encodeURIComponent(runtime)}` : "";
      const response = await globalThis.fetch(`/api/models/recommended${query}`);
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

  if (refreshRuntime) {
    refreshRuntime.addEventListener("click", () => {
      loadHardware();
      loadRuntimeStatus();
    });
  }

  function connectorStatusLabel(status) {
    if (status === "connected") {
      return "Connected";
    }
    if (status === "connecting") {
      return "Connecting…";
    }
    if (status === "error") {
      return "Error";
    }
    return "Disconnected";
  }

  function renderConnectors(connectors) {
    if (!connectorList) {
      return;
    }
    connectorList.innerHTML = "";
    if (!connectors.length) {
      const empty = document.createElement("div");
      empty.className = "recommended-empty";
      empty.textContent = "No connectors yet. Add one above.";
      connectorList.appendChild(empty);
      return;
    }
    for (const connector of connectors) {
      const card = document.createElement("article");
      card.className = "connector-card";

      const head = document.createElement("div");
      head.className = "connector-card-head";
      const title = document.createElement("div");
      title.className = "connector-card-title";
      title.textContent = connector.name;
      const badge = document.createElement("span");
      badge.className = `connector-status connector-status-${connector.status}`;
      badge.textContent = connectorStatusLabel(connector.status);
      head.appendChild(title);
      head.appendChild(badge);

      const meta = document.createElement("div");
      meta.className = "connector-card-meta";
      meta.textContent = `${connector.transport} · ${connector.target}`;

      card.appendChild(head);
      card.appendChild(meta);

      if (connector.error) {
        const err = document.createElement("div");
        err.className = "connector-card-error";
        err.textContent = connector.error;
        card.appendChild(err);
      }

      if (connector.tools && connector.tools.length) {
        const tools = document.createElement("div");
        tools.className = "connector-tools";
        for (const tool of connector.tools) {
          const chip = document.createElement("span");
          chip.className = "connector-tool-chip";
          chip.textContent = tool.name;
          if (tool.description) {
            chip.title = tool.description;
          }
          tools.appendChild(chip);
        }
        card.appendChild(tools);
      }

      const actions = document.createElement("div");
      actions.className = "connector-card-actions";

      const connected = connector.status === "connected";
      const connecting = connector.status === "connecting";
      const toggle = document.createElement("div");
      toggle.className = `toggle${connected ? " on" : ""}${connecting ? " pending" : ""}`;
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", connected ? "true" : "false");
      if (connecting) {
        toggle.setAttribute("aria-disabled", "true");
      }
      toggle.tabIndex = 0;

      const track = document.createElement("span");
      track.className = "toggle-track";
      const thumb = document.createElement("span");
      thumb.className = "toggle-thumb";
      track.appendChild(thumb);

      const toggleLabel = document.createElement("span");
      toggleLabel.className = "toggle-label";
      toggleLabel.textContent = connecting ? "Connecting…" : connected ? "Connected" : "Disconnected";

      toggle.appendChild(track);
      toggle.appendChild(toggleLabel);

      const fireToggle = () => {
        if (toggle.getAttribute("aria-disabled") === "true") {
          return;
        }
        connectorAction(connector.id, connected ? "disconnect" : "connect", toggle);
      };
      toggle.addEventListener("click", fireToggle);
      toggle.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          fireToggle();
        }
      });
      actions.appendChild(toggle);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "connector-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removeConnector(connector.id, remove));
      actions.appendChild(remove);

      card.appendChild(actions);
      connectorList.appendChild(card);
    }
  }

  async function loadConnectors() {
    if (!connectorList) {
      return;
    }
    try {
      const response = await globalThis.fetch("/api/connectors");
      if (!response.ok) {
        throw new Error(`request failed (${response.status})`);
      }
      const data = await response.json();
      renderConnectors(Array.isArray(data.connectors) ? data.connectors : []);
      loadConnectorConfig(false);
    } catch (error) {
      connectorList.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "recommended-empty";
      empty.textContent = `Could not load connectors: ${error.message}`;
      connectorList.appendChild(empty);
    }
  }

  async function connectorAction(id, action, toggle) {
    if (connectorError) {
      connectorError.hidden = true;
    }
    toggle.setAttribute("aria-disabled", "true");
    toggle.classList.add("pending");
    const label = toggle.querySelector(".toggle-label");
    if (label) {
      label.textContent = action === "connect" ? "Connecting…" : "Disconnecting…";
    }
    try {
      const response = await globalThis.fetch(`/api/connectors/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `request failed (${response.status})`);
      }
      await loadConnectors();
    } catch (error) {
      if (connectorError) {
        connectorError.hidden = false;
        connectorError.textContent = `Could not ${action}: ${error.message}`;
      }
      await loadConnectors();
    }
  }

  async function removeConnector(id, button) {
    if (connectorError) {
      connectorError.hidden = true;
    }
    button.disabled = true;
    try {
      const response = await globalThis.fetch(`/api/connectors/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `request failed (${response.status})`);
      }
      await loadConnectors();
    } catch (error) {
      if (connectorError) {
        connectorError.hidden = false;
        connectorError.textContent = `Could not remove: ${error.message}`;
      }
      button.disabled = false;
    }
  }

  let connectorJsonDirty = false;

  function setConnectorJsonStatus(message, kind) {
    if (!connectorJsonStatus) {
      return;
    }
    if (!message) {
      connectorJsonStatus.hidden = true;
      connectorJsonStatus.textContent = "";
      connectorJsonStatus.classList.remove("banner-error", "banner-success");
      return;
    }
    connectorJsonStatus.hidden = false;
    connectorJsonStatus.textContent = message;
    connectorJsonStatus.classList.toggle("banner-error", kind === "error");
    connectorJsonStatus.classList.toggle("banner-success", kind === "success");
  }

  async function loadConnectorConfig(force) {
    if (!connectorJson) {
      return;
    }
    // Never clobber edits the user is in the middle of typing.
    if (!force && connectorJsonDirty) {
      return;
    }
    try {
      const response = await globalThis.fetch("/api/connectors/config");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `request failed (${response.status})`);
      }
      connectorJson.value = JSON.stringify(data.config ?? {}, null, 2);
      connectorJsonDirty = false;
      if (force) {
        setConnectorJsonStatus("");
      }
    } catch (error) {
      setConnectorJsonStatus(`Could not load config: ${error.message}`, "error");
    }
  }

  async function applyConnectorConfig() {
    if (!connectorJson) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(connectorJson.value);
    } catch (error) {
      setConnectorJsonStatus(`Invalid JSON: ${error.message}`, "error");
      return;
    }
    if (connectorJsonApply) {
      connectorJsonApply.disabled = true;
    }
    try {
      const response = await globalThis.fetch("/api/connectors/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `request failed (${response.status})`);
      }
      const count = Array.isArray(data.connectors) ? data.connectors.length : 0;
      connectorJsonDirty = false;
      setConnectorJsonStatus(`Applied — ${count} connector${count === 1 ? "" : "s"} saved.`, "success");
      await loadConnectors();
      await loadConnectorConfig(true);
    } catch (error) {
      setConnectorJsonStatus(`Could not apply: ${error.message}`, "error");
    } finally {
      if (connectorJsonApply) {
        connectorJsonApply.disabled = false;
      }
    }
  }

  if (connectorJson) {
    connectorJson.addEventListener("input", () => {
      connectorJsonDirty = true;
      setConnectorJsonStatus("");
    });
  }

  if (connectorJsonReload) {
    connectorJsonReload.addEventListener("click", () => loadConnectorConfig(true));
  }

  if (connectorJsonApply) {
    connectorJsonApply.addEventListener("click", () => applyConnectorConfig());
  }

  function updateConnectorFields() {
    if (!connectorTransport) {
      return;
    }
    const isStdio = connectorTransport.value === "stdio";
    if (connectorStdioFields) {
      connectorStdioFields.hidden = !isStdio;
    }
    if (connectorHttpFields) {
      connectorHttpFields.hidden = isStdio;
    }
  }

  if (connectorTransport) {
    connectorTransport.addEventListener("change", updateConnectorFields);
    updateConnectorFields();
  }

  if (refreshConnectors) {
    refreshConnectors.addEventListener("click", () => loadConnectors());
  }

  if (connectorForm) {
    connectorForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (connectorError) {
        connectorError.hidden = true;
      }
      const name = (document.querySelector("#connector-name")?.value || "").trim();
      const transport = connectorTransport ? connectorTransport.value : "stdio";
      let payload;
      if (transport === "http") {
        const url = (document.querySelector("#connector-url")?.value || "").trim();
        payload = { name, transport: "http", url };
      } else {
        const command = (document.querySelector("#connector-command")?.value || "").trim();
        const argsRaw = (document.querySelector("#connector-args")?.value || "").trim();
        const args = argsRaw.length ? argsRaw.split(/\s+/) : [];
        payload = { name, transport: "stdio", command, args };
      }
      try {
        const response = await globalThis.fetch("/api/connectors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || `request failed (${response.status})`);
        }
        connectorForm.reset();
        updateConnectorFields();
        await loadConnectors();
      } catch (error) {
        if (connectorError) {
          connectorError.hidden = false;
          connectorError.textContent = `Could not add connector: ${error.message}`;
        }
      }
    });
  }

  if (prompt) {
    const autoGrow = () => {
      prompt.style.height = "auto";
      prompt.style.height = `${Math.min(prompt.scrollHeight, 240)}px`;
    };
    prompt.addEventListener("input", autoGrow);
    prompt.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
  }

  const selectedSkills = new Set();
  let agentsCache = [];
  let skillsCache = [];

  function libraryPath(kind) {
    return kind === "agent" ? "/api/agents" : "/api/skills";
  }

  function libraryEls(kind) {
    return kind === "agent"
      ? { form: agentForm, list: agentList, error: agentError, id: "#agent-edit-id", name: "#agent-name", desc: "#agent-desc", body: "#agent-body", enabled: "#agent-enabled" }
      : { form: skillForm, list: skillList, error: skillError, id: "#skill-edit-id", name: "#skill-name", desc: "#skill-desc", body: "#skill-body", enabled: "#skill-enabled" };
  }

  function setLibraryError(kind, message) {
    const els = libraryEls(kind);
    if (!els.error) return;
    if (!message) {
      els.error.hidden = true;
      els.error.textContent = "";
      return;
    }
    els.error.hidden = false;
    els.error.textContent = message;
  }

  function renderLibraryList(kind, items) {
    const listEl = libraryEls(kind).list;
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = `No ${kind}s yet. Create one to use it in chat.`;
      listEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const card = document.createElement("article");
      card.className = "library-card";

      const head = document.createElement("div");
      head.className = "library-card-head";
      const title = document.createElement("div");
      title.className = "library-card-title";
      title.textContent = item.name;
      const badge = document.createElement("span");
      badge.className = `library-badge library-badge-${item.enabled ? "on" : "off"}`;
      badge.textContent = item.enabled ? "Enabled" : "Disabled";
      head.appendChild(title);
      head.appendChild(badge);
      card.appendChild(head);

      if (item.description) {
        const desc = document.createElement("div");
        desc.className = "library-card-desc";
        desc.textContent = item.description;
        card.appendChild(desc);
      }

      const actions = document.createElement("div");
      actions.className = "library-card-actions";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "ghost-btn";
      toggle.textContent = item.enabled ? "Disable" : "Enable";
      toggle.addEventListener("click", () => toggleLibraryItem(kind, item));

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ghost-btn";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => openLibraryEditor(kind, item));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "connector-remove";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => deleteLibraryItem(kind, item));

      actions.appendChild(toggle);
      actions.appendChild(edit);
      actions.appendChild(remove);
      card.appendChild(actions);
      listEl.appendChild(card);
    }
  }

  function renderAgentSkillsPicker(selectedIds) {
    if (!agentSkillsPicker) return;
    agentSkillsPicker.innerHTML = "";
    if (!skillsCache.length) {
      const empty = document.createElement("span");
      empty.className = "chip-empty";
      empty.textContent = "No skills yet — create a skill first.";
      agentSkillsPicker.appendChild(empty);
      return;
    }
    const chosen = new Set(selectedIds || []);
    for (const skill of skillsCache) {
      const label = document.createElement("label");
      label.className = "agent-skill-option";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = skill.id;
      box.checked = chosen.has(skill.id);
      const text = document.createElement("span");
      text.textContent = skill.name;
      label.appendChild(box);
      label.appendChild(text);
      agentSkillsPicker.appendChild(label);
    }
  }

  function openLibraryEditor(kind, item) {
    const els = libraryEls(kind);
    if (!els.form) return;
    els.form.hidden = false;
    document.querySelector(els.id).value = item ? item.id : "";
    document.querySelector(els.name).value = item ? item.name : "";
    document.querySelector(els.desc).value = item ? item.description : "";
    document.querySelector(els.body).value = item ? item.body : "";
    document.querySelector(els.enabled).checked = item ? item.enabled : true;
    if (kind === "agent") renderAgentSkillsPicker(item ? item.skills : []);
    setLibraryError(kind, "");
    document.querySelector(els.name).focus();
  }

  function closeLibraryEditor(kind) {
    const els = libraryEls(kind);
    if (els.form) els.form.hidden = true;
    setLibraryError(kind, "");
  }

  async function fetchLibrary(kind) {
    const response = await globalThis.fetch(libraryPath(kind));
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    const data = await response.json();
    return Array.isArray(data.items) ? data.items : [];
  }

  async function loadLibrary() {
    try {
      agentsCache = await fetchLibrary("agent");
    } catch {
      agentsCache = [];
    }
    try {
      skillsCache = await fetchLibrary("skill");
    } catch {
      skillsCache = [];
    }
    renderLibraryList("agent", agentsCache);
    renderLibraryList("skill", skillsCache);
    populateChatLibrary();
  }

  async function submitLibrary(kind, event) {
    event.preventDefault();
    const els = libraryEls(kind);
    const name = (document.querySelector(els.name)?.value || "").trim();
    if (!name) {
      setLibraryError(kind, "A name is required.");
      return;
    }
    const id = (document.querySelector(els.id)?.value || "").trim();
    const payload = {
      name,
      description: (document.querySelector(els.desc)?.value || "").trim(),
      body: document.querySelector(els.body)?.value || "",
      enabled: Boolean(document.querySelector(els.enabled)?.checked),
    };
    if (kind === "agent" && agentSkillsPicker) {
      payload.skills = Array.from(agentSkillsPicker.querySelectorAll("input[type=checkbox]"))
        .filter((box) => box.checked)
        .map((box) => box.value);
    }
    try {
      const response = await globalThis.fetch(
        id ? `${libraryPath(kind)}/${encodeURIComponent(id)}` : libraryPath(kind),
        {
          method: id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `request failed (${response.status})`);
      }
      closeLibraryEditor(kind);
      await loadLibrary();
    } catch (error) {
      setLibraryError(kind, `Could not save: ${error.message}`);
    }
  }

  async function toggleLibraryItem(kind, item) {
    try {
      const response = await globalThis.fetch(`${libraryPath(kind)}/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !item.enabled }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `request failed (${response.status})`);
      }
      await loadLibrary();
    } catch (error) {
      setLibraryError(kind, `Could not update: ${error.message}`);
    }
  }

  async function deleteLibraryItem(kind, item) {
    try {
      const response = await globalThis.fetch(`${libraryPath(kind)}/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `request failed (${response.status})`);
      }
      if (kind === "skill") selectedSkills.delete(item.id);
      if (kind === "agent" && agentSelect && agentSelect.value === item.id) agentSelect.value = "";
      await loadLibrary();
    } catch (error) {
      setLibraryError(kind, `Could not delete: ${error.message}`);
    }
  }

  function populateChatLibrary() {
    const enabledAgents = agentsCache.filter((a) => a.enabled);
    if (agentSelect) {
      const previous = agentSelect.value;
      agentSelect.innerHTML = "";
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "No agent";
      agentSelect.appendChild(none);
      for (const agent of enabledAgents) {
        const option = document.createElement("option");
        option.value = agent.id;
        option.textContent = agent.name;
        agentSelect.appendChild(option);
      }
      agentSelect.value = enabledAgents.some((a) => a.id === previous) ? previous : "";
    }

    const enabledSkills = skillsCache.filter((s) => s.enabled);
    for (const id of Array.from(selectedSkills)) {
      if (!enabledSkills.some((s) => s.id === id)) selectedSkills.delete(id);
    }
    if (skillChips) {
      skillChips.innerHTML = "";
      if (!enabledSkills.length) {
        const empty = document.createElement("span");
        empty.className = "chip-empty";
        empty.textContent = "No skills";
        skillChips.appendChild(empty);
      } else {
        for (const skill of enabledSkills) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = `skill-chip${selectedSkills.has(skill.id) ? " active" : ""}`;
          chip.textContent = skill.name;
          if (skill.description) chip.title = skill.description;
          chip.addEventListener("click", () => {
            if (selectedSkills.has(skill.id)) selectedSkills.delete(skill.id);
            else selectedSkills.add(skill.id);
            chip.classList.toggle("active");
          });
          skillChips.appendChild(chip);
        }
      }
    }
  }

  if (refreshLibrary) refreshLibrary.addEventListener("click", () => loadLibrary());
  if (agentNew) agentNew.addEventListener("click", () => openLibraryEditor("agent"));
  if (agentCancel) agentCancel.addEventListener("click", () => closeLibraryEditor("agent"));
  if (agentForm) agentForm.addEventListener("submit", (event) => submitLibrary("agent", event));
  if (skillNew) skillNew.addEventListener("click", () => openLibraryEditor("skill"));
  if (skillCancel) skillCancel.addEventListener("click", () => closeLibraryEditor("skill"));
  if (skillForm) skillForm.addEventListener("submit", (event) => submitLibrary("skill", event));
  if (agentSelect) {
    agentSelect.addEventListener("change", () => {
      const agent = agentsCache.find((a) => a.id === agentSelect.value);
      if (agent) {
        for (const skillId of agent.skills) {
          if (skillsCache.some((s) => s.id === skillId && s.enabled)) selectedSkills.add(skillId);
        }
      }
      populateChatLibrary();
    });
  }

  loadStatus();
  loadHistory();
  loadHarnesses();
  loadRuntimes();
  loadActive();
  loadHardware();
  loadLibrary();
});
