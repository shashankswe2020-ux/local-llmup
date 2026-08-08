import { render, type Instance } from "ink";
import {
  CanRunScreen,
  CatalogScreen,
  DoctorScreen,
  LsScreen,
  RecommendScreen,
  type ReadOnlyScreenStyle,
} from "./screens/read-only.js";
import type { CommandViewModelMap } from "./types.js";

export type ReadOnlyScreenName = keyof CommandViewModelMap;

export type MountReadOnlyScreenOptions = {
  readonly [K in ReadOnlyScreenName]: {
    readonly screen: K;
    readonly viewModel: CommandViewModelMap[K];
    readonly stdin: NodeJS.ReadStream;
    readonly stderr: NodeJS.WriteStream;
    readonly color: boolean;
    readonly unicode: boolean;
    readonly explicit: boolean;
    readonly onPrintCommand?: ((command: string) => void) | undefined;
  };
}[ReadOnlyScreenName];

export interface ReadOnlyRendererSession {
  unmount(): void;
  waitUntilExit(): Promise<void>;
}

function ReadOnlyApp(options: MountReadOnlyScreenOptions): JSX.Element {
  const style: ReadOnlyScreenStyle = {
    color: options.color,
    unicode: options.unicode,
    columns: Math.max(40, options.stderr.columns ?? 80),
    rows: Math.max(10, options.stderr.rows ?? 24),
  };
  switch (options.screen) {
    case "recommend":
      return (
        <RecommendScreen
          viewModel={options.viewModel}
          style={style}
          actions={{ onPrintCommand: options.onPrintCommand }}
        />
      );
    case "canRun":
      return <CanRunScreen viewModel={options.viewModel} style={style} />;
    case "doctor":
      return <DoctorScreen viewModel={options.viewModel} style={style} />;
    case "catalog":
      return <CatalogScreen viewModel={options.viewModel} style={style} />;
    case "ls":
      return <LsScreen viewModel={options.viewModel} style={style} explicit={options.explicit} />;
  }
}

/** Mount one read-only Ink screen against injected streams. */
export function mountReadOnlyScreen(
  options: MountReadOnlyScreenOptions,
): ReadOnlyRendererSession {
  const instance: Instance = render(<ReadOnlyApp {...options} />, {
    stdin: options.stdin,
    stdout: options.stderr,
    stderr: options.stderr,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  let unmounted = false;
  let finalized = false;
  let resolveUnmount: (() => void) | undefined;
  const manualUnmount = new Promise<void>((resolve) => {
    resolveUnmount = resolve;
  });
  const inkExit = instance.waitUntilExit();
  inkExit.catch(() => undefined);
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    instance.cleanup();
  };

  return {
    unmount: (): void => {
      if (unmounted) return;
      unmounted = true;
      instance.unmount();
      finalize();
      resolveUnmount?.();
    },
    waitUntilExit: async (): Promise<void> => {
      try {
        await Promise.race([inkExit, manualUnmount]);
      } finally {
        finalize();
      }
    },
  };
}
