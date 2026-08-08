import {
  collectRecommendation,
  formatRecommendationText,
  type RecommendOptions,
  type RecommendationResult,
} from "../commands/recommend.js";
import {
  collectCanRun,
  formatCanRunText,
  listCanRunModels,
  type CanRunOptions,
  type CanRunResult,
} from "../commands/can-run.js";
import {
  collectCatalog,
  formatCatalogText,
  type CatalogOptions,
  type CatalogResult,
} from "../commands/catalog.js";
import {
  collectDoctor,
  formatDoctorText,
  type DoctorReport,
} from "../commands/doctor.js";
import { collectLs, formatLsText, type LsResult } from "../commands/ls.js";
import type { UiModeSelection } from "./capabilities.js";
import {
  buildCanRunViewModel,
  buildCatalogViewModel,
  buildDoctorViewModel,
  buildLsViewModel,
  buildRecommendViewModel,
} from "./read-only-view-models.js";
import { runReadOnlyPresentation } from "./read-only-command.js";
import { createBoundedCookedLineReader } from "./cooked-line-reader.js";

type InteractiveSelection = UiModeSelection & { readonly mode: "tui" | "accessible" };

export async function runInteractiveRecommend(
  options: RecommendOptions,
  mode: InteractiveSelection,
): Promise<RecommendationResult> {
  const outcome = await runReadOnlyPresentation({
    screen: "recommend",
    mode,
    collect: () => collectRecommendation(options),
    buildViewModel: buildRecommendViewModel,
    formatPlain: (result) => `${formatRecommendationText(result)}\n`,
  });
  return outcome.result;
}

export async function runInteractiveCanRun(
  options: Omit<CanRunOptions, "model"> & { readonly model?: string | undefined },
  mode: InteractiveSelection,
): Promise<CanRunResult | null | undefined> {
  let model = options.model;
  if (model === undefined) {
    if (mode.mode === "tui") {
      try {
        const { mountModelPicker } = await import("./model-picker.js");
        const picker = mountModelPicker({
          title: "Choose a model for can-run",
          choices: listCanRunModels(),
          stdin: process.stdin,
          stderr: process.stderr,
          unicode: mode.unicode,
        });
        model = (await picker.waitForDecision()) ?? undefined;
      } catch {
        process.stderr.write(
          "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
        );
        process.exitCode = 1;
        return undefined;
      }
    } else {
      try {
        const { runAccessibleModelPicker } = await import("./model-picker-accessible.js");
        const reader = createBoundedCookedLineReader(process.stdin, 256);
        try {
          model =
            (await runAccessibleModelPicker({
              title: "Choose a model for can-run",
              choices: listCanRunModels(),
              readLine: reader.readLine,
              write: (text) => process.stderr.write(text),
            })) ?? undefined;
        } finally {
          reader.close();
        }
      } catch {
        process.stderr.write(
          "local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n",
        );
        process.exitCode = 1;
        return undefined;
      }
    }
  }
  if (model === undefined) return null;
  const commandOptions: CanRunOptions = {
    model,
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
  };
  const outcome = await runReadOnlyPresentation({
    screen: "canRun",
    mode,
    collect: () => collectCanRun(commandOptions),
    buildViewModel: buildCanRunViewModel,
    formatPlain: (result) => `${formatCanRunText(result)}\n`,
  });
  return outcome.result;
}

export async function runInteractiveDoctor(
  mode: InteractiveSelection,
): Promise<DoctorReport> {
  const outcome = await runReadOnlyPresentation({
    screen: "doctor",
    mode,
    collect: () => collectDoctor(),
    buildViewModel: buildDoctorViewModel,
    formatPlain: formatDoctorText,
  });
  return outcome.result;
}

export async function runInteractiveCatalog(
  options: CatalogOptions,
  mode: InteractiveSelection,
): Promise<CatalogResult> {
  const outcome = await runReadOnlyPresentation({
    screen: "catalog",
    mode,
    collect: () => collectCatalog(options),
    buildViewModel: buildCatalogViewModel,
    formatPlain: formatCatalogText,
  });
  return outcome.result;
}

export async function runInteractiveLs(mode: InteractiveSelection): Promise<LsResult> {
  const outcome = await runReadOnlyPresentation({
    screen: "ls",
    mode,
    collect: () => collectLs(),
    buildViewModel: buildLsViewModel,
    formatPlain: formatLsText,
  });
  return outcome.result;
}
