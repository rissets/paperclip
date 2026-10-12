import { api } from "./client.js";
import type {
  EmailConnectorConfigInput,
  EmailConnectorTestInput,
} from "@paperclipai/shared";

export interface EmailTestResult {
  success: boolean;
  smtp: { success: boolean; error?: string };
  imap: { success: boolean; error?: string };
}

export interface EmailConnectionStatus {
  endpointId: string;
  imapStatus: "connected" | "disconnected" | "connecting" | "error";
  smtpStatus: "ready" | "error" | "untested";
  lastInboundAt?: string;
  lastOutboundAt?: string;
  error?: string;
}

export const emailConnectorApi = {
  testConnection: (companyId: string, input: EmailConnectorTestInput) =>
    api.post<EmailTestResult>(
      `/companies/${companyId}/email-connector/test`,
      input,
    ),

  setupConnection: (companyId: string, input: EmailConnectorConfigInput) =>
    api.post<{
      endpoint: { id: string; provider: string; status: string; publicId: string };
      connectionId: string;
      emailAddress: string;
      status: string;
    }>(`/companies/${companyId}/email-connector/setup`, input),

  getStatus: (companyId: string, endpointId: string) =>
    api.get<EmailConnectionStatus>(
      `/companies/${companyId}/email-connector/status/${endpointId}`,
    ),

  sendReply: (
    companyId: string,
    endpointId: string,
    issueId: string,
    replyText: string,
  ) =>
    api.post<{ success: boolean; messageId?: string; error?: string }>(
      `/companies/${companyId}/email-connector/reply`,
      { endpointId, issueId, replyText },
    ),

  disconnect: (companyId: string, endpointId: string) =>
    api.post<{ success: boolean; message: string }>(
      `/companies/${companyId}/email-connector/disconnect/${endpointId}`,
      {},
    ),
};
