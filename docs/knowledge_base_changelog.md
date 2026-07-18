# 知识库更新日志

## 2026-07-18 — 小组联调增强包 v1

- GitHub 仓库已同步到：`https://github.com/jiangdongouyang-lab/knowbalance.git`
- 当前基准提交：`1d9cabb feat: add role A python knowledge base and RAG retriever`
- 新增 B/C/D 联调说明：`docs/team_integration_guide.md`
- 新增 B 调 A 的输入协议：`schemas/rag_request.schema.json`
- 新增 C/D 消费样例：`examples/rag_result_example.json`
- 新增端到端联调脚本：`scripts/team-integration-demo.ts`

B/C/D 更新方式：

```bash
git pull origin main
bun install
bun run check
bun scripts/team-integration-demo.ts
```

## 当前知识库范围

- Python 基础 18 个知识点：K001-K018
- 支持 `source_id/fact_id` 溯源
- 支持 `retrieval_trace` 展示推荐原因
- 支持 beginner 口语同义词扩展，例如“一遍遍处理很多数据”可命中循环/列表

## 后续更新规范

A 每次修改知识库后，应记录：

```text
日期
修改了哪些 Kxxx
是否影响 B/C/D 输入输出协议
BCD 是否需要重新 pull
验证命令结果
```
