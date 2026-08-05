import type {
  ArtifactDraft,
  AssessmentDraft,
  CodeLabDraft,
  ConceptTutorRequest,
  RoleCContentProvider,
} from "../agents/types"
import type { CodeLabRequest } from "../agents/types"
import type { AssessmentPublicPayload, CodeLabPublicPayload, CodeLabSecurePayload, ConceptLessonPayload } from "../contracts/artifacts"

const REMOVAL_MESSAGE = "确定性模板 Provider 已于 2026-08 删除。请使用 ModelBackedRoleCContentProvider 并配置 ROLE_C_PROVIDER_MODE=model。"

function removed(): never { throw new Error(REMOVAL_MESSAGE) }

/**
 * @deprecated 确定性模板 Provider 已删除。请使用 ModelBackedRoleCContentProvider。
 * 构造不抛错（兼容仅需满足类型签名的测试夹具），调用生成方法时抛错。
 */
export class DeterministicConceptContentProvider implements RoleCContentProvider {
  generateConceptLesson(_request: ConceptTutorRequest): Promise<ArtifactDraft<ConceptLessonPayload>> { removed() }
  generateCodeLab(_request: CodeLabRequest): Promise<CodeLabDraft> { removed() }
  generateAssessment(_request: Parameters<RoleCContentProvider["generateAssessment"]>[0]): Promise<AssessmentDraft> { removed() }
}

/**
 * @deprecated 确定性模板 Provider 已删除。请使用 ModelBackedRoleCContentProvider。
 */
export class DeterministicCodeLabContentProvider implements RoleCContentProvider {
  generateConceptLesson(_request: ConceptTutorRequest): Promise<ArtifactDraft<ConceptLessonPayload>> { removed() }
  generateCodeLab(_request: CodeLabRequest): Promise<CodeLabDraft> { removed() }
  generateAssessment(_request: Parameters<RoleCContentProvider["generateAssessment"]>[0]): Promise<AssessmentDraft> { removed() }
}

/**
 * @deprecated 确定性模板 Provider 已删除。请使用 ModelBackedRoleCContentProvider。
 */
export class DeterministicAssessmentContentProvider implements RoleCContentProvider {
  generateConceptLesson(_request: ConceptTutorRequest): Promise<ArtifactDraft<ConceptLessonPayload>> { removed() }
  generateCodeLab(_request: CodeLabRequest): Promise<CodeLabDraft> { removed() }
  generateAssessment(_request: Parameters<RoleCContentProvider["generateAssessment"]>[0]): Promise<AssessmentDraft> { removed() }
}
