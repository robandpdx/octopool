export class GcpExecutionContext implements ExecutionContext {
  readonly #tasks: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.#tasks.push(promise);
  }

  passThroughOnException(): void {}

  async drain(): Promise<void> {
    const results = await Promise.allSettled(this.#tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("gcp waitUntil task failed", result.reason);
      }
    }
  }
}
