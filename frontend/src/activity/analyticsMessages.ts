import type {
  DashboardFilter,
  DashboardSummary,
  EventCursor,
  EventPage,
  RecordFilter,
} from "./analytics";

export type SummaryQuery = { type: "summary"; filter: DashboardFilter };
export type RecordsQuery = {
  type: "records";
  filter: RecordFilter;
  after?: EventCursor;
};
export type AnalyticsRequest = (SummaryQuery | RecordsQuery) & { id: number };
export type AnalyticsResponse =
  | { id: number; type: "summary"; result: DashboardSummary; error?: never }
  | { id: number; type: "records"; result: EventPage; error?: never }
  | { id: number; type: "summary" | "records"; error: string; result?: never };
