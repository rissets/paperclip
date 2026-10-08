import { api } from "./client";

export interface TranscriptSegment {
  id?: string;
  meeting_id: string;
  speaker: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
  confidence?: number;
  created_at?: string;
}

export interface Meeting {
  id: string;
  company_id: string;
  title: string;
  status: "created" | "recording" | "transcribing" | "completed" | "error";
  audio_path?: string | null;
  duration_seconds: number;
  summary?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MeetingDetail extends Meeting {
  segments?: TranscriptSegment[];
  segment_count?: number;
}

export const meetingsApi = {
  list: (companyId: string) =>
    api.get<Meeting[]>(`/companies/${encodeURIComponent(companyId)}/meetings`),

  get: (companyId: string, id: string) =>
    api.get<MeetingDetail>(`/companies/${encodeURIComponent(companyId)}/meetings/${encodeURIComponent(id)}`),

  create: (companyId: string, input: { title?: string; id?: string }) =>
    api.post<Meeting>(`/companies/${encodeURIComponent(companyId)}/meetings`, input),

  update: (companyId: string, id: string, input: Partial<Pick<Meeting, "title" | "status" | "summary">>) =>
    api.patch<Meeting>(`/companies/${encodeURIComponent(companyId)}/meetings/${encodeURIComponent(id)}`, input),

  delete: (companyId: string, id: string) =>
    api.delete<{ success: boolean; id: string }>(`/companies/${encodeURIComponent(companyId)}/meetings/${encodeURIComponent(id)}`),

  getTranscript: (companyId: string, id: string) =>
    api.get<{ meeting_id: string; segments: TranscriptSegment[]; full_text: string }>(
      `/companies/${encodeURIComponent(companyId)}/meetings/${encodeURIComponent(id)}/transcript`
    ),

  getRecent: (companyId: string, id: string, seconds = 120) =>
    api.get<{ meeting_id: string; recent_seconds: number; segments: TranscriptSegment[]; summary_text: string }>(
      `/companies/${encodeURIComponent(companyId)}/meetings/${encodeURIComponent(id)}/recent?seconds=${encodeURIComponent(seconds)}`
    ),

  search: (companyId: string, id: string, q: string) =>
    api.get<{ meeting_id: string; query: string; results: TranscriptSegment[] }>(
      `/companies/${encodeURIComponent(companyId)}/meetings/${encodeURIComponent(id)}/search?q=${encodeURIComponent(q)}`
    ),

  uploadAudio: (companyId: string, id: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.postForm<Meeting>(
      `/companies/${encodeURIComponent(companyId)}/meetings/${encodeURIComponent(id)}/upload`,
      formData
    );
  },

  finish: (companyId: string, id: string) =>
    api.post<Meeting>(`/companies/${encodeURIComponent(companyId)}/meetings/${encodeURIComponent(id)}/finish`, {}),

  getAudioUrl: (companyId: string, id: string) =>
    `/api/companies/${encodeURIComponent(companyId)}/meetings/${encodeURIComponent(id)}/audio`,

  syncDatasource: (companyId: string, id: string) =>
    api.post<{ success: boolean; dataSource: any }>(
      `/companies/${encodeURIComponent(companyId)}/meetings/${encodeURIComponent(id)}/sync-datasource`,
      {}
    ),

  createIssue: (
    companyId: string,
    id: string,
    input: {
      title: string;
      description?: string;
      assigneeAgentId?: string | null;
      priority?: string;
      status?: string;
    }
  ) =>
    api.post<{ success: boolean; issue: any }>(
      `/companies/${encodeURIComponent(companyId)}/meetings/${encodeURIComponent(id)}/create-issue`,
      input
    ),
};
