import { dashboardRecords, dashboardSummary } from "./analytics";
import type { AnalyticsRequest, AnalyticsResponse } from "./analyticsMessages";
let summaryId = 0,
  recordsId = 0;
self.onmessage = async (event: MessageEvent<AnalyticsRequest>) => {
  const request = event.data;
  const { id, type } = request;
  if (type === "summary") summaryId = id;
  else recordsId = id;
  try {
    const response: AnalyticsResponse =
      request.type === "summary"
        ? {
            id,
            type: "summary",
            result: await dashboardSummary(
              request.filter,
              () => summaryId !== id,
            ),
          }
        : {
            id,
            type: "records",
            result: await dashboardRecords(
              request.filter,
              request.after,
              () => recordsId !== id,
            ),
          };
    self.postMessage(response);
  } catch (error) {
    self.postMessage({
      id,
      type,
      error:
        error instanceof Error ? error.message : "Could not read activity.",
    } satisfies AnalyticsResponse);
  }
};
