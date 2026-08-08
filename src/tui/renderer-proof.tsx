import { Text, render, useApp, useInput, type Instance } from "ink";

export interface RendererProofOptions {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly onExit?: (() => void) | undefined;
}

export interface RendererProofSession {
  unmount(): void;
  waitUntilExit(): Promise<void>;
}

function ProofApp({ onExit }: { readonly onExit?: (() => void) | undefined }): JSX.Element {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input !== "q" && !(key.ctrl && input === "c")) return;
    onExit?.();
    exit();
  });
  return <Text>renderer proof · q exits</Text>;
}

/**
 * Mount the approved Ink runtime against injected streams for dependency proof.
 * Product commands do not import this module; U1 will add capability-gated lazy loading.
 */
export function mountRendererProof(options: RendererProofOptions): RendererProofSession {
  const instance: Instance = render(<ProofApp onExit={options.onExit} />, {
    stdin: options.stdin,
    stdout: options.stdout,
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
