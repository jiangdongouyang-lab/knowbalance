import { ROLE_C_COMMON_SYSTEM_POLICY, ROLE_C_PROMPT_MANIFEST_VERSION } from "./common-policy"

export const STAGED_AUTHOR_PROMPT_VERSION = ROLE_C_PROMPT_MANIFEST_VERSION

const JSON_ONLY = "只输出满足本次 output schema 的 JSON 对象，不输出 Markdown、解释或内部推理。"

export const CONCEPT_SEGMENT_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

当前职责：concept-tutor 的一个目标组。输入只包含本组学习目标与对应证据；生成一份完整、可独立校验的 ConceptLessonPayload。

要求：
1. 只覆盖输入 contract.targets，不引用其他学习目标。
2. 每个 core objective 至少有 explanation、worked example 或 micro-check、misconception 与三级 hint ladder。
3. Claim.text 只可对 evidence fact 做标点、空白、大小写或约定短语的有限等价变化；个性化解释放在 block.text。
4. objective_coverage 只能引用本次 payload 真实存在的 block_id；used_evidence 与实际引用完全一致。
5. 输入没有 prerequisite evidence 时 prerequisite_bridge 必须为空。
6. 不生成标准答案，micro-check 只含公开题面。
7. ${JSON_ONLY}`

export const CODE_LAB_PUBLIC_STAGE_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

当前职责：code-lab 的公开创作阶段，只生成 CodeLabPublicPayload。

要求：
1. lab_id 与 objective_ids 是编排器提供的冻结合同，必须原样返回；本阶段定义的 execution_contract 将在后续阶段被冻结。
2. 只生成任务说明、Python starter、公开测试说明、三级提示、反思问题和引用。
3. 不得出现参考解、隐藏测试输入或期望值、评分组、mutation、答案或 test_suite_id。
4. 每个 core objective 都要有可追踪的 instruction claim、public test 与三级提示。
5. Claim.text 只可对所引 fact 做标点、空白、大小写或约定短语的有限等价变化；used_evidence 与实际引用完全一致。
6. starter 不得直接完成任务，不得使用网络、宿主文件、shell、包安装或环境变量。
7. starter 不得出现双下划线标识符，不得调用 eval/exec/compile/open/breakpoint/__import__/globals/locals/vars/getattr/setattr/delattr；import 只能来自 execution_contract.allowed_imports。
8. ${JSON_ONLY}`

export const CODE_LAB_SECURE_STAGE_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

当前职责：code-lab 的私有验证材料阶段，只生成 CodeLabSecurePayload。输入中的 public_payload 已冻结，不得改写。

要求：
1. lab_id、test_suite_id 与 execution_contract 必须原样返回。
2. reference_solution 必须实现公开合同；hidden_tests 至少覆盖常规与边界输入。
3. 每个 core objective 都要有 hidden test、scoring group 和可被指定测试杀死的 mutation。
4. hidden test 与 scoring group 权重分别合计为 1；每个隐藏测试只属于一个评分组并有 misconception 映射。
5. reference 与 mutation 不得出现双下划线标识符、动态执行/内省/文件或进程能力；import 只能来自 execution_contract.allowed_imports。
6. 不得声称代码已经运行或验证；不得请求网络、宿主文件、shell、包安装或环境变量。
7. ${JSON_ONLY}`

export const ASSESSMENT_PUBLIC_STAGE_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

当前职责：tiered-evaluator 的公开出题阶段，只生成 AssessmentPublicPayload。

要求：
1. form_id、objective_ids 与 item_plan 是冻结合同。items 必须与 item_plan 数量、顺序及 item_id/family_id/variant_id/display_no/objective_id/tier/modality/max_score 完全一致。
2. 模型只创作 title、题干、选择项文本、代码 starter 与证据引用。
3. mcq/true_false 必须有 2 至 4 个稳定 option_id；code 必须有 starter_code；其他题型不得携带这些字段。
4. public 中不得出现正确答案、answer_spec、rubric、误区映射、reference 或 hidden tests。
5. 每题必须引用所属目标的 required fact；used_evidence 与实际引用完全一致。
6. routing、submission_policy 与 objective_coverage 将由编排器确定性生成，仍需输出合法字段但不得依赖其自拟语义。
7. ${JSON_ONLY}`

export const ASSESSMENT_SECURE_STAGE_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

当前职责：tiered-evaluator 的私有答案阶段，只生成 AssessmentSecurePayload。输入中的 public_payload 与 item_plan 已冻结，不得改写公开题目。

要求：
1. form_id、option_order_seed 和每个 secure item 的 item_id/objective_id/tier/modality/max_score 必须与冻结合同一致。
2. 选择/判断题用稳定 option_id 指定 correct_option_id；answer_spec 只能接受该 ID，每个错误选项必须有具体 misconception。
3. trace/short_answer 使用可确定验证的 exact、numeric 或 concept_rubric；rubric 权重合计为 1。
4. code 题必须有且只有一个对应 code_test_suite，reference 与隐藏测试遵守公开 starter 所定义的任务合同。
5. code suite 的 reference 不得出现双下划线标识符、动态执行/内省/文件或进程能力；import 只能来自 execution_contract.allowed_imports。
6. 不得把私有答案或测试材料复制到任何公开字段，不得声称已经验证。
7. ${JSON_ONLY}`

export function stagedRepairPrompt(basePrompt: string, issues: string[]): string {
  return `${basePrompt}

上一次本阶段输出未通过校验。保持冻结合同不变，只修复以下失败项：
${issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}`
}
