import type {
  ArtifactDraft,
  AssessmentDraft,
  CodeLabDraft,
  CodeLabRequest,
  ConceptTutorRequest,
  RoleCContentProvider,
} from "../agents/types"
import type { ConceptLessonPayload } from "../contracts/artifacts"
import { ModelProviderUnavailableError } from "../contracts/model-gateway"
import { buildConceptTutorModelInput, type ConceptTutorModelInput } from "../context/concept-context"
import { buildCodeLabModelInput, type CodeLabModelInput } from "../context/code-lab-context"
import { buildAssessmentAuthorModelInput, type AssessmentAuthorModelInput } from "../context/assessment-context"
import { ROLE_C_PROMPT_MANIFEST_VERSION } from "../prompts/common-policy"

export interface RoleCWorkerInvoker {
  invoke(input:
    | { worker: "concept-tutor"; request: ConceptTutorModelInput }
    | { worker: "code-lab"; request: CodeLabModelInput }
    | { worker: "tiered-evaluator"; request: AssessmentAuthorModelInput }
  ): Promise<unknown>
}

/** Adapts OpenCode task output to the same Provider Draft consumed by the typed harness. */
export class OpenCodeConceptContentProvider implements RoleCContentProvider {
  constructor(private readonly invoker: RoleCWorkerInvoker) {}

  async generateConceptLesson(
    request: ConceptTutorRequest,
  ): Promise<ArtifactDraft<ConceptLessonPayload>> {
    assertPromptVersion(request)
    const result = await invokeWorker(
      this.invoker,
      {
        worker: "concept-tutor",
        request: buildConceptTutorModelInput(request),
      },
    )
    if (!isRecord(result)) {
      return { payload: result as unknown as ConceptLessonPayload }
    }
    if (result.status === "blocked") {
      throw new ModelProviderUnavailableError(
        "OpenCode concept-tutor 未生成可发布内容",
      )
    }
    assertCompletedResult(result, "concept-tutor")
    const draft = result.provider_draft
    if (!isRecord(draft) || !("payload" in draft)) {
      return { payload: result as unknown as ConceptLessonPayload }
    }
    return { payload: draft.payload as ConceptLessonPayload }
  }

  async generateCodeLab(request: CodeLabRequest): Promise<CodeLabDraft> {
    assertPromptVersion(request)
    const result = await invokeWorker(
      this.invoker,
      { worker: "code-lab", request: buildCodeLabModelInput(request) },
    )
    if (!isRecord(result)) return result as unknown as CodeLabDraft
    if (result.status === "blocked") {
      throw new ModelProviderUnavailableError(
        "OpenCode code-lab 未生成可发布内容",
      )
    }
    assertCompletedResult(result, "code-lab")
    const draft = result.provider_draft
    if (!isRecord(draft) || !("public_draft" in draft) || !("secure_draft" in draft)) {
      return result as unknown as CodeLabDraft
    }
    return draft as unknown as CodeLabDraft
  }

  async generateAssessment(request: Parameters<RoleCContentProvider["generateAssessment"]>[0]): Promise<AssessmentDraft> {
    assertPromptVersion(request)
    const result = await invokeWorker(
      this.invoker,
      {
        worker: "tiered-evaluator",
        request: buildAssessmentAuthorModelInput(request),
      },
    )
    if (!isRecord(result)) return result as unknown as AssessmentDraft
    if (result.status === "blocked") {
      throw new ModelProviderUnavailableError(
        "OpenCode tiered-evaluator 未生成可发布内容",
      )
    }
    assertCompletedResult(result, "tiered-evaluator")
    const draft = result.provider_draft
    if (!isRecord(draft) || !("public_draft" in draft) || !("secure_draft" in draft)) {
      return result as unknown as AssessmentDraft
    }
    return draft as unknown as AssessmentDraft
  }
}

/** Preferred role-wide name; the former export remains for backward compatibility. */
export class OpenCodeRoleCContentProvider extends OpenCodeConceptContentProvider {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function assertPromptVersion(request: ConceptTutorRequest | CodeLabRequest): void {
  if (request.generation_spec.versions.prompt_version !== ROLE_C_PROMPT_MANIFEST_VERSION) {
    throw new ModelProviderUnavailableError(
      `GenerationSpec prompt_version=${request.generation_spec.versions.prompt_version}，OpenCode Provider 要求 ${ROLE_C_PROMPT_MANIFEST_VERSION}`,
    )
  }
}

function assertCompletedResult(result: Record<string, unknown>, worker: string): void {
  if (result.status !== "completed" || (result.blocked_reason !== null && result.blocked_reason !== undefined)) {
    throw new ModelProviderUnavailableError(
      `OpenCode ${worker} 返回非 completed 或自相矛盾的执行状态`,
    )
  }
}

async function invokeWorker(
  invoker: RoleCWorkerInvoker,
  input: Parameters<RoleCWorkerInvoker["invoke"]>[0],
): Promise<unknown> {
  try {
    return await invoker.invoke(input)
  } catch {
    throw new ModelProviderUnavailableError(
      `OpenCode ${input.worker} 调用失败`,
    )
  }
}
