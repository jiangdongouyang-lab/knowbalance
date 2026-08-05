export * from "./model-backed-provider"
export * from "./model-backed-provider-env"
export * from "./staged-generation"
export * from "./opencode-worker-provider"

// ── 确定性模板 Provider 已删除（仅保留兼容类型导出，构造时抛错） ──
export {
  DeterministicConceptContentProvider,
  DeterministicCodeLabContentProvider,
  DeterministicAssessmentContentProvider,
} from "./deterministic-provider-removed"
