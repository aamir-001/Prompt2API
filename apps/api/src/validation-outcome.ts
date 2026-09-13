export const NO_ACTIVITY_IN_SAMPLE = "NO_ACTIVITY_IN_SAMPLE" as const;

export class NoActivityInSampleError extends Error {
  readonly code = NO_ACTIVITY_IN_SAMPLE;

  constructor(startBlock: number, stopBlock: number) {
    super(
      `${NO_ACTIVITY_IN_SAMPLE}: The Substreams package ran successfully, but no matching events occurred in Base blocks ${startBlock.toLocaleString()}-${(stopBlock - 1).toLocaleString()}. Choose another start block and retry validation.`,
    );
    this.name = "NoActivityInSampleError";
  }
}
