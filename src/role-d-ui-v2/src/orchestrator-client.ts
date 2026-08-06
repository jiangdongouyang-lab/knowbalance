export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface LearningGoalSpecInput {
  mode: "curriculum_node" | "custom_goal"
  selected_node_ids?: string[]
  custom_goal?: string
}

export interface CreateSessionInput {
  learnerId: string
  goal: string
  background?: string
  selfRating?: string
  learningGoalSpec?: LearningGoalSpecInput
}

export interface ProviderConfigurationView {
  configured: boolean
  provider_mode: "model"
  endpoint: string
  model_id: string
}

export type SubmissionAnswer =
  | { item_id: string; selected_option_id: string; hint_level_used: number }
  | { item_id: string; text_response: string; hint_level_used: number }
  | { item_id: string; code_response: string; hint_level_used: number }

export class OrchestratorClientError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
  }
}

export async function createOrchestratorSession(
  input: CreateSessionInput,
  fetcher: Fetcher = fetch,
): Promise<any> {
  return requestJson("/orchestrator/sessions", input.learnerId, fetcher, {
    method: "POST",
    body: JSON.stringify({
      mode: "deterministic",
      learner_request: {
        learner_id: input.learnerId,
        goal: input.goal,
        background: input.background,
        self_rating: input.selfRating,
        learning_goal_spec: input.learningGoalSpec,
      },
    }),
  })
}

export async function getProviderConfiguration(fetcher: Fetcher = fetch): Promise<ProviderConfigurationView> {
  return publicRequestJson("/orchestrator/provider-config", fetcher)
}

export async function saveProviderConfiguration(
  input: { endpoint: string; modelId: string; apiKey: string },
  fetcher: Fetcher = fetch,
): Promise<ProviderConfigurationView> {
  return publicRequestJson("/orchestrator/provider-config", fetcher, {
    method: "PUT",
    body: JSON.stringify({ endpoint: input.endpoint, model_id: input.modelId, api_key: input.apiKey }),
  })
}

export async function getOrchestratorSession(sessionId: string, learnerId: string, fetcher: Fetcher = fetch): Promise<any> {
  return requestJson(`/orchestrator/sessions/${encodeURIComponent(sessionId)}`, learnerId, fetcher)
}

export async function getOrchestratorEvents(sessionId: string, learnerId: string, fetcher: Fetcher = fetch): Promise<any> {
  return requestJson(`/orchestrator/sessions/${encodeURIComponent(sessionId)}/events`, learnerId, fetcher)
}

export async function submitDiagnosisAnswers(
  sessionId: string,
  learnerId: string,
  answers: Record<string, string>,
  fetcher: Fetcher = fetch,
  commandId: string = crypto.randomUUID(),
): Promise<any> {
  return command(sessionId, learnerId, {
    command_id: commandId,
    type: "submit_diagnosis_answers",
    payload: { answers },
  }, fetcher)
}

export async function submitAssessmentAnswers(
  sessionId: string,
  learnerId: string,
  answers: SubmissionAnswer[],
  fetcher: Fetcher = fetch,
  commandId: string = crypto.randomUUID(),
): Promise<any> {
  return command(sessionId, learnerId, {
    command_id: commandId,
    type: "submit_assessment_answers",
    payload: { answers },
  }, fetcher)
}

export async function retryOrchestratorSession(
  sessionId: string,
  learnerId: string,
  fetcher: Fetcher = fetch,
  commandId: string = crypto.randomUUID(),
): Promise<any> {
  return command(sessionId, learnerId, { command_id: commandId, type: "retry" }, fetcher)
}

async function command(sessionId: string, learnerId: string, body: unknown, fetcher: Fetcher): Promise<any> {
  return requestJson(`/orchestrator/sessions/${encodeURIComponent(sessionId)}/commands`, learnerId, fetcher, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

async function requestJson(path: string, learnerId: string, fetcher: Fetcher, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${learnerId}`)
  if (init.body !== undefined) headers.set("content-type", "application/json")
  return executeJson(path, fetcher, { ...init, headers })
}

async function publicRequestJson(path: string, fetcher: Fetcher, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set("content-type", "application/json")
  return executeJson(path, fetcher, { ...init, headers })
}

async function executeJson(path: string, fetcher: Fetcher, init: RequestInit): Promise<any> {
  const response = await fetcher(path, init)
  const payload: any = await response.json().catch(() => ({ error: { code: "INVALID_RESPONSE", message: "主 Agent返回了无效响应" } }))
  if (!response.ok) {
    throw new OrchestratorClientError(
      payload?.error?.code ?? "ORCHESTRATOR_REQUEST_FAILED",
      payload?.error?.message ?? `主 Agent请求失败（${response.status}）`,
      response.status,
    )
  }
  return payload
}
