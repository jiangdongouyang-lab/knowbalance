// 输入: examples/learner_evidence_loop_weak.json（三份证据样例）
// 输出: stdout JSON —— B 画像链端到端演示：证据 → 合成画像 → rag_request → A 检索结果
// 运行: bun src/role-b-profile/profile-demo.ts
// 作用: 不需要任何模型凭证即可验证 B 链路，是 B 角色对 docx §6 验收标准
// （能拿到 K007/K009/K018 等相关知识点）的可执行证明。
import { loadKnowledgeBase } from "../knowledge/loader"
import { synthesizeProfile } from "./profile-synthesizer"
import { executeProfileRetrieval } from "./rag-bridge"
import type { BackgroundEvidence, ObjectiveDiagnosisEvidence, SelfAssessmentEvidence } from "./types"

const EVIDENCE_FILE = "examples/learner_evidence_loop_weak.json"

interface EvidenceBundle {
  description: string
  learner_request: string
  background: BackgroundEvidence
  self_assessment: SelfAssessmentEvidence
  objective_diagnosis: ObjectiveDiagnosisEvidence
}

const bundle = (await Bun.file(EVIDENCE_FILE).json()) as EvidenceBundle
const knowledgeBase = await loadKnowledgeBase()

const synthesis = synthesizeProfile({
  background: bundle.background,
  selfAssessment: bundle.self_assessment,
  objectiveDiagnosis: bundle.objective_diagnosis,
  knowledgeBase,
})

const { rag_request, rag_result } = await executeProfileRetrieval(synthesis.profile)

console.log(
  JSON.stringify(
    {
      workflow: "B_evidence_to_profile_to_A_rag",
      evidence_source: EVIDENCE_FILE,
      learner_request: bundle.learner_request,
      b_profile: synthesis.profile,
      b_provenance: synthesis.provenance,
      a_rag_request: rag_request,
      a_rag_result_top: rag_result.results.map((item) => ({
        source_id: item.source_id,
        title: item.title,
        difficulty: item.difficulty,
        score: item.score,
        reason: item.reason,
      })),
    },
    null,
    2,
  ),
)
