import { runAccessibleReadOnlyScreen, type AccessibleReadOnlyOutcome } from "./read-only-accessible.js";
import { createBoundedCookedLineReader } from "./cooked-line-reader.js";
import type { UiModeSelection } from "./capabilities.js";
import type { MountReadOnlyScreenOptions, ReadOnlyRendererSession } from "./read-only-renderer.js";
import type { CommandViewModelMap } from "./types.js";

export interface ReadOnlyPresentationOptions<
  Result,
  K extends keyof CommandViewModelMap,
> {
  readonly screen: K;
  readonly mode: UiModeSelection & { readonly mode: "tui" | "accessible" };
  readonly collect: () => Promise<Result> | Result;
  readonly buildViewModel: (result: Result) => CommandViewModelMap[K];
  readonly formatPlain: (result: Result) => string;
}

interface VisualRendererModule {
  readonly mountReadOnlyScreen: (
    options: MountReadOnlyScreenOptions,
  ) => ReadOnlyRendererSession;
}

type AccessiblePresentationInput = {
  readonly [K in keyof CommandViewModelMap]: {
    readonly screen: K;
    readonly viewModel: CommandViewModelMap[K];
    readonly explicit: boolean;
    readonly stdin: NodeJS.ReadStream;
    readonly stderr: NodeJS.WriteStream;
  };
}[keyof CommandViewModelMap];

export interface ReadOnlyPresentationDeps {
  readonly stdin: NodeJS.ReadStream;
  readonly stderr: NodeJS.WriteStream;
  readonly loadVisualRenderer: () => Promise<VisualRendererModule>;
  readonly runAccessible: (
    options: AccessiblePresentationInput,
  ) => Promise<AccessibleReadOnlyOutcome>;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

export type ReadOnlyPresentationOutcome<Result> = {
  readonly type: "completed";
  readonly result: Result;
};

async function runDefaultAccessible(
  options: AccessiblePresentationInput,
): Promise<AccessibleReadOnlyOutcome> {
  const reader = createBoundedCookedLineReader(options.stdin, 256);
  try {
    return await runAccessibleReadOnlyScreen({
      ...options,
      readLine: reader.readLine,
      write: (text) => options.stderr.write(text),
    });
  } finally {
    reader.close();
  }
}

const defaultDeps: ReadOnlyPresentationDeps = {
  stdin: process.stdin,
  stderr: process.stderr,
  loadVisualRenderer: () => import("./read-only-renderer.js"),
  runAccessible: runDefaultAccessible,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

/** Execute one read-only command once, render interactively, then emit one final stdout result. */
export async function runReadOnlyPresentation<
  Result,
  K extends keyof CommandViewModelMap,
>(
  options: ReadOnlyPresentationOptions<Result, K>,
  deps: ReadOnlyPresentationDeps = defaultDeps,
): Promise<ReadOnlyPresentationOutcome<Result>> {
  let visualRenderer: VisualRendererModule | undefined;
  if (options.mode.mode === "tui") {
    try {
      visualRenderer = await deps.loadVisualRenderer();
    } catch (error) {
      if (options.mode.explicit) throw error;
      const result = await options.collect();
      deps.writeStderr(
        "local-llmup: interactive UI unavailable (renderer_init); continuing in plain mode\n",
      );
      deps.writeStdout(options.formatPlain(result));
      return { type: "completed", result };
    }
  }

  const result = await options.collect();
  const viewModel = options.buildViewModel(result);

  if (options.mode.mode === "accessible") {
    try {
      await deps.runAccessible({
        screen: options.screen,
        viewModel,
        explicit: options.mode.explicit,
        stdin: deps.stdin,
        stderr: deps.stderr,
      } as AccessiblePresentationInput);
    } catch {
      deps.writeStderr(
        "local-llmup: interactive UI failed (renderer_runtime); terminal restored; final result follows\n",
      );
    }
  } else {
    let session: ReadOnlyRendererSession | undefined;
    let rendererFailed = false;
    try {
      session = visualRenderer?.mountReadOnlyScreen({
        screen: options.screen,
        viewModel,
        stdin: deps.stdin,
        stderr: deps.stderr,
        color: options.mode.color,
        unicode: options.mode.unicode,
        explicit: options.mode.explicit,
        onPrintCommand: () => undefined,
      } as MountReadOnlyScreenOptions);
      if (session === undefined) throw new Error("visual renderer did not mount");
      await session.waitUntilExit();
    } catch {
      rendererFailed = true;
    } finally {
      session?.unmount();
    }
    if (rendererFailed) {
      deps.writeStderr(
        "local-llmup: interactive UI failed (renderer_runtime); terminal restored; final result follows\n",
      );
    }
  }

  deps.writeStdout(options.formatPlain(result));
  return { type: "completed", result };
}
