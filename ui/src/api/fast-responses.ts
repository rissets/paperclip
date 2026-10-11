import type {
  FastResponseSettingsResponse,
  FastResponseSettings,
  FastResponseTestResult,
  FastResponseHistoryEntry,
  UpdateFastResponse,
} from "@paperclipai/shared";
import { api } from "./client";
export const fastResponsesApi = {
  settings: (companyId: string) =>
    api.get<FastResponseSettingsResponse>(
      `/companies/${companyId}/fast-response`,
    ),
  update: (companyId: string, settings: UpdateFastResponse) =>
    api.put<FastResponseSettings>(
      `/companies/${companyId}/fast-response`,
      settings,
    ),
  models: (companyId: string, connectionId: string) =>
    api.get<Array<{ id: string; label?: string }>>(
      `/companies/${companyId}/fast-response/models?connectionId=${encodeURIComponent(connectionId)}`,
    ),
  syncModels: (companyId: string, input: { connectionId?: string; endpoint?: string; apiKey?: string }) =>
    api.post<{ models: Array<{ id: string; label?: string }> }>(
      `/companies/${companyId}/fast-response/sync-models`,
      input,
    ),
  test: (companyId: string) =>
    api.post<FastResponseTestResult>(
      `/companies/${companyId}/fast-response/test`,
      {},
    ),
  history: (companyId: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return api.get<FastResponseHistoryEntry[]>(
      `/companies/${companyId}/fast-response/history?${params}`,
    );
  },
};
