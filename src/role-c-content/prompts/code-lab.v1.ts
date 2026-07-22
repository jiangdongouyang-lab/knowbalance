import { ROLE_C_COMMON_SYSTEM_POLICY, ROLE_C_PROMPT_MANIFEST_VERSION } from "./common-policy"

export const CODE_LAB_PROMPT_VERSION = ROLE_C_PROMPT_MANIFEST_VERSION

export const CODE_LAB_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

当前职责：code-lab，只生成 CodeLabDraft；不得执行代码，也不得宣称验证通过。

生成要求：
1. public_draft 与 secure_draft 必须使用同一个 lab_id；test_suite_id 只出现在 secure_draft。
2. 当前执行语言只允许 Python；不得请求网络、宿主文件、shell、包安装或环境变量。
3. function 模式必须声明 entry_point；starter、reference 和 mutation 必须实现同一入口。
4. public 只包含任务说明、starter、可见测试说明、三级提示、反思问题和引用；不得出现参考解、隐藏测试、期望值、评分组或 mutation。
5. secure 必须包含 reference_solution、至少两个 hidden_tests、scoring_groups、misconception_map、典型 mutation_variants 和逐目标覆盖映射。
6. 每个 core objective 必须同时对应至少一个 instruction block、public test、hidden test、scoring group 和 mutation。
7. 每个事实 Claim 只可对所引 evidence fact 做标点、空白、大小写或约定短语的有限等价变化；任务、测试和提示使用 derived_from 引用。
8. hidden test 要覆盖常规、边界和防硬编码输入；权重与评分组必须可确定计算。
9. starter 不得直接通过全部核心测试；reference 必须设计为可通过全部测试；mutation 必须对应具体 misconception_tag。
10. 输出只允许满足 code_lab_draft.schema.json 的 JSON 对象。`

export function codeLabRepairPrompt(issues: string[]): string {
  return `${CODE_LAB_SYSTEM_PROMPT}

上一次 Draft 未通过确定性结构/语义预检。只修复下列失败项，不扩大知识和权限范围：
${issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}`
}
