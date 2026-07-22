# Role C Prompt 索引

| 项目 | 当前值 |
|---|---|
| Prompt manifest | `c-prompts-1.7.0` |
| 入口 | `src/role-c-content/prompts/index.ts` |
| 公共策略 | `src/role-c-content/prompts/common-policy.ts` |

## Prompt 文件

| 文件 | Agent / 阶段 | 作用 |
|---|---|---|
| `concept-tutor.v1.ts` | concept-tutor / monolithic | 生成完整概念讲义 Draft |
| `code-lab.v1.ts` | code-lab / monolithic | 生成完整实验 Draft |
| `evaluator-author.v1.ts` | tiered-evaluator / monolithic | 生成完整测评 Draft |
| `staged-authors.v1.ts` | 三个 Author / staged | 定义五个分阶段生成 Prompt 与局部修复 Prompt |
| `evaluator-grader.v1.ts` | tiered-evaluator / Grader | 对主观题逐 criterion 返回 `met/unmet/uncertain` |
| `evaluator-feedback.v1.ts` | tiered-evaluator / Feedback | 将冻结评分结果转为形成性反馈 |
| `cross-artifact-critic.v1.ts` | Alignment Critic | 定位讲义、实验和测评之间的不一致 |
| `../prompts.ts` | OpenCode adapter | 将三个 Agent 的系统 Prompt 包装为 worker 消息合同 |

## Staged Prompt

| 常量 | 阶段 | 输入与输出 |
|---|---|---|
| `CONCEPT_SEGMENT_SYSTEM_PROMPT` | concept 目标组 | 目标组与裁剪证据 → `ConceptLessonPayload` 分段 |
| `CODE_LAB_PUBLIC_STAGE_SYSTEM_PROMPT` | code-lab public | 冻结合同 → 任务、starter、公开测试、提示和引用 |
| `CODE_LAB_SECURE_STAGE_SYSTEM_PROMPT` | code-lab secure | 冻结 public → reference、隐藏测试、评分组和 mutation |
| `ASSESSMENT_PUBLIC_STAGE_SYSTEM_PROMPT` | assessment public | 冻结 item plan → 题面、选项、starter 和引用 |
| `ASSESSMENT_SECURE_STAGE_SYSTEM_PROMPT` | assessment secure | 冻结题面 → 答案合同、rubric 和代码测试套件 |
| `stagedRepairPrompt` | staged repair | 当前阶段 Draft 与校验问题 → 修复后的同阶段 Draft |

## 统一约束

1. 证据、目标、答案语义和 public/secure 边界保持稳定。
2. Prompt 输出遵循对应 JSON Schema。
3. ID、item plan、routing、coverage、权重、评分和发布状态由程序确定。
4. Prompt 修改同步更新 manifest 版本。
5. 修改后运行 `bun run check` 和真实模型冒烟，记录首次通过率、修复次数与 token 用量。
