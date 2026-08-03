export class GcpExecutionContext implements ExecutionContext {
  readonly #tasks: Promise<unknown>[] = [];
  readonly exports = {} as Cloudflare.Exports;
  readonly props = undefined;
  readonly tracing = {
    enterSpan: <T, A extends unknown[]>(
      _name: string,
      callback: (span: Span, ...args: A) => T,
      ...args: A
    ): T => callback({} as Span, ...args),
    startActiveSpan: <T, A extends unknown[]>(
      _name: string,
      callback: (span: Span, ...args: A) => T,
      ...args: A
    ): T => callback({} as Span, ...args),
    Span: undefined as unknown as typeof Span,
  };

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
