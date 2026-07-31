# 角色 A Week3 联调规范：B/C/D 接入 A 的边界

## 1. Week3 目标

角色 A 在 Week3 的目标不是继续堆单点能力，而是把 Week1/Week2 已完成的 RAG、frozen evidence pack、事实审核、LLM Judge 和 60 组评测能力，整理成 B/C/D 可稳定接入的联调规范。

一句话：A 负责“给证据、冻结证据、审 C 产物、输出可展示审核结果”；B/C/D 按 A 的输入输出契约接入，不各自解释事实真假。

## 2. A 的责任边界

| 角色 A 模块 | A 负责 | A 不负责 |
|---|---|---|
| A-RAG | 根据 B 的画像和 query 检索知识证据 | 替 B 重新画像 |
| A-Evidence | 输出 frozen evidence pack 和 content hash | 让 C 自由重检索证据 |
| A-Audit | 审核 C 公开知识性内容的 citation、词面支撑、语义支撑 | 审 secure answer key / hidden tests 的运行正确性 |
| A-LLM Judge | 用 DeepSeek Reasoner 判断 claim 是否被 evidence 语义支持 | 生成 C 的教学内容 |
| A-Report | 输出审核结果和 60 组评测指标 | 替 D 设计全部 UI |

## 3. B → A：RAG 请求契约

B 给 A 的输入必须符合 `schemas/rag_request.schema.json`。

最小示例见：`examples/week3/role_a_rag_request_example.json`

```json
{
  "learner_profile": {
    "learner_id": "stu_week3_demo",
    "level": "beginner",
    "known_concepts": ["变量", "条件判断"],
    "weak_concepts": ["循环", "列表"],
    "goal": "完成成绩统计程序"
  },
  "query": "初学者，不会循环，需要完成成绩统计程序",
  "top_k": 3
}
```

B 给 A 的红线：

1. `level` 必须是 `beginner/basic/intermediate/integrated`。
2. `weak_concepts` 不能为空。
3. `goal` 必须是具体任务，不要只写“学 Python”。
4. `query` 必须同时包含学习水平、薄弱点和当前目标。

## 4. A → C：frozen evidence pack

A 给 C 的输出是 frozen evidence pack。C 必须只基于这份证据生成内容。

示例见：`examples/week3/frozen_evidence_pack_example.json`

关键字段：

| 字段 | 含义 |
|---|---|
| `retrieval_id` | 本次检索证据包 ID |
| `kb_version` | 知识库版本 |
| `rag_version` | RAG 策略版本 |
| `results[*].facts[*]` | C 可引用的事实集合 |
| `content_hash` | 由 A 侧计算，C 审核时必须回传 |

C 只能引用 `results[*].facts[*].source_id/fact_id`。如果 C 需要 evidence pack 之外的知识，应向 A 提出 evidence gap request，而不是编造 citation。

## 5. C → A：审核输入契约

C 给 A 的审核输入示例见：`examples/week3/role_c_audit_input_example.json`

```json
{
  "artifactId": "role-c-week3-demo",
  "evidence_hash": "sha256:...",
  "blocks": [
    {
      "blockId": "claim-1",
      "text": "for 循环常用于遍历序列中的元素。",
      "citations": [
        { "source_id": "K007", "fact_id": "F001", "relation": "supports" }
      ]
    }
  ]
}
```

C 给 A 的红线：

1. 每个知识性 block 必须有 citation。
2. citation 必须来自 A 的 frozen evidence pack。
3. 一个 block 只表达一个主要事实，不要混多个事实。
4. `code_lab_public` 的 instruction、public test 描述、hint 必须可审。
5. `assessment_public` 的题干必须可审。
6. `code_lab_secure`、`assessment_secure` 的答案和 hidden tests 不交给 A 做公开事实审核；它们由 C verifier 负责运行正确性。

## 6. A → D：审核结果展示契约

A 给 D 的输出示例见：`examples/week3/fact_audit_result_example.json`

D 只展示 A 的审核结果，不自行判断真假。

D 至少展示：

| 字段 | 展示目的 |
|---|---|
| `status` | pass / revise / reject 总结论 |
| `checkedClaims[*].verdict` | 每条 claim 的事实审核结果 |
| `checkedClaims[*].semantic.verdict` | 语义审核结论，如果启用 LLM Judge |
| `checkedClaims[*].semantic.confidence` | LLM Judge 置信度 |
| `conflicts` | revise/reject 的原因 |
| `evidence.retrieval_id` | 证据包来源 |
| `evidence.content_hash` | 冻结证据一致性 |

## 7. Week3 角色 A 交付物

| 编号 | 交付物 | 路径 |
|---|---|---|
| A-W3-1 | B/C/D 接入规范 | `docs/role_a_week3_integration_guide.md` |
| A-W3-2 | B→A RAG 请求示例 | `examples/week3/role_a_rag_request_example.json` |
| A-W3-3 | A→C frozen evidence pack 示例 | `examples/week3/frozen_evidence_pack_example.json` |
| A-W3-4 | C→A 审核输入示例 | `examples/week3/role_c_audit_input_example.json` |
| A-W3-5 | A→D 审核输出示例 | `examples/week3/fact_audit_result_example.json` |
| A-W3-6 | A 专项评测集 | `tests/fixtures/fact-audit-eval/cases.json` |
| A-W3-7 | A 评测脚本 | `scripts/fact-audit-eval.ts` |

## 8. Week3 验收命令

```bash
bun run typecheck
bun test tests/fact-audit.test.ts tests/fact-audit-role-c-adapter.test.ts tests/fact-audit-semantic-llm-judge.test.ts tests/fact-audit-eval.test.ts tests/week3-role-a-assets.test.ts
bun scripts/fact-audit-eval.ts
bun scripts/fact-audit-eval.ts --llm-judge
```

## 9. 汇报口径

可以说：

> 角色 A Week3 已明确 B/C/D 接入边界：B 提供画像与 query，A 输出 frozen evidence pack，C 基于证据生成并回传 citation，A 输出事实审核和语义审核结果，D 仅展示 A 的审核证据链。角色 A 已具备 60 组专项评测和 DeepSeek Reasoner LLM Judge 真实评测能力。

不要说：

> 整个项目已经完成端到端上线。

更稳妥说：

> 角色 A 的联调接口和评测闭环已准备好，下一步是由 B/C/D 按该规范接入并完成端到端联调演示。
