/** Shared constants for the Playwright browser journeys (task 32.13). */
import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_PORT = Number(process.env.E2E_PORT ?? "4321");
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
/** A throwaway workspace the boot server populates and tests register as a root. */
export const E2E_WORKSPACE_DIR = join(tmpdir(), "llmup-e2e-workspace");
/** A throwaway local-llmup home for sessions and edit records. */
export const E2E_HOME_DIR = join(tmpdir(), "llmup-e2e-home");
