# Fact Audit API：A 对 C 生成内容的事实审核契约

## 1. 目标

Role A 在 Week2 提供事实审核门禁：Role C 生成讲义、代码实验或测试题后，必须把知识性内容拆成带引用的 blocks，交给 A 审核。

审核结果只有三类：

| status | 含义 | 后续动作 |
|---|---|---|
| `pass` | 所有知识性内容都有当前 RAG 证据支持 | 可发布给 D 展示 |
| `revise` | 内容缺少 `source_id/fact_id` 引用 | C 补引用后重审 |
| `reject` | 引用不存在、引用错位或使用知识库外内容 | C 重写或向 A 请求补知识 |

## 2. Role C 最小输出格式

C 可以先按这个简单 block 契约输出：

```json
{
  "artifactId": "concept-lesson-1",
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

字段要求：

| 字段 | 要求 |
|---|---|
| `blockId` | C artifact 内唯一 |
| `text` | 一条知识性陈述或题目 prompt |
| `citations` | 必须来自 A 的 `rag_result.results[*].facts` |
| `source_id` | 形如 `K007` |
| `fact_id` | 形如 `F001` |
| `relation` | Role C 现有引用关系，A 审核时只读取 source/fact |

## 3. TypeScript 调用

```ts
import { auditGeneratedContent } from "../src/fact-audit/auditor"
import { adaptRoleCBlocksToFactAuditInput } from "../src/fact-audit/adapters/role-c-block-adapter"

const input = adaptRoleCBlocksToFactAuditInput({
  artifactId: "concept-lesson-1",
  ragResult,
  blocks,
})

const audit = auditGeneratedContent(input)
```

如果 C 已经输出 `ArtifactEnvelope<ConceptLessonPayload | CodeLabPublicPayload | AssessmentPublicPayload>`，A 可以直接用：

```ts
import { adaptRoleCArtifactToFactAuditInput } from "../src/fact-audit/adapters/role-c-block-adapter"

const input = adaptRoleCArtifactToFactAuditInput({ artifact, ragResult })
const audit = auditGeneratedContent(input)
```

如果 C 已经冻结了生成时使用的 evidence pack，优先直接把冻结包交给 A，避免审核阶段重新检索导致证据漂移：

```ts
const audit = auditGeneratedContent({
  artifactId: "concept-lesson-1",
  evidencePack,
  expectedEvidenceContentHash,
  generatedContent: { blocks },
})
```

如需接入 embedding / LLM 语义审核，用可插拔端口包一层：

```ts
const audit = await auditGeneratedContentWithSemantic({
  input,
  semanticAuditPort,
})
```

## 4. 当前审核规则

MVP 先做硬门禁：

1. 每个知识性 block 必须有 citation。
2. citation 必须存在于当前 `ragResult` 或冻结 `evidencePack`。
3. claim 文本必须和引用 fact 有词面支撑。
4. 明显知识库外内容会被驳回。
5. 可选语义审核端口可在词面通过后继续判定 `semantic_unsupported`。

当前已提供 embedding/LLM 语义审核的可插拔接口；默认路径仍是确定性硬门禁，不强依赖外部模型。

## 5. 验证命令

```bash
npm exec -- bun test tests/fact-audit.test.ts tests/fact-audit-role-c-adapter.test.ts
npm exec -- bun scripts/week2-role-a-demo.ts
npm exec -- bun run typecheck
```

## 6. 给 Role C 的接入红线

- 不要编造 `source_id/fact_id`。
- 不要引用当前 RAG 结果之外的事实。
- 不要生成 RAG 证据没有覆盖的外部知识。
- 缺引用的内容会被 `revise`。
- 错引用、假引用、外部知识会被 `reject`。
