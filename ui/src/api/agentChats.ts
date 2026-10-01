import type { Issue } from "@paperclipai/shared";
import { api } from "./client";
export const agentChatsApi = {
  get: (companyId: string, agentRef: string, issueId?: string | null) =>
    api.get<Issue | null>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}${issueId ? `?issueId=${encodeURIComponent(issueId)}` : ""}`,
    ),
  ensure: (companyId: string, agentRef: string) =>
    api.post<Issue>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}`,
      {},
    ),
  listRecents: (companyId: string, agentRef: string) =>
    api.get<Issue[]>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}/recents`,
    ),
  createFresh: (companyId: string, agentRef: string) =>
    api.post<Issue>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}/new`,
      {},
    ),
};
