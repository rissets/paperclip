export type OrchestratorRoute = "data_agent" | "knowledge_agent" | "hybrid" | "direct";

export interface Citation {
  sourceName: string;
  section?: string;
  chunkIndex?: number;
  snippet?: string;
}

export interface SpecialistExecution {
  agent: "data_agent" | "knowledge_agent";
  task: string;
  query?: string;
  resultsSummary?: string;
  dataPreview?: any;
  citations?: Citation[];
}

export interface JevDecisionChoice {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevDecisionScore {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export interface JevDecisionNoul {
  type: "noul";
  noul: number;
}

export type JevDecisionAnswer = JevDecisionChoice | JevDecisionScore | JevDecisionNoul;

export interface JevDecisionResult {
  model: string;
  answers: Record<string, JevDecisionAnswer>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  latencyMs?: number;
}

export interface OrchestrationPlan {
  intent: string;
  route: OrchestratorRoute;
  confidence: number;
  reasoning: string;
  selectedDataSources: { id: string; name: string; type: string }[];
  specialistExecutions: SpecialistExecution[];
  synthesizedAnswer: string;
  jevDecisions?: JevDecisionResult;
}

export interface OrchestratorSession {
  id: string;
  companyId: string;
  title: string;
  status: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface OrchestratorMessage {
  id: string;
  sessionId: string;
  companyId: string;
  role: "user" | "assistant" | "system";
  content: string;
  orchestrationPlan: OrchestrationPlan | null;
  createdAt: string | Date;
}

