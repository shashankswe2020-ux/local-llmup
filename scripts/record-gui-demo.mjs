// Zero-dependency GUI demo recorder.
// Drives a headless Chrome instance over the DevTools Protocol to capture a
// sequence of frames of the local-llmup browser workspace, then hands the raw
// PNG frames to ffmpeg (invoked by the shell wrapper) to build an animated GIF.
//
// Usage: node scripts/record-gui-demo.mjs <cdpPort> <appUrl> <framesDir>
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const [, , cdpPort, appUrl, framesDir] = process.argv;
if (!cdpPort || !appUrl || !framesDir) {
  console.error("usage: record-gui-demo.mjs <cdpPort> <appUrl> <framesDir>");
  process.exit(1);
}

mkdirSync(framesDir, { recursive: true });

async function cdpTarget() {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(appUrl)}`, {
    method: "PUT",
  });
  if (!res.ok) {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("no CDP page target available");
    return page;
  }
  return res.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const target = await cdpTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

const cdp = new Cdp(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 2,
  mobile: false,
});

let frameIndex = 0;
async function capture(holdMs = 1500) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const name = `${framesDir}/frame-${String(frameIndex).padStart(2, "0")}.png`;
  writeFileSync(name, Buffer.from(data, "base64"));
  // Repeat the same frame to hold it on screen in the final GIF.
  for (let i = 1; i < Math.round(holdMs / 500); i++) {
    frameIndex++;
    writeFileSync(`${framesDir}/frame-${String(frameIndex).padStart(2, "0")}.png`, Buffer.from(data, "base64"));
  }
  frameIndex++;
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
}

await cdp.send("Page.navigate", { url: appUrl });
await sleep(3500); // let status + recommendations load

// Frame 1: chat workspace landing
await capture(2000);

// Frame 2: open the Models view (recommended local models)
await evaluate(`(() => {
  const items = [...document.querySelectorAll('.nav-item, [data-view]')];
  const target = items.find((el) => /models/i.test(el.textContent || ''));
  if (target) target.click();
  return Boolean(target);
})()`);
await sleep(1800);
await capture(2500);

// Frame 3: type a prompt into the composer, back on the chat view
await evaluate(`(() => {
  const items = [...document.querySelectorAll('.nav-item, [data-view]')];
  const chat = items.find((el) => /chat/i.test(el.textContent || ''));
  if (chat) chat.click();
  return true;
})()`);
await sleep(800);
await evaluate(`(() => {
  const box = document.querySelector('#prompt');
  if (box) {
    box.value = 'Summarize what local-llmup does in one sentence.';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
  }
  return Boolean(box);
})()`);
await sleep(600);
await capture(2500);

ws.close();
console.log(`captured ${frameIndex} frames into ${framesDir}`);
process.exit(0);
