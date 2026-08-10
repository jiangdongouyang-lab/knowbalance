// 输入: 三份证据 JSON（背景 / 自评 / 客观诊断）+ 知识库 + 可选兜底 learner_id
// 输出: 标准画像 + 完整溯源 + ready-to-send rag_request（纯函数，无 IO，KB 由调用方注入）
// 合成规则（与 prompts.ts 中给 LLM 的规则同源，本文件是唯一可验证实现）:
//   1. 证据强度 objective(3) > self(2) > background(1)，强证据覆盖弱证据
//   2. 自评与客观冲突时客观获胜，且冲突必须显式记录（交给 D 展示，不静默消化）
//   3. level 保守更新: 客观答错某难度 → 封顶到该难度前一档（floor=beginner）；
//      至少 3 道客观题全部答对时，可在自评基础上最多上调一档且不超过已覆盖难度；
//      其余情况用自评，都没有则默认 beginner
//   4. goal 缺失直接报错：宁可让 orchestrator 用 question 补问，禁止编造目标
import { canonicalizeConcept } from "./concept-canonicalizer"
import type { KnowledgeBase, KnowledgeDifficulty } from "../knowledge/types"
import type {
  BackgroundEvidence,
  ConceptProvenance,
  ObjectiveDiagnosisEvidence,
  ProfileConflict,
  ProfileProvenance,
  ProfileSynthesis,
  SelfAssessmentEvidence,
} from "./types"
import { buildRagRequest } from "./rag-bridge"

const LEVEL_ORDER: readonly KnowledgeDifficulty[] = ["beginner", "basic", "intermediate", "integrated"]

const EVIDENCE_STRENGTH = { objective: 3, self: 2, background: 1 } as const

type EvidenceSource = keyof typeof EVIDENCE_STRENGTH

interface ConceptClaim {
  canonical: string
  bucket: "known" | "weak"
  source: EvidenceSource
  matched: boolean
  sourceIds: string[]
}

export interface SynthesizeProfileInput {
  background: BackgroundEvidence
  selfAssessment: SelfAssessmentEvidence
  objectiveDiagnosis: ObjectiveDiagnosisEvidence
  knowledgeBase: KnowledgeBase
  fallbackLearnerId?: string
}

export function synthesizeProfile(input: SynthesizeProfileInput): ProfileSynthesis {
  const { background, selfAssessment, objectiveDiagnosis, knowledgeBase } = input

  const goal = background.goal_raw?.trim() ?? ""
  if (goal.length === 0) {
    throw new Error("学习者目标缺失：orchestrator 应通过 question 工具补问 goal，禁止编造目标")
  }

  // 第一步：把三类证据统一成概念主张列表
  const claims: ConceptClaim[] = []
  const objectiveCanonicalBySource = new Map<string, Set<string>>()

  for (const item of objectiveDiagnosis.items) {
    if (item.verdict === "unanswered") continue
    const mapped = canonicalizeConcept(item.concept, knowledgeBase)
    const sourceIds = [...new Set([...(mapped.matched ? mapped.sourceIds : []), item.source_id])].sort()
    const sourceCanonicals = objectiveCanonicalBySource.get(item.source_id) ?? new Set<string>()
    sourceCanonicals.add(mapped.canonical)
    objectiveCanonicalBySource.set(item.source_id, sourceCanonicals)
    claims.push({
      canonical: mapped.canonical,
      bucket: item.verdict === "correct" ? "known" : "weak",
      source: "objective",
      matched: mapped.matched,
      sourceIds,
    })
  }

  for (const raw of selfAssessment.claimed_known) {
    const mapped = alignToObjectiveSource(raw, knowledgeBase, objectiveCanonicalBySource)
    claims.push({ canonical: mapped.canonical, bucket: "known", source: "self", matched: mapped.matched, sourceIds: mapped.sourceIds })
  }
  for (const raw of selfAssessment.claimed_weak) {
    const mapped = alignToObjectiveSource(raw, knowledgeBase, objectiveCanonicalBySource)
    claims.push({ canonical: mapped.canonical, bucket: "weak", source: "self", matched: mapped.matched, sourceIds: mapped.sourceIds })
  }

  for (const raw of background.prior_topics) {
    const mapped = alignToObjectiveSource(raw, knowledgeBase, objectiveCanonicalBySource)
    claims.push({ canonical: mapped.canonical, bucket: "known", source: "background", matched: mapped.matched, sourceIds: mapped.sourceIds })
  }

  // 第二步：同概念按证据强度归并
  const resolved = new Map<string, ConceptClaim>()
  for (const claim of claims) {
    const existing = resolved.get(claim.canonical)
    if (!existing) {
      resolved.set(claim.canonical, claim)
      continue
    }
    const stronger = EVIDENCE_STRENGTH[claim.source] > EVIDENCE_STRENGTH[existing.source]
    const sameStrengthButWeak =
      EVIDENCE_STRENGTH[claim.source] === EVIDENCE_STRENGTH[existing.source] &&
      claim.bucket === "weak" &&
      existing.bucket === "known"
    if (stronger || sameStrengthButWeak) {
      resolved.set(claim.canonical, claim)
    }
  }

  // 第三步：自评空洞修复
  // D 砍掉自评环节 → claimed_known/claimed_weak 为空 → ProfileConflict 断路。
  // 从客观诊断反向填充自评，激活冲突检测。
  // 注意：不直接改 input.selfAssessment（避免副作用污染调用方），用局部副本。
  const patchedSelfAssessment: SelfAssessmentEvidence = {
    ...selfAssessment,
    claimed_known: [...selfAssessment.claimed_known],
    claimed_weak: [...selfAssessment.claimed_weak],
  }

  if (
    patchedSelfAssessment.claimed_known.length === 0 &&
    patchedSelfAssessment.claimed_weak.length === 0
  ) {
    for (const item of objectiveDiagnosis.items) {
      if (item.verdict === "unanswered") continue
      const canonical = canonicalizeConcept(item.concept, knowledgeBase).canonical
      if (item.verdict === "correct") {
        if (!patchedSelfAssessment.claimed_known.includes(canonical)) {
          patchedSelfAssessment.claimed_known.push(canonical)
        }
      } else {
        if (!patchedSelfAssessment.claimed_weak.includes(canonical)) {
          patchedSelfAssessment.claimed_weak.push(canonical)
        }
      }
    }
  }

  // 第四步：记录自评 vs 客观的冲突（使用修补后的副本）
  const conflicts: ProfileConflict[] = []
  for (const item of objectiveDiagnosis.items) {
    if (item.verdict === "unanswered") continue
    const canonical = canonicalizeConcept(item.concept, knowledgeBase).canonical
    const selfSaysKnown = patchedSelfAssessment.claimed_known.some(
      (raw) => alignToObjectiveSource(raw, knowledgeBase, objectiveCanonicalBySource).canonical === canonical,
    )
    const selfSaysWeak = patchedSelfAssessment.claimed_weak.some(
      (raw) => alignToObjectiveSource(raw, knowledgeBase, objectiveCanonicalBySource).canonical === canonical,
    )
    if (selfSaysKnown && item.verdict === "incorrect") {
      conflicts.push({
        concept: canonical,
        selfClaim: "known",
        objectiveVerdict: "incorrect",
        resolution: "weak",
        rule: "客观测试答错覆盖自评掌握（objective > self）",
      })
    }
    if (selfSaysWeak && item.verdict === "correct") {
      conflicts.push({
        concept: canonical,
        selfClaim: "weak",
        objectiveVerdict: "correct",
        resolution: "known",
        rule: "客观测试答对覆盖自评薄弱（objective > self）",
      })
    }
  }

  // 第五步：level 判定级联
  const levelResolution = resolveLevel(selfAssessment.self_rating, objectiveDiagnosis)

  const ordered = [...resolved.values()].sort(
    (left, right) => EVIDENCE_STRENGTH[right.source] - EVIDENCE_STRENGTH[left.source],
  )
  const knownConcepts = ordered.filter((claim) => claim.bucket === "known").map((claim) => claim.canonical)
  const weakConcepts = ordered.filter((claim) => claim.bucket === "weak").map((claim) => claim.canonical)

  const conceptProvenance: ConceptProvenance[] = ordered.map((claim) => ({
    concept: claim.canonical,
    bucket: claim.bucket,
    source: claim.source,
    canonical: claim.matched,
    matched_source_ids: claim.sourceIds,
  }))

  const provenance: ProfileProvenance = {
    level: levelResolution,
    concepts: conceptProvenance,
    conflicts,
    unmapped_concepts: ordered.filter((claim) => !claim.matched).map((claim) => claim.canonical),
  }

  const profile = {
    learner_id: background.learner_id ?? input.fallbackLearnerId ?? "anonymous_learner",
    level: levelResolution.value,
    known_concepts: knownConcepts,
    weak_concepts: weakConcepts,
    goal,
  }

  return { profile, provenance, rag_request: buildRagRequest(profile) }
}

function alignToObjectiveSource(
  raw: string,
  knowledgeBase: KnowledgeBase,
  objectiveCanonicalBySource: Map<string, Set<string>>,
): ReturnType<typeof canonicalizeConcept> {
  const mapped = canonicalizeConcept(raw, knowledgeBase)
  const objectiveCanonicals = new Set(mapped.sourceIds.flatMap((sourceId) => [...(objectiveCanonicalBySource.get(sourceId) ?? [])]))
  if (objectiveCanonicals.size !== 1) return mapped
  return {
    ...mapped,
    canonical: [...objectiveCanonicals][0]!,
  }
}

function resolveLevel(
  selfRating: KnowledgeDifficulty | null,
  objectiveDiagnosis: ObjectiveDiagnosisEvidence,
): ProfileProvenance["level"] {
  const incorrectLevels = objectiveDiagnosis.items
    .filter((item) => item.verdict === "incorrect")
    .map((item) => LEVEL_ORDER.indexOf(item.difficulty))
    .filter((index) => index >= 0)

  const selfIndex = selfRating ? LEVEL_ORDER.indexOf(selfRating) : null

  if (incorrectLevels.length > 0) {
    const easiestFailure = Math.min(...incorrectLevels)
    const cap = Math.max(0, easiestFailure - 1)
    const finalIndex = selfIndex === null ? cap : Math.min(selfIndex, cap)
    return {
      value: LEVEL_ORDER[finalIndex],
      source: "objective_cap",
      rule: `客观答错难度 ${LEVEL_ORDER[easiestFailure]} → level 封顶 ${LEVEL_ORDER[cap]}；自评 ${selfRating ?? "无"} 取两者较低`,
    }
  }

  const answeredItems = objectiveDiagnosis.items.filter((item) => item.verdict !== "unanswered")
  if (answeredItems.length >= 3 && answeredItems.every((item) => item.verdict === "correct")) {
    const coveredLevel = Math.max(...answeredItems.map((item) => LEVEL_ORDER.indexOf(item.difficulty)).filter((index) => index >= 0))
    const baseline = selfIndex ?? 0
    const promoted = Math.min(baseline + 1, coveredLevel)
    if (promoted > baseline) {
      return {
        value: LEVEL_ORDER[promoted],
        source: "objective_promotion",
        rule: `至少 3 道客观题全部答对 → 在自评 ${selfRating ?? "无"} 基础上最多上调一档，且不超过已覆盖难度 ${LEVEL_ORDER[coveredLevel]}`,
      }
    }
  }

  if (selfIndex !== null) {
    return {
      value: LEVEL_ORDER[selfIndex],
      source: "self_rating",
      rule: "无客观封顶信号，采用学习者自评档位",
    }
  }

  return {
    value: "beginner",
    source: "default",
    rule: "无自评且无客观信号，保守默认 beginner",
  }
}
