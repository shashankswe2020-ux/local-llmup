export interface InstalledModel {
  readonly id: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly quant: string | null;
  readonly contextLength: number | null;
  readonly kvBytesPerToken: number | null;
  readonly capabilities: readonly string[];
}

export interface InstalledModelSupport {
  list(endpoint: string): Promise<readonly InstalledModel[]>;
  inspect(endpoint: string, modelId: string): Promise<InstalledModel>;
  verify(
    modelId: string,
    digest: string,
    expectedSha256?: string,
    expectedSizeBytes?: number,
  ): Promise<void>;
  activate(endpoint: string, model: InstalledModel, context?: number): Promise<string>;
}
