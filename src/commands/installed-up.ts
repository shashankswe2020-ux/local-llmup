import { buildEndpoint, DEFAULT_BIND_HOST } from "../backend/adapter.js";
import { ValidationError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import { STATE_SCHEMA_VERSION } from "../state/state.js";
import {
  assertConfirmationUnchanged,
  createRuntimeConfirmationSnapshot,
} from "../tui/snapshots.js";
import { parseContextTokens } from "../context.js";
import type { UpDeps, UpOptions } from "./up.js";

export async function runInstalledUp(options: UpOptions, deps: UpDeps): Promise<void> {
  if (options.bypass !== true)
    throw new ValidationError("installed models outside the catalog require --bypass");
  if (options.context !== undefined) parseContextTokens(String(options.context));
  if (options.backend !== undefined && options.backend !== "ollama")
    throw new ValidationError("installed model bypass currently requires Ollama");
  const adapter = deps.registry.get("ollama");
  const support = adapter.installedModels;
  if (support === undefined) throw new ValidationError("backend does not support installed models");
  const before = deps.readState(deps.config);
  const prior = before.active;
  const identity = prior === null ? null : await deps.captureLiveProcessIdentity(prior);
  const snapshot = createRuntimeConfirmationSnapshot({
    operation: "replace_server",
    canonicalTargetIds: prior === null ? [options.model] : [prior.modelId, options.model],
    state: before,
    processIdentityHash: identity?.hash ?? null,
  });
  const port =
    options.port ?? (prior?.backend === "ollama" ? prior.port : adapter.capabilities.defaultPort);
  const endpoint = buildEndpoint(DEFAULT_BIND_HOST, port);
  const model = await support.inspect(endpoint, options.model);
  const catalogModel = deps.loadCatalog().models.find((entry) => entry.source.ollama === model.id);
  const catalogQuant =
    catalogModel?.quantizations.find((entry) => entry.name === model.quant) ??
    catalogModel?.quantizations[0];
  await support.verify(model.id, model.digest, catalogQuant?.sha256, catalogQuant?.diskBytes);
  deps.log(
    `up: bypassing estimated fit for ${stripControl(model.id)}; context fit and throughput may be unknown. Local content integrity is not catalog verification.\n`,
  );
  await deps.withLock(deps.config, async () => {
    const current = deps.readState(deps.config);
    const currentIdentity =
      current.active === null ? null : await deps.captureLiveProcessIdentity(current.active);
    assertConfirmationUnchanged(
      snapshot,
      createRuntimeConfirmationSnapshot({
        operation: "replace_server",
        canonicalTargetIds:
          current.active === null ? [options.model] : [current.active.modelId, options.model],
        state: current,
        processIdentityHash: currentIdentity?.hash ?? null,
      }),
      "active server changed; retry installed model activation",
    );
    if (
      current.active?.ownedByUs &&
      (current.active.backend !== "ollama" || current.active.port !== port)
    ) {
      throw new ValidationError("stop the prior owned runtime before attaching a different daemon");
    }
    const handle = await adapter.serve({ host: DEFAULT_BIND_HOST, port });
    if (
      handle.ownedByUs ||
      handle.pid <= 0 ||
      handle.processExecutable === undefined ||
      handle.processStartedAt === undefined
    ) {
      if (handle.ownedByUs) await adapter.stop(handle);
      throw new ValidationError("installed model activation requires an existing verified daemon");
    }
    const runtimeModelId = await support.activate(endpoint, model, options.context);
    await adapter.waitUntilReady({
      endpoint,
      requireOpenAiCompatibility: true,
      modelId: runtimeModelId,
      expectedProcess: {
        pid: handle.pid,
        executable: handle.processExecutable,
        started: handle.processStartedAt,
      },
    });
    const finalModel = await support.inspect(endpoint, model.id);
    if (finalModel.digest !== model.digest)
      throw new ValidationError("installed model changed before activation; retry");
    await deps.captureLiveProcessIdentity({
      backend: "ollama",
      modelId: model.id,
      endpoint,
      port,
      pid: handle.pid,
      ownedByUs: false,
      processExecutable: handle.processExecutable,
      processStartedAt: handle.processStartedAt,
    });
    deps.writeState(deps.config, {
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "ollama",
        modelId: model.id,
        runtimeModelId,
        ...(options.context !== undefined ? { context: options.context } : {}),
        integrity: "local-manifest",
        localManifestDigest: model.digest,
        endpoint,
        port,
        pid: handle.pid,
        ownedByUs: current.active?.ownedByUs === true && current.active.pid === handle.pid,
        processExecutable: handle.processExecutable,
        processStartedAt: handle.processStartedAt,
      },
    });
    deps.write(
      `${stripControl(model.id)} ready at ${endpoint}\nRuntime model: ${runtimeModelId}${options.context !== undefined ? ` (context ${String(options.context)})` : ""}\n`,
    );
  });
}
