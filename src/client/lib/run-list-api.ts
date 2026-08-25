import type { RunSummary } from "../../shared/contracts/run-detail.js";
import {
  RUN_LIST_MAX_LIMIT,
  RunListPageSchema,
  type RunListFilter,
  type RunListPage,
} from "../../shared/contracts/run-list.js";
import { runDetailErrorMessage } from "./run-detail-api.js";
import { apiFetch } from "./api.js";

/**
 * One page of blog-post history.
 *
 * `signal` lets a superseded filter or page request be abandoned, so a slow
 * earlier response can never overwrite the table the operator is now looking at.
 */
export async function fetchRunPage(
  query: { page?: number; limit?: number; filter?: RunListFilter } = {},
  signal?: AbortSignal,
): Promise<RunListPage> {
  const search = new URLSearchParams();
  if (query.page !== undefined) search.set("page", String(query.page));
  if (query.limit !== undefined) search.set("limit", String(query.limit));
  if (query.filter !== undefined) search.set("filter", query.filter);
  const suffix = search.size > 0 ? `?${search}` : "";
  const response = await apiFetch(`/api/runs${suffix}`, signal ? { signal } : {});
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(runDetailErrorMessage(body, "Articles could not be loaded."));
  return RunListPageSchema.parse(body);
}

/**
 * The newest runs, for navigation only: the breadcrumb's targets and focusing a
 * newly created run. Deliberately separate from the history table, whose filter
 * and page must never decide which run the operator is working on.
 */
export async function fetchRecentRuns(limit = RUN_LIST_MAX_LIMIT): Promise<RunSummary[]> {
  return (await fetchRunPage({ page: 1, limit, filter: "all" })).runs;
}
