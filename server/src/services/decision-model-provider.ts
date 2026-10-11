import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { experimental_decide as decide, type Experimental_DecisionModel } from "ai";
import { centsToUnits, unitsToCents, type DecisionAnswer, type DecisionProvider, type DecisionRequest } from "@paperclipai/shared";

export interface DecisionProviderReceipt {
  inputTokens: number | null; outputTokens: number | null; providerRequestId: string | null;
  costCents: string | null; costStatus: "reported" | "estimated" | "unpriced";
  pricingProvenance: { source: "provider_reported" | "rate_card" | "unknown"; version?: string; evidence?: string; inputCentsPerMillion?: string };
}
export interface DecisionProviderOutcome { noProviderWork?: boolean; answers?: Record<string, DecisionAnswer>; errorCode?: string; receipt: DecisionProviderReceipt }
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const tokenCount = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 2_147_483_647 ? v : null;
function rejectedResponseData(error: unknown) {
  const value = record(error);
  if (value.data) return record(value.data);
  if (record(value.cause).value) return record(record(value.cause).value);
  // SDK schema rejection may retain only responseBody. Read a bounded body in
  // memory for accounting; never forward it to the ledger, logger, or caller.
  if (typeof value.responseBody === "string" && value.responseBody.length <= 1_000_000) {
    try { return record(JSON.parse(value.responseBody)); } catch { /* Not valid JSON. */ }
  }
  return {};
}
export function decisionReceipt(provider: DecisionProvider, result: unknown): DecisionProviderReceipt {
  const value = record(result), usage = record(value.usage), metadata = record(value.providerMetadata);
  const response = record(value.response);
  const headers = record(response.headers);
  const inputTokens = tokenCount(usage.inputTokens), outputTokens = tokenCount(usage.outputTokens);
  const reported = record(record(metadata.openrouter).usage).cost;
  const base = { inputTokens, outputTokens, providerRequestId: typeof response.id === "string" ? response.id.slice(0, 250) : typeof headers["x-request-id"] === "string" ? headers["x-request-id"].slice(0, 250) : null };
  if (provider === "openrouter" && typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    return { ...base, costCents: unitsToCents(centsToUnits(reported * 100)), costStatus: "reported", pricingProvenance: { source: "provider_reported" } };
  }
  // V1 uses the official default endpoint and bounded short text requests. Decisions has its own rate, not the chat model's rate.
  if (provider === "openai" && inputTokens !== null && inputTokens <= 32_000) {
    return { ...base, costCents: unitsToCents(centsToUnits("10") * BigInt(inputTokens) / 1_000_000n), costStatus: "estimated",
      pricingProvenance: { source: "rate_card", version: "openai-decisions-2026-10-07", inputCentsPerMillion: "10.0000000" } };
  }
  return { ...base, costCents: null, costStatus: "unpriced", pricingProvenance: { source: "unknown" } };
}
function buildChatDecisionPrompt(request: DecisionRequest): { system: string; user: string } {
  const stateText = typeof request.state === "string"
    ? request.state
    : JSON.stringify(request.state, null, 2);

  const questionPrompts = Object.entries(request.questions).map(([id, q]) => {
    if (q.type === "boolean") {
      return `- Question "${id}" (type: boolean):\n  Instructions: ${q.instructions}\n  Expected: Answer with "probability" as a number between 0.0 and 1.0 (representing probability of true).`;
    }
    if (q.type === "choice") {
      const opts = Object.entries(q.criteria).map(([k, v]) => `    * "${k}": ${v}`).join("\n");
      return `- Question "${id}" (type: choice):\n  Instructions: ${q.instructions}\n  Options:\n${opts}\n  Expected: Answer with "choice" set to one of the exact option keys above, and optional "confidence" (0.0 to 1.0).`;
    }
    if (q.type === "score") {
      const levels = q.criteria.map((v, i) => `    * level ${i}: ${v}`).join("\n");
      return `- Question "${id}" (type: score):\n  Instructions: ${q.instructions}\n  Scale (0 to ${q.criteria.length - 1}):\n${levels}\n  Expected: Answer with "score" set to an integer from 0 to ${q.criteria.length - 1}, and optional "confidence" (0.0 to 1.0).`;
    }
    return "";
  }).filter(Boolean).join("\n\n");

  const system = "You are an AI decision engine. Evaluate the given state and provide structured answers for every question. Output ONLY a valid JSON object matching the requested schema with no surrounding text or markdown formatting.";

  const user = `STATE:
${stateText}

QUESTIONS TO ANSWER:
${questionPrompts}

Return a JSON object with this exact shape:
{
  "answers": {
    "<question_id>": { "type": "boolean", "probability": 0.95 },
    "<question_id>": { "type": "choice", "choice": "<selected_key>", "confidence": 0.9 },
    "<question_id>": { "type": "score", "score": 1, "confidence": 0.85 }
  }
}`;

  return { system, user };
}

function parseChatDecisionAnswers(content: string, request: DecisionRequest): Record<string, DecisionAnswer> {
  let cleaned = content.trim();
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  const parsed = record(JSON.parse(cleaned));
  const rawAnswers = record(parsed.answers || parsed);

  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    const raw = record(rawAnswers[id]);
    if (q.type === "boolean") {
      let prob = typeof raw.probability === "number" ? raw.probability
        : typeof rawAnswers[id] === "number" ? (rawAnswers[id] as number)
        : rawAnswers[id] === true || raw.value === true ? 1
        : rawAnswers[id] === false || raw.value === false ? 0
        : 0.5;
      prob = Math.max(0, Math.min(1, prob));
      answers[id] = { type: "boolean", probability: Number(prob.toFixed(2)) };
    } else if (q.type === "choice") {
      const rawChoice = typeof raw.choice === "string" ? raw.choice : typeof rawAnswers[id] === "string" ? (rawAnswers[id] as string) : "";
      const validKeys = Object.keys(q.criteria);
      const matched = validKeys.find(k => k === rawChoice)
        ?? validKeys.find(k => k.toLowerCase() === rawChoice.toLowerCase())
        ?? validKeys[0];
      const conf = typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1
        ? Number(raw.confidence.toFixed(2))
        : undefined;
      answers[id] = {
        type: "choice",
        choice: matched,
        ...(conf !== undefined ? { confidence: conf } : {}),
      };
    } else if (q.type === "score") {
      const maxScore = q.criteria.length - 1;
      let score = typeof raw.score === "number" ? raw.score
        : typeof rawAnswers[id] === "number" ? (rawAnswers[id] as number)
        : 0;
      score = Math.max(0, Math.min(maxScore, Math.round(score)));
      const conf = typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1
        ? Number(raw.confidence.toFixed(2))
        : undefined;
      answers[id] = {
        type: "score",
        score,
        ...(conf !== undefined ? { confidence: conf } : {}),
      };
    }
  }
  return answers;
}

async function runChatCompletionDecision(
  input: {
    provider: DecisionProvider;
    model: string;
    apiKey: string;
    baseUrl?: string;
    request: DecisionRequest;
    signal: AbortSignal;
  },
  options: { fetch?: typeof fetch } = {},
): Promise<DecisionProviderOutcome> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const chatUrl = input.baseUrl
    ? `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`
    : input.provider === "openai"
    ? "https://api.openai.com/v1/chat/completions"
    : "https://openrouter.ai/api/v1/chat/completions";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (input.apiKey) {
    headers["Authorization"] = `Bearer ${input.apiKey}`;
  }

  const { system, user } = buildChatDecisionPrompt(input.request);
  const requestBody: Record<string, unknown> = {
    model: input.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  };

  let res = await fetchFn(chatUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: input.signal,
  });

  if (res.status === 400) {
    delete requestBody.response_format;
    res = await fetchFn(chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: input.signal,
    });
  }

  if (!res.ok) {
    const status = res.status;
    const errorCode = input.signal.aborted
      ? "timeout"
      : status === 401 || status === 403
      ? "provider_auth_failed"
      : status === 429
      ? "provider_rate_limited"
      : "provider_failed";
    const noProviderWork = [400, 401, 403, 404, 422, 429].includes(status);
    return {
      errorCode,
      receipt: decisionReceipt(input.provider, null),
      noProviderWork,
    };
  }

  const data = record(await res.json());
  const rawUsage = record(data.usage);
  const inputTokens = tokenCount(rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? rawUsage.inputTokens);
  const outputTokens = tokenCount(rawUsage.completion_tokens ?? rawUsage.output_tokens ?? rawUsage.outputTokens);
  const providerRequestId = typeof data.id === "string" ? data.id.slice(0, 250) : null;

  const costCents = (input.provider === "openai" && inputTokens !== null && inputTokens <= 32_000)
    ? unitsToCents(centsToUnits("10") * BigInt(inputTokens) / 1_000_000n)
    : null;
  const receipt: DecisionProviderReceipt = {
    inputTokens,
    outputTokens,
    providerRequestId,
    costCents,
    costStatus: costCents ? "estimated" : "unpriced",
    pricingProvenance: costCents
      ? { source: "rate_card", version: "openai-decisions-2026-10-07", inputCentsPerMillion: "10.0000000" }
      : { source: "unknown" },
  };

  const choices = Array.isArray(data.choices) ? data.choices : [];
  const content = String(record(record(choices[0]).message).content ?? "");
  const answers = parseChatDecisionAnswers(content, input.request);

  return { answers, receipt };
}

export async function runDecisionProvider(input: {
  provider: DecisionProvider; model: string; apiKey: string; baseUrl?: string; request: DecisionRequest; signal: AbortSignal;
}, options: { fetch?: typeof fetch } = {}): Promise<DecisionProviderOutcome> {
  const native = input.provider === "openai"
    ? createOpenAI({ apiKey: input.apiKey, fetch: options.fetch }).decisionModel(input.model)
    : input.provider === "custom"
    ? createOpenAI({
        apiKey: input.apiKey || "dummy",
        baseURL: input.baseUrl ? input.baseUrl.replace(/\/+$/, "") : undefined,
        fetch: options.fetch,
      }).decisionModel(input.model)
    : createOpenRouter({ apiKey: input.apiKey, fetch: options.fetch }).evaluationModel(input.model);
  let receipt = decisionReceipt(input.provider, null);
  // Capture only accounting metadata before SDK answer validation/refusal errors.
  const model: Exclude<Experimental_DecisionModel, string> = {
    specificationVersion: "v4", provider: native.provider, modelId: native.modelId, supportedQuestionTypes: native.supportedQuestionTypes,
    async doDecide(args) {
      const response = await ("doDecide" in native ? native.doDecide(args) : native.doEvaluate(args));
      receipt = decisionReceipt(input.provider, response);
      return { ...response, warnings: [] };
    },
  };
  try {
    const result = await decide({ model, ...input.request, maxRetries: 0, abortSignal: input.signal,
      telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false } });
    const metadata = record(result.providerMetadata);
    const answers = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => {
      const confidence = (input.provider === "openai" || input.provider === "custom")
        ? record(record(metadata.openai).confidence)[id]
        : record(record(record(metadata.openrouter).answers)[id]).confidence;
      return [id, { ...answer, ...(typeof confidence === "number" && confidence >= 0 && confidence <= 1 ? { confidence } : {}) }];
    }));
    return { answers, receipt };
  } catch (error) {
    const status = Number(record(error).statusCode);
    if (
      !input.signal.aborted &&
      (status === 404 || status === 405 || (input.provider === "custom" && status !== 401 && status !== 403 && status !== 429))
    ) {
      try {
        return await runChatCompletionDecision(input, options);
      } catch {
        // Fall back to original error handling if chat fallback fails
      }
    }
    // Never expose provider error messages/bodies; they may contain inputs or credentials.
    const name = error instanceof Error ? error.name : "";
    // SDKs can reject refusals or malformed answers before normalized usage.
    // Keep only validated accounting fields, even in this failure path.
    const data = rejectedResponseData(error);
    const rawUsage = record(data.usage);
    if (receipt.costStatus === "unpriced") {
      receipt = decisionReceipt(input.provider, { usage: { inputTokens: rawUsage.input_tokens, outputTokens: rawUsage.output_tokens },
        providerMetadata: { openrouter: { usage: { cost: rawUsage.cost } } },
        response: { id: data.id, headers: record(error).responseHeaders } });
    }
    const rawAnswers = Array.isArray(data.answers) ? data.answers : Object.values(record(data.answers));
    const refused = name.includes("Refusal") || record(data.error).type === "refusal" || rawAnswers.some(answer => record(answer).type === "refusal");
    const errorCode = input.signal.aborted ? "timeout" : refused ? "refused"
      : status === 401 || status === 403 ? "provider_auth_failed" : status === 429 ? "provider_rate_limited" : "provider_failed";
    // An explicit authentication/validation rejection occurs before model work.
    // Server errors and network failures remain unresolved: their charge is unknown.
    const noProviderWork = receipt.costStatus === "unpriced" && [400, 401, 403, 404, 422, 429].includes(Number(status));
    if (noProviderWork) receipt = { ...receipt, inputTokens: 0, outputTokens: 0, costCents: "0.0000000", costStatus: "estimated",
      pricingProvenance: { source: "unknown", evidence: `Provider rejected request before model work (HTTP ${status})` } };
    return { errorCode, receipt, noProviderWork };
  }
}
