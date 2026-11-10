/** Coalesces background indexing; at most one batch is scheduled at a time.
 * Interactive inference gets priority, and errors stop retries until another request.
 */
export class EmbeddingBackfill {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  constructor(
    private readonly batch: () => Promise<number>,
    private readonly busy: () => boolean,
    private readonly enabled: () => Promise<boolean>,
    private readonly delay = 500,
  ) {}
  start(): void {
    if (this.timer !== undefined || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, this.delay);
  }
  private async tick(): Promise<void> {
    if (this.busy()) {
      this.start();
      return;
    }
    this.running = true;
    let more = false;
    try {
      if (await this.enabled()) more = (await this.batch()) > 0;
    } catch {
      /* A later explicit request retries and reports the failure. */
    } finally {
      this.running = false;
    }
    if (more) this.start();
  }
}
