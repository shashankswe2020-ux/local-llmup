import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { CommandName } from "../../src/cli.js";

const FIXTURE_ROOT = new URL("./noninteractive/", import.meta.url);
const PINNED_ENV = {
  TZ: "UTC",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm-256color",
} as const;

export const PLAIN_NONINTERACTIVE_FIXTURES: Readonly<Record<CommandName, string>> = {
  recommend: "recommend-plain.txt",
  "can-run": "can-run-plain.txt",
  up: "up-plain.txt",
  chat: "chat-plain.txt",
  down: "down-plain.txt",
  switch: "switch-plain.txt",
  migrate: "migrate-plain.txt",
  ls: "ls-plain.txt",
  catalog: "catalog-plain.txt",
  doctor: "doctor-plain.txt",
};

export const JSON_NONINTERACTIVE_FIXTURES = {
  recommend: "recommend-json.json",
  "can-run": "can-run-json.json",
  doctor: "doctor-json.json",
} as const satisfies Partial<Record<CommandName, string>>;

function fixtureUrl(name: string): URL {
  if (!/^[a-z0-9-]+\.(?:txt|json|encoded\.json)$/u.test(name)) {
    throw new Error(`invalid noninteractive fixture name: ${name}`);
  }
  return new URL(name, FIXTURE_ROOT);
}

export function plainGoldenName(command: CommandName): string {
  return PLAIN_NONINTERACTIVE_FIXTURES[command];
}

export function jsonGoldenName(command: keyof typeof JSON_NONINTERACTIVE_FIXTURES): string {
  return JSON_NONINTERACTIVE_FIXTURES[command];
}

export function noninteractiveFixtureExists(name: string): boolean {
  return existsSync(fixtureUrl(name));
}

export async function withGoldenEnvironment<T>(action: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(PINNED_ENV)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function expectNoninteractiveGolden(name: string, actual: string): void {
  const url = fixtureUrl(name);
  if (process.env.UPDATE_NONINTERACTIVE_GOLDENS === "1") {
    mkdirSync(dirname(fileURLToPath(url)), { recursive: true });
    writeFileSync(url, name.endsWith(".encoded.json") ? `${JSON.stringify(actual)}\n` : actual, "utf8");
  }

  if (!existsSync(url)) {
    throw new Error(
      `missing noninteractive fixture ${name}; review output and run with UPDATE_NONINTERACTIVE_GOLDENS=1`,
    );
  }
  const stored = readFileSync(url, "utf8");
  const expected: unknown = name.endsWith(".encoded.json") ? JSON.parse(stored) : stored;
  if (typeof expected !== "string") {
    throw new Error(`noninteractive fixture ${name} must decode to a string`);
  }
  expect(actual).toBe(expected);
}
