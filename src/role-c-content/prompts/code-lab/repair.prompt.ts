import { CODE_LAB_SYSTEM_PROMPT } from "./system.prompt"

export function codeLabRepairPrompt(issues: string[]): string {
  return `${CODE_LAB_SYSTEM_PROMPT}

上一次 Draft 未通过确定性结构/语义预检。只修复下列失败项，不扩大知识和权限范围：
${issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}

如涉及隐藏测试输入泄漏，必须更换重复的 hidden input，并同步重算 expected；不得改写 public_draft。`
}
