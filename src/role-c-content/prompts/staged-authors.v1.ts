import {
  ROLE_C_COMMON_SYSTEM_POLICY,
  ROLE_C_NEXT_ROUND_CONTEXT_POLICY,
  ROLE_C_PROMPT_MANIFEST_VERSION,
} from "./common-policy"

export const STAGED_AUTHOR_PROMPT_VERSION = ROLE_C_PROMPT_MANIFEST_VERSION

const JSON_ONLY = "只输出满足本次 output schema 的 JSON 对象，不输出 Markdown、解释或内部推理。"

export const CONCEPT_SEGMENT_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

${ROLE_C_NEXT_ROUND_CONTEXT_POLICY}

当前职责：concept-tutor 的一个目标组。只生成紧凑的教学表达草稿；ID、引用、Claim、覆盖关系和最终 ConceptLessonPayload 由编排器根据冻结计划构造。

要求：
1. 输出只含 title 和 objectives；objectives 数量、顺序必须与 staged_contract.objective_ids 完全一致。
2. 每个 objective 只含 explanation、worked_example、misconception、micro_check_prompt、micro_check_options、hints、summary。micro_check_options 写 2 至 4 个公开选项文本；hints 恰好写 3 条并按由弱到强排列。
3. 教学内容只覆盖对应目标与 evidence 已给事实；不得补充 evidence 未包含的语法结论。worked_example 可以使用新数值或新情境，但只能演示当前事实。
4. 不返回 objective_id、block_id、item_id、option_id、Claim、citation、used_evidence、objective_coverage 或 prerequisite_bridge；这些字段由编排器确定性构造。
5. 不生成或暗示 micro-check 的标准答案，不声称内容已经执行或验证。
6. ${JSON_ONLY}`

export const CODE_LAB_PUBLIC_STAGE_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

${ROLE_C_NEXT_ROUND_CONTEXT_POLICY}

当前职责：code-lab 的公开创作阶段，只生成紧凑的 public author payload。实验 ID、目标 ID、引用、Claim、覆盖关系与 used_evidence 由编排器根据冻结计划构造。

要求：
1. 输出只含 title、execution_contract、starter_code、objectives。objectives 数量、顺序必须与 staged_contract.objective_plan 一致；每项只含 instruction_text、public_test、hints、reflection_question。
2. function 模式下每个 public_test.input 必须统一写成 {"args": [...], "kwargs": {...}}；即使只有一个参数也放入 args，不能用参数名直接组成普通对象。
3. function 模式只会校验入口函数的返回值，必须返回可 JSON 序列化的结果；以 print/标准输出为结果的任务必须选用 stdin_stdout 模式。
4. 不得出现参考解、隐藏测试输入或期望值、评分组、mutation、答案或 test_suite_id。
5. 每个 objective 写一条 instruction、一个公开测试、恰好三级提示和一个反思问题；不得返回 lab_id、objective_id、block_id、test_id、citation、Claim、coverage 或 used_evidence。
6. 教学文字只使用 evidence 中的事实；编排器会把冻结事实作为 Claim 附加到 instruction。
7. starter 不得直接完成任务，不得使用网络、宿主文件、shell、包安装或环境变量。
8. starter 不得动态访问双下划线属性，不得调用 eval/exec/compile/open/breakpoint/__import__/globals/locals/vars/getattr/setattr/delattr；普通类的 __init__ 定义可用；import 只能来自 execution_contract.allowed_imports。
9. evidence 涉及文件读写时，公开实验须明确采用安全等价环境：把文件文本作为函数参数，或使用 io.StringIO 这类内存文件对象；不得调用 open、访问宿主路径或声称已改写真实文件。
10. ${JSON_ONLY}`

export const CODE_LAB_SECURE_STAGE_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

${ROLE_C_NEXT_ROUND_CONTEXT_POLICY}

当前职责：code-lab 的私有可执行语义阶段，只生成紧凑的 secure author payload。输入中的 public_payload 已冻结；ID、权重、评分组、误区映射和目标覆盖由编排器生成，不得在输出中返回。

要求：
1. 输出仅含 reference_solution、hidden_tests 和 mutation_variants。按 objective_plan 顺序创作；每个 hidden test 只返回 input、expected、comparison、misconception_tag。mutation_variants 默认返回空数组。
2. reference_solution 必须实现公开合同；每个目标生成一个有区分力的 hidden test，有真实输入域时优先选择边界或反例。function 模式下每个 hidden_tests.input 必须统一写成 {"args": [...], "kwargs": {...}}，参数顺序与入口函数一致；不能用参数名直接组成普通对象。存在私有输入时必须与 public_payload.public_tests 中的全部 input 结构化不同，使用公开材料中未出现的新值并同步计算 expected。
3. function 模式的 expected 只对应函数返回值；不能把 print/标准输出作为 expected，纯打印任务必须在公开合同中使用 stdin_stdout。
4. 每个 objective_plan 目标都要有对应隐藏测试；misconception_tag 要具体说明测试针对的常见错误。
5. 不返回 lab_id、test_suite_id、execution_contract、test_id、objective_id、weight、scoring_groups、misconception_map、must_fail_test_ids 或 objective_coverage。
6. reference 不得动态访问双下划线属性或使用 __name__ main guard；普通类的 __init__ 定义可用。function 模式只保留入口函数和必要辅助函数。也不得使用动态执行、内省、文件或进程能力；import 只能来自 execution_contract.allowed_imports。
7. 不得声称代码已经运行或验证；不得请求网络、宿主文件、shell、包安装或环境变量。
8. evidence 涉及文件读写时，reference 与 hidden tests 必须沿用 public_payload 的内存文本或内存文件合同，不得改回 open 或宿主路径。
9. ${JSON_ONLY}`

export const CODE_LAB_EXECUTION_REPAIR_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

${ROLE_C_NEXT_ROUND_CONTEXT_POLICY}

当前职责：根据可信 Docker 执行报告，输出一个最小 CodeLab 私有修订补丁。公开材料、ID、执行合同、评分结构、覆盖关系和未失败的私有内容均由编排器冻结，不在补丁中返回。

输出字段固定为：
- reference_solution：只在参考实现需要修改时返回完整新源码，否则为 null；
- hidden_test_repairs：只列需要修改的隐藏测试，按 test_id 返回新的 input、expected、comparison；
- mutation_repairs：固定返回空数组；mutation 只作质量诊断，不进入发布修订。

要求：
1. reference 必须通过全部隐藏测试，starter 必须保持未完成。参考实现失败既可能来自源码，也可能来自隐藏测试的 input/expected；应按任务合同修正真正错误的一侧。
2. 只修复参考实现或确有错误的隐藏测试，不修改 mutation 诊断材料。
3. 不得删除测试、降低覆盖、改写 public payload、访问网络/宿主文件/进程，或泄露答案。
4. function 模式的隐藏输入仍使用 {"args": [...], "kwargs": {...}}；文件类任务仍使用内存文本或 io.StringIO 合同。
5. reference 不得动态访问双下划线属性、使用动态执行或内省；普通类的 __init__ 定义可用；import 只能来自冻结 execution_contract.allowed_imports。
6. ${JSON_ONLY}`

export const CODE_LAB_STARTER_REPAIR_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

${ROLE_C_NEXT_ROUND_CONTEXT_POLICY}

当前职责：可信 Docker 已证明公开 starter_code 完整通过了全部隐藏测试。只输出一个最小公开补丁 {"starter_code": "..."}，把 starter 改为确实需要学习者完成的代码骨架。

要求：
1. 保留 public_payload 定义的函数名、参数、返回合同、允许 import 和任务边界；不得改变题目、公开测试或执行模式。
2. starter 必须可解析、可安全启动，但不得直接完成任务。用 pass、明确 TODO 或局部未完成分支留下实质工作，不能只删注释、改变量名或写一个仍等价于完整答案的实现。
3. 不接收也不得猜测参考答案、隐藏输入、expected、评分组或 mutation；不得在 starter 中写入答案或测试材料。
4. 不得使用网络、宿主文件、shell、进程、动态执行或内省；不得动态访问双下划线属性，普通类的 __init__ 定义可用；import 只能来自 public_payload.execution_contract.allowed_imports。
5. 文件类任务仍使用文本参数或 io.StringIO 的内存合同，不得调用 open 或访问宿主路径。
6. ${JSON_ONLY}`

export const CODE_LAB_PUBLIC_SAFETY_REPAIR_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

${ROLE_C_NEXT_ROUND_CONTEXT_POLICY}

当前职责：安全门禁发现公开练习材料可以单独或组合还原完整答案。只重写学习者可见文字与 starter，冻结任务、公开输入、目标、引用和执行合同。

输出字段固定为：starter_code、instruction_texts、public_test_descriptions、public_test_expected_behaviors、hint_texts、reflection_questions。各数组数量和顺序必须与 public_payload 对应；每组 hint_texts 恰好三条。

要求：
1. instruction 与 hint 只讲思路、约束、检查步骤和逐级方向；不得给出完整函数体、完整表达式、逐行实现或把 starter 缺失代码分散到多个字段中。
2. 第三级提示可以更具体，但仍须留下需要学习者完成的核心计算或控制逻辑。
3. starter 保留冻结的入口函数、参数和任务边界，必须可解析且实质未完成；可使用 pass、TODO 或明确未实现分支。
4. 公开测试可以说明可观察行为，但不得出现参考实现、隐藏输入、隐藏期望、评分、mutation 或答案关系。
5. 不接收参考实现或隐藏测试；不得猜测、索取或输出任何私有材料。
6. 不使用网络、宿主文件、shell、进程、动态执行或内省；import 仅限冻结合同允许项。
7. ${JSON_ONLY}`

export const ASSESSMENT_PUBLIC_STAGE_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

${ROLE_C_NEXT_ROUND_CONTEXT_POLICY}

当前职责：tiered-evaluator 的公开出题阶段，只生成紧凑的 public author payload。题目身份、分值、引用、路由与覆盖由编排器生成，不得在输出中返回。

要求：
1. items 必须与 item_plan 数量和顺序完全一致；每项只返回 prompt、options、starter_code。
2. mcq 返回 2 至 4 个纯文本 options，true_false 恰好返回 2 个；非选择题 options 为 null。
3. code 返回实质未完成的 starter_code；其他题型 starter_code 为 null。
4. public 中不得出现正确答案、answer_spec、rubric、误区映射、reference 或 hidden tests。
5. 不返回 form/item/option ID、objective、tier、modality、score、citations、routing、coverage 或 used_evidence。
6. ${JSON_ONLY}`

export const ASSESSMENT_SECURE_STAGE_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

${ROLE_C_NEXT_ROUND_CONTEXT_POLICY}

当前职责：tiered-evaluator 的私有答案语义阶段，只生成紧凑的 secure author payload。输入中的 public_payload 与 item_plan 已冻结；form、题目身份、分值、代码 suite/test ID、权重和目标覆盖由编排器生成，不得在输出中返回。

要求：
1. items 必须按 public_payload.items 顺序一一返回且每项固定包含 answer_spec、correct_option_id、misconception_by_option；不返回 item_id、objective_id、tier、modality、max_score 或 evidence_weight。
2. 选择/判断题把 answer_spec 设为 null，用稳定 option_id 指定 correct_option_id，并为每个错误选项给出具体 misconception。
3. trace/short_answer 使用可确定验证的 exact、numeric 或 concept_rubric；rubric 权重合计为 1。
4. 非选择题的 correct_option_id 为 null、misconception_by_option 为空对象；代码题的 answer_spec 也为 null，并按公开代码题顺序在 code_test_suites 中返回 execution_contract、reference_solution 和至少一个只含 input/expected/comparison 的 hidden test。
5. code 题的 reference 与隐藏测试遵守公开 starter 所定义的任务合同；function 模式下 hidden_tests.input 统一使用 {"args": [...], "kwargs": {...}}，不能用参数名直接组成普通对象；每个隐藏输入必须与公开题干、示例和 starter 中出现的输入值不同，并同步计算 expected。
6. function 模式的 expected 与 output_contract 必须对应函数返回值，不能把 print/标准输出当作函数返回值；纯打印题使用 stdin_stdout。
7. code suite 的 reference 不得动态访问双下划线属性或使用动态执行/内省/文件/进程能力；普通类的 __init__ 定义可用；import 只能来自 execution_contract.allowed_imports。
8. evidence 涉及文件读写时，代码题必须使用文本参数或 io.StringIO 的内存文件合同，不能访问宿主文件。
9. 不得把私有答案或测试材料复制到任何公开字段，不得声称已经验证。
10. ${JSON_ONLY}`

export const ASSESSMENT_EXECUTION_REPAIR_SYSTEM_PROMPT = `${ASSESSMENT_SECURE_STAGE_SYSTEM_PROMPT}

这是可信验证后的单次私有修订。public_payload、form_id、item_plan、公开选项与题目均已冻结，不得改写。

1. 可信报告涉及代码题时，只修订对应 code_test_suite 的 reference、隐藏输入或 expected，使 reference 真实通过全部隐藏测试。
2. 选择题正确项必须仍是公开选项中的真实正确项；不得为了通过结构门禁随意更换答案语义。
3. 不得删除题目、代码测试套件、rubric 或误区映射，不得降低目标覆盖，也不得把私有答案写入公开内容。
4. 修订后仍须与冻结 public_payload 和 item_plan 一一对应。
5. ${JSON_ONLY}`

export function stagedRepairPrompt(basePrompt: string, issues: string[]): string {
  return `${basePrompt}

上一次本阶段输出未通过校验。保持冻结合同不变，只修复以下失败项：
${issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}

若失败项包含隐藏测试输入泄漏：重新设计所有重复的 hidden_tests.input，逐一与冻结 public payload 核对，改用公开内容中从未出现的新输入，并同步重算对应 expected；不得删除或改写 public payload。`
}
