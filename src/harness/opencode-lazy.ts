import type { ChatHarness, HarnessChatRequest } from "./adapter.js";
import type { OpenCodeHarnessOptions } from "./opencode.js";

const UNAVAILABLE_HINT = "OpenCode is unavailable. Install `opencode` and ensure it is on PATH.";

let cached: Promise<ChatHarness> | undefined;

async function loadHarness(options: OpenCodeHarnessOptions): Promise<ChatHarness> {
  if (cached === undefined) {
    cached = import("./opencode.js").then(({ createOpenCodeHarness }) =>
      createOpenCodeHarness(options),
    );
  }
  return cached;
}

// A tiny facade so registering the OpenCode harness does not eagerly pull in
// zod, node:child_process, and node:stream; the real module loads on first use.
export function createLazyOpenCodeHarness(options: OpenCodeHarnessOptions = {}): ChatHarness {
  return {
    name: "opencode",
    unavailableHint: UNAVAILABLE_HINT,
    async isAvailable(): Promise<boolean> {
      return (await loadHarness(options)).isAvailable();
    },
    chat(request: HarnessChatRequest): AsyncIterable<string> {
      return {
        async *[Symbol.asyncIterator]() {
          const harness = await loadHarness(options);
          yield* harness.chat(request);
        },
      };
    },
    async chatSync(request: HarnessChatRequest): Promise<string> {
      return (await loadHarness(options)).chatSync(request);
    },
  };
}
