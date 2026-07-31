import type { KnowledgeBase } from "../../knowledge/types"
import { planRecoveryPath } from "../../role-b-profile/teaching-audit/path-planner"
import type {
  TeachingAuditDimension,
  TeachingAuditResult,
} from "../../role-b-profile/teaching-audit/types"
import type { LearnerProfile } from "../../role-b-profile/types"
import type {
  RoleBPathPlanningPort,
  RoleBPathPlanningRequest,
  RoleBPathPlanningResult,
} from "../contracts/recovery"

/**
 * Adapts B's current in-process planner to C's recovery boundary.
 * Structured audit fields from the request are passed through to B without
 * rerunning the teaching audit or choosing another recovery action.
 */
export function createLocalBPathPlanningPort(
  knowledgeBase: KnowledgeBase,
): RoleBPathPlanningPort {
  const localKnowledgeBase = structuredClone(knowledgeBase)
  return {
    async replanLearningPath(
      request: RoleBPathPlanningRequest,
    ): Promise<RoleBPathPlanningResult> {
      if (request.required_action !== "replan_path"
        || request.fix_scope !== "new_spec") {
        return blockedResult(
          request,
          "BLOCKED",
          "本地 B 路径规划仅接受 replan_path/new_spec 请求",
        )
      }
      try {
        const planned = planRecoveryPath({
          learnerProfile: profileForB(request),
          knowledgeBase: localKnowledgeBase,
          auditResult: auditForB(request),
          currentPathNode: {
            target_source_ids: [
              ...request.current_path_node.target_source_ids,
            ],
            prerequisite_source_ids: [
              ...request.current_path_node.prerequisite_source_ids,
            ],
            goal: request.current_path_node.goal,
          },
        })
        if (planned.pathNode.target_source_ids.length === 0
          || planned.pathNode.objectives.length === 0) {
          return blockedResult(
            request,
            "UNSUPPORTED_TARGET",
            "B 路径规划未找到可用的目标知识点",
            "UNSUPPORTED_TARGET",
          )
        }
        return {
          status: "ready",
          request_id: request.request_id,
          path_draft: structuredClone(planned.pathNode),
        }
      } catch {
        return blockedResult(
          request,
          "BLOCKED",
          "本地 B 路径规划执行失败",
        )
      }
    },
  }
}

function profileForB(request: RoleBPathPlanningRequest): LearnerProfile {
  return {
    learner_id: request.profile_snapshot.learner_id,
    level: request.profile_snapshot.level,
    known_concepts: [...request.profile_snapshot.known_concepts],
    weak_concepts: [...request.profile_snapshot.weak_concepts],
    goal: request.profile_snapshot.goal,
  }
}

function auditForB(
  request: RoleBPathPlanningRequest,
): TeachingAuditResult {
  const failed = new Set(request.failed_dimensions)
  const difficultyFailed = failed.has("difficulty_alignment")
  const prerequisiteFailed = failed.has("prerequisite_coverage")
  const weakConceptFailed = failed.has("weak_concept_coverage")
  const goalFailed = failed.has("goal_alignment")
  return {
    artifactId: request.current_spec_id,
    learnerId: request.profile_snapshot.learner_id,
    status: "reject",
    checks: {
      difficulty: {
        dimension: "difficulty_alignment",
        verdict: difficultyFailed ? "misaligned" : "aligned",
        learnerLevel: request.profile_snapshot.level,
        contentMaxDifficulty: null,
        reason: "由 C 恢复请求中的结构化审核字段提供",
      },
      prerequisite: {
        dimension: "prerequisite_coverage",
        verdict: prerequisiteFailed ? "misaligned" : "aligned",
        checkedConcepts: [],
        reason: "由 C 恢复请求中的结构化审核字段提供",
      },
      weakConcept: {
        dimension: "weak_concept_coverage",
        verdict: weakConceptFailed ? "incomplete" : "aligned",
        learnerWeakConcepts: [
          ...request.profile_snapshot.weak_concepts,
        ],
        coveredWeakConcepts: [],
        uncoveredWeakConcepts: weakConceptFailed
          ? [...request.profile_snapshot.weak_concepts]
          : [],
        reason: "由 C 恢复请求中的结构化审核字段提供",
      },
      goal: {
        dimension: "goal_alignment",
        verdict: goalFailed ? "misaligned" : "aligned",
        learnerGoal: request.profile_snapshot.goal,
        reason: "由 C 恢复请求中的结构化审核字段提供",
      },
    },
    summary: "使用 C 恢复请求携带的结构化 B 审核结果规划路径",
    revisionHints: [...request.review_instruction_ids],
    failedDimensions: [
      ...request.failed_dimensions,
    ] as TeachingAuditDimension[],
    missingPrerequisiteSourceIds: [
      ...request.missing_prerequisite_source_ids,
    ],
    unknownPrerequisiteRefs: [],
    requiredAction: request.required_action,
    fixScope: request.fix_scope,
    recommendedLevel: request.recommended_level ?? null,
    canRecover: true,
  }
}

function blockedResult(
  request: RoleBPathPlanningRequest,
  code: "BLOCKED" | "UNSUPPORTED_TARGET",
  reason: string,
  extraDimension?: string,
): RoleBPathPlanningResult {
  return {
    status: "blocked",
    request_id: request.request_id,
    code,
    reason,
    failed_dimensions: unique([
      ...request.failed_dimensions,
      ...(extraDimension ? [extraDimension] : []),
    ]),
    missing_prerequisite_source_ids: [
      ...request.missing_prerequisite_source_ids,
    ],
    ...(request.recommended_level
      ? { recommended_level: request.recommended_level }
      : {}),
    can_recover: false,
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
