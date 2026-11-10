import type { DashboardSummary, EventPage } from "./analytics";
import type {
  AnalyticsRequest,
  AnalyticsResponse,
  RecordsQuery,
  SummaryQuery,
} from "./analyticsMessages";

/** Requests fail consistently after a worker crash, including requests made after the error. */
export class AnalyticsClient {
  private sequence = 0;
  private failure: Error | undefined;
  private pending = new Map<
    number,
    {
      type: AnalyticsRequest["type"];
      resolve: (result: DashboardSummary | EventPage) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(private readonly worker: Worker) {
    worker.addEventListener(
      "message",
      (event: MessageEvent<AnalyticsResponse>) => {
        const response = event.data;
        const request = this.pending.get(response.id);
        if (!request) return;
        this.pending.delete(response.id);
        if (request.type !== response.type)
          request.reject(new Error("Unexpected activity response."));
        else if (response.error !== undefined)
          request.reject(new Error(response.error));
        else request.resolve(response.result);
      },
    );
    const failed = () =>
      this.dispose(
        new Error("Could not read activity. Reopen this page and try again."),
      );
    worker.addEventListener("error", failed);
    worker.addEventListener("messageerror", failed);
  }

  request(query: SummaryQuery): Promise<DashboardSummary>;
  request(query: RecordsQuery): Promise<EventPage>;
  request(
    query: SummaryQuery | RecordsQuery,
  ): Promise<DashboardSummary | EventPage> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { type: query.type, resolve, reject });
      try {
        this.worker.postMessage({ ...query, id } satisfies AnalyticsRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error("Could not request activity."),
        );
      }
    });
  }

  dispose(error = new Error("Activity page closed.")): void {
    this.failure = error;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
