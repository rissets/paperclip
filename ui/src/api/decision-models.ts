import type { DecisionConnectionChoice, DecisionHistoryEntry, DecisionModelSettings, DecisionResult, UpdateDecisionModel } from "@paperclipai/shared";
import { api } from "./client";
export interface DecisionSettingsResponse { canManage: boolean; settings: DecisionModelSettings | null; choices: DecisionConnectionChoice[] }
export const decisionModelsApi = {
  settings: (companyId: string) => api.get<DecisionSettingsResponse>(`/companies/${companyId}/decision-model`),
  update: (companyId: string, settings: UpdateDecisionModel) => api.put<DecisionModelSettings>(`/companies/${companyId}/decision-model`, settings),
  models: (companyId: string, connectionId: string) =>
    api.get<Array<{ id: string; label?: string }>>(
      `/companies/${companyId}/decision-model/models?connectionId=${encodeURIComponent(connectionId)}`,
    ),
  syncModels: (companyId: string, input: { connectionId?: string; endpoint?: string; apiKey?: string }) =>
    api.post<{ models: Array<{ id: string; label?: string }> }>(
      `/companies/${companyId}/decision-model/sync-models`,
      input,
    ),
  test: (companyId: string) => api.post<DecisionResult>(`/companies/${companyId}/decision-model/test`, {}),
  history: (companyId: string, from?: string | null, to?: string | null) => {
    const params = new URLSearchParams({ limit: "100" });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return api.get<DecisionHistoryEntry[]>(`/companies/${companyId}/decision-model/history?${params}`);
  },
};
