/**
 * 分阶段生成的通用修复提示词模板。
 * 用于 code-lab 和 evaluator 的分阶段校验失败重试。
 */
export function stagedRepairPrompt(basePrompt: string, issues: string[]): string {
  return `${basePrompt}

上一次本阶段输出未通过校验。保持冻结合同不变，只修复以下失败项：
${issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}

若失败项包含隐藏测试输入泄漏：重新设计所有重复的 hidden_tests.input，逐一与冻结 public payload 核对，改用公开内容中从未出现的新输入，并同步重算对应 expected；不得删除或改写 public payload。`
}
