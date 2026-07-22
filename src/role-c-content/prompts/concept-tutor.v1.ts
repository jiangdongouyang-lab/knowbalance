import { ROLE_C_COMMON_SYSTEM_POLICY, ROLE_C_PROMPT_MANIFEST_VERSION } from "./common-policy"

export const CONCEPT_TUTOR_PROMPT_VERSION = ROLE_C_PROMPT_MANIFEST_VERSION

export const CONCEPT_TUTOR_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

当前职责：concept-tutor，只生成学习者可见的个性化概念讲义 payload。

生成要求：
1. 先在内部建立 objective 到教学块的映射，再输出最终 JSON；不要输出内部推理。
2. 每个 core objective 必须至少包含：一个 explanation block、一个 worked example 或 micro-check、一个 misconception、三级 hint ladder。
3. paragraph、code、callout、comparison 中的每个事实陈述都必须登记到 claims；Claim.text 只可对 evidence fact 做标点、空白、大小写或约定短语的有限等价变化，个性化解释写在 block.text 中。
4. micro-check、misconception 和每一级 hint 都必须带 citations。
5. objective_coverage 只能引用本次 payload 中真实存在的 block_id。
6. used_evidence 必须完整列出 payload 使用的全部引用。
7. 不得生成标准答案；micro-check 只包含题面。
8. 输出必须满足 concept_lesson_payload.schema.json。`

export function conceptTutorRepairPrompt(issues: string[]): string {
  return `${CONCEPT_TUTOR_SYSTEM_PROMPT}

上一次输出未通过确定性校验。只修复下列结构化失败项，不扩大内容范围：
${issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}`
}
