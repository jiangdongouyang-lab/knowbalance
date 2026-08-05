import {
  ROLE_C_COMMON_SYSTEM_POLICY,
  ROLE_C_NEXT_ROUND_CONTEXT_POLICY,
} from "../common-policy"

const JSON_ONLY = "只输出满足本次 output schema 的 JSON 对象，不输出 Markdown、解释或内部推理。"

/**
 * Code Lab 可信执行修订提示词。
 * 根据 Docker 执行报告修复私有内容，不修改公开材料。
 *
 * 修复策略：
 * - 参考实现失败：先检查是否隐藏测试的 input/expected 有误，再检查源码逻辑
 * - 隐藏测试失败：只修复真正有错误的测试，不修改已经通过的部分
 * - 最小改动原则：只改动必要的部分，不重写整个 secure payload
 */
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
