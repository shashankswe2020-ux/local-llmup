import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const appUrl = process.argv[2] ?? "http://127.0.0.1:4173/";
const output = process.argv[3] ?? "assets/connectors.gif";
const framesDir = mkdtempSync(path.join(tmpdir(), "llmup-whoop-demo-"));
const outputPath = path.resolve(output);
const mirrors = [
  path.resolve("site/assets/connectors.gif"),
  path.resolve("apps/desktop/demos/connectors.gif"),
];
const expectedTools = ["get_today", "get_weekly_summary"];
const prompt = [
  "Call WHOOP get_today and get_weekly_summary for this week, once each.",
  "Then create a compact health briefing with actual values, a Markdown table, and three practical bullets.",
  "Do not call other tools.",
].join(" ");
const systemPrompt = [
  "You must call every tool the user explicitly requests before answering.",
  "For this request call get_today and get_weekly_summary exactly once each, and no other tools.",
  "Use the returned values to produce the requested concise health briefing.",
].join(" ");

let frame = 0;
let sessionId = null;

function framePath() {
  const name = `frame-${String(frame).padStart(3, "0")}.png`;
  frame += 1;
  return path.join(framesDir, name);
}

async function capture(page, count) {
  const image = await page.screenshot({ animations: "disabled" });
  for (let index = 0; index < count; index += 1) {
    const target = framePath();
    mkdirSync(path.dirname(target), { recursive: true });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(target, image));
  }
}

async function deleteSession(page) {
  const failed = await page.evaluate(async ({ id, title }) => {
    const token = globalThis.document.querySelector('meta[name="llmup-token"]')?.getAttribute("content") ?? "";
    const listResponse = await fetch("/api/sessions");
    if (!listResponse.ok) return [listResponse.status];
    const sessions = await listResponse.json();
    const matches = sessions.sessions.filter((session) => session.id === id || session.title === title);
    const responses = await Promise.all(matches.map((session) => fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "DELETE",
      headers: { "X-LLMUP-Token": token },
    })));
    return responses.filter((response) => !response.ok).map((response) => response.status);
  }, { id: sessionId, title: prompt });
  if (failed.length > 0) {
    throw new Error(`failed to delete demo session: HTTP ${failed.join(", ")}`);
  }
}

let browser = null;
let page = null;

try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1000, height: 756 }, deviceScaleFactor: 1 });
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.addStyleTag({
    content: ".rail-session-item:not(.active), .msg-metrics { display: none !important; }",
  });
  await page.locator('[data-view="connectors"]').click();
  const whoop = page.locator(".connector-card").filter({ hasText: "WHOOP" }).first();
  await whoop.locator(".connector-status-connected").waitFor({ timeout: 30_000 });
  await whoop.scrollIntoViewIfNeeded();
  await capture(page, 5);

  await page.locator('[data-view="chat"]').click();
  const newChat = page.locator("#session-new");
  if (await newChat.isVisible()) {
    await newChat.click();
    await page.locator(".message").waitFor({ state: "detached" }).catch(() => {});
  }
  sessionId = await page.locator(".rail-session-item.active").getAttribute("data-session-id");
  await page.locator("#system-prompt-toggle").click();
  await page.locator("#system-prompt-input").fill(systemPrompt);
  await page.locator("#temperature-input").evaluate((element) => {
    element.value = "0";
    element.dispatchEvent(new element.ownerDocument.defaultView.Event("input", { bubbles: true }));
  });
  await page.locator("#system-prompt-toggle").click();

  const composer = page.locator("#prompt");
  for (let length = 0; length <= prompt.length; length += 16) {
    await composer.fill(prompt.slice(0, length));
    await capture(page, 1);
  }
  await composer.fill(prompt);
  await capture(page, 3);
  await composer.press("Enter");

  const approvedTools = new Set();
  while (approvedTools.size < expectedTools.length) {
    const approval = page.locator(".tool-card.awaiting").last();
    const approve = approval.getByRole("button", { name: "Approve" });
    await approve.waitFor({ timeout: 180_000 });
    const title = await approval.locator(".tool-card-title").textContent();
    const toolName = expectedTools.find((name) => title?.includes(name));
    if (toolName === undefined || approvedTools.has(toolName)) {
      throw new Error(`unexpected WHOOP tool proposal: ${title ?? "unknown"}`);
    }
    await approval.scrollIntoViewIfNeeded();
    await capture(page, 5);
    await approve.click();
    const completed = page.locator(".tool-card").filter({ hasText: `Used ${toolName}` }).first();
    await completed.getByText(`Used ${toolName}`, { exact: false }).waitFor({ timeout: 180_000 });
    approvedTools.add(toolName);
    await completed.scrollIntoViewIfNeeded();
    await capture(page, 2);
  }

  const assistant = page.locator(".message.assistant").last();
  await assistant.waitFor({ state: "visible", timeout: 180_000 });
  await page.waitForFunction(() => {
    const rows = [...globalThis.document.querySelectorAll(".message.assistant")];
    return rows.length > 0 && !rows.at(-1)?.classList.contains("streaming");
  }, undefined, { timeout: 180_000 });
  if (approvedTools.size !== expectedTools.length) {
    throw new Error(`expected ${expectedTools.length} WHOOP calls, received ${approvedTools.size}`);
  }
  await assistant.scrollIntoViewIfNeeded();
  await capture(page, 12);

  mkdirSync(path.dirname(outputPath), { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-framerate", "4", "-i", path.join(framesDir, "frame-%03d.png"),
    "-vf", "split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer",
    "-loop", "0", outputPath,
  ], { stdio: "inherit" });
  for (const mirror of mirrors) {
    mkdirSync(path.dirname(mirror), { recursive: true });
    cpSync(outputPath, mirror);
  }
  console.log(`recorded ${frame} frames to ${outputPath}`);
} finally {
  try {
    if (page !== null) {
      await deleteSession(page);
    }
  } finally {
    try {
      if (browser !== null) {
        await browser.close();
      }
    } finally {
      rmSync(framesDir, { recursive: true, force: true });
    }
  }
}