import {
  ROLE_C_COMMON_SYSTEM_POLICY,
  ROLE_C_NEXT_ROUND_CONTEXT_POLICY,
} from "../common-policy"

/**
 * Code Lab 私有可执行语义阶段提示词。
 * 只生成 secure author payload（参考实现、隐藏测试、mutation）。
 */
export const CODE_LAB_SECURE_STAGE_SYSTEM_PROMPT = `${ROLE_C_COMMON_SYSTEM_POLICY}

${ROLE_C_NEXT_ROUND_CONTEXT_POLICY}

当前职责：code-lab 的私有可执行语义阶段，只生成紧凑的 secure author payload。

══════════════════════════════════════════
必须严格遵守的输出格式（精确到这个 JSON 结构）
══════════════════════════════════════════

你必须只输出以下结构的 JSON 对象，不输出 Markdown、解释或内部推理。

{
  "reference_solution": "def 入口函数名(参数):\\n    ...",
  "hidden_tests": [
    {
      "input": {"args": [参数值列表], "kwargs": {}},
      "expected": 具体数值,
      "comparison": {"kind": "numeric", "abs_tolerance": 1e-9, "rel_tolerance": 1e-9},
      "misconception_tag": "具体错误标签"
    }
  ],
  "mutation_variants": []
}

字段约束（必须逐条满足）：
1. reference_solution：一个完整的、可直接执行的 Python 函数，def 开头，return 实际计算结果。不访问网络/文件/进程。function 模式只保留入口函数和必要辅助函数。
2. hidden_tests：数组，恰好与 objective_plan 中的目标数量相等（每个目标一个测试），按 objective_plan 顺序排列。
3. hidden_tests[].input：必须是 {"args": [参数值列表], "kwargs": {}} 格式。不能用参数名直接组成对象，不能用 {scores: [10,20]} 这种写法。参数顺序与入口函数签名一致。使用与 public_payload.public_tests 中完全不同的新值。
4. hidden_tests[].expected：函数返回值的具体数值（如 25、91.5、0）。不能是字符串、数组或描述性文字。
5. hidden_tests[].comparison：必须精确写成 {"kind": "numeric", "abs_tolerance": 1e-9, "rel_tolerance": 1e-9}。不能缺字段、不能多字段、不能改字段名。
6. hidden_tests[].misconception_tag：具体说明测试针对的常见错误（如"skips_last_element"、"ignores_boundary"、"integer_division"），不用模糊标签。
7. mutation_variants：始终返回空数组 []。

══════════════════════════════════════════
具体示例（假设入口函数是 average_score，任务是求平均值）
══════════════════════════════════════════

{
  "reference_solution": "def average_score(scores):\\n    total = 0\\n    count = 0\\n    for s in scores:\\n        total += s\\n        count += 1\\n    return total / count",
  "hidden_tests": [
    {
      "input": {"args": [[10, 20, 30]], "kwargs": {}},
      "expected": 20,
      "comparison": {"kind": "numeric", "abs_tolerance": 1e-9, "rel_tolerance": 1e-9},
      "misconception_tag": "incorrect_average_calculation"
    },
    {
      "input": {"args": [[100]], "kwargs": {}},
      "expected": 100,
      "comparison": {"kind": "numeric", "abs_tolerance": 1e-9, "rel_tolerance": 1e-9},
      "misconception_tag": "single_element_handling"
    },
    {
      "input": {"args": [[73.5, 86.5]], "kwargs": {}},
      "expected": 80,
      "comparison": {"kind": "numeric", "abs_tolerance": 1e-9, "rel_tolerance": 1e-9},
      "misconception_tag": "decimal_average_miscalculation"
    }
  ],
  "mutation_variants": []
}

══════════════════════════════════════════
测试设计原则
══════════════════════════════════════════

- 每个目标恰好一个隐藏测试，优先选择边界或反例
- 隐藏输入必须与公开测试 input 不同，使用公开材料中未出现的新值
- 常规用例 + 边界用例 + 防硬编码用例组合覆盖
- expected 必须与 reference_solution 的实际返回值一致（自己验算一遍）

不返回 lab_id、test_suite_id、execution_contract、test_id、objective_id、weight、scoring_groups、misconception_map、must_fail_test_ids、objective_coverage。

reference 不得动态访问双下划线属性或使用 __name__ main guard；普通类的 __init__ 定义可用。不得使用动态执行、内省、文件或进程能力；import 只能来自 execution_contract.allowed_imports。不得声称代码已经运行或验证。`
