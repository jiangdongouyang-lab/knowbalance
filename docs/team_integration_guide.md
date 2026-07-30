# KnowBalance 小组联调指南

## 1. 核心结论

A 角色的知识库已经放在 GitHub 仓库中：

```text
https://github.com/jiangdongouyang-lab/knowbalance.git
```

B/C/D 不需要访问 A 的电脑，也不应该直接读 `D:\MR_fan\...` 这类本地路径。正确方式是：

```text
BCD clone/pull GitHub 仓库 → 在自己电脑安装依赖 → 运行 RAG demo → 按统一协议联调
```

## 2. 下载与更新

第一次下载：

```bash
git clone https://github.com/jiangdongouyang-lab/knowbalance.git
cd knowbalance
npm install -g bun
bun install
bun run docker:role-c:build
bun run docker:role-c:doctor
bun run check
bun scripts/team-integration-demo.ts
```

已经下载过：

```bash
cd knowbalance
git pull origin main
bun install
bun run docker:role-c:build
bun run docker:role-c:doctor
bun run check
bun scripts/team-integration-demo.ts
```

## 3. 知识库结构

```text
knowbalance/
├── knowledge_base/python_basic/       # Markdown 知识库与 index.json
├── src/knowledge/                     # TypeScript 运行时知识库
├── src/rag/retriever.ts               # A RAG 检索入口 retrieveKnowledge()
├── schemas/rag_request.schema.json    # B 调 A 的输入协议
├── schemas/rag_result.schema.json     # A 给 C/D 的输出协议
├── examples/learner_*.json            # B/C/D 联调画像样例
├── examples/rag_result_example.json   # C/D 消费的 RAG 输出样例
├── scripts/team-integration-demo.ts   # B→A→C→D 端到端联调演示
├── src/role-d-integration/             # C/D 后端接收与学习会话接口
├── tests/team-adaptive-flow.test.ts    # 两轮自适应闭环测试
└── docs/knowledge_base_changelog.md   # 知识库更新日志
```

## 4. 知识库内容

当前知识库覆盖 Python 基础 18 个知识点：

| 编号 | 知识点 |
|---|---|
| K001 | Python 是什么 |
| K002 | 变量与赋值 |
| K003 | 基本数据类型 |
| K004 | 输入输出 |
| K005 | 运算符 |
| K006 | 条件判断 |
| K007 | for 循环 |
| K008 | while 循环 |
| K009 | 列表 |
| K010 | 字典 |
| K011 | 元组与集合 |
| K012 | 字符串常用操作 |
| K013 | 函数定义与调用 |
| K014 | 参数与返回值 |
| K015 | 文件读写 |
| K016 | 异常处理 |
| K017 | 模块导入 |
| K018 | 成绩统计器综合项目 |

每个知识点包含 `source_id/fact_id/difficulty/keywords/facts/examples/practiceTasks/quizItems/retrieval_trace` 等字段，保证 C/D 生成和展示时可以追溯来源。

## 5. B/A/C/D 联调协议

### B 画像构建

B 输出学习者画像，字段参考：

```json
{
  "learner_id": "demo_loop_weak",
  "level": "beginner",
  "known_concepts": ["变量", "数据类型", "条件判断"],
  "weak_concepts": ["循环", "列表"],
  "goal": "理解重复执行并能遍历一组数据"
}
```

### A RAG 检索

A 使用 B 的画像拼接 query，并调用：

```ts
retrieveKnowledge({ query, learnerLevel: profile.level, topK: 5 })
```

输出 `rag_result` 给 C/D。

### C 内容生成

C 只能基于 `rag_result.results[*].facts/examples/practiceTasks/quizItems` 生成讲义、代码实验、测试题。

红线：知识性陈述必须带 `source_id/fact_id`，不能凭空生成。

### D 展示与状态

D 展示画像、检索依据、引用、公开内容和当前学习会话：

- `profile`
- `rag_result`
- `retrieval_trace`
- `citations`

让评委看到“为什么推荐这个知识点”。

学习流程按以下顺序调用：

1. `generateRoleCForRoleDWithRuntime` 返回审核后的内容和
   `anchor_pending`，D 先展示 `requiredItemIds` 中的锚点题；
2. D 将锚点答案交给 `routeRoleCAssessment`，保存返回的
   `route_locked`、路线和新 `requiredItemIds`，并冻结已确认的锚点答案；
3. D 按冻结后的题集调用 `submitRoleCAssessment`，展示公开评分和建议；
4. C 将学习进展交给 B 更新画像；
5. 后端调用 `continueRoleCAfterSubmission` 生成下一轮内容；成功结果中的
   `role_d_handoff` 包含 D 可直接接入的内容、路径身份和锚点会话。

D 页面以 `role_d_handoff` 建立下一轮学习计划；独立 delivery 用于接收、去重和审计。
浏览器调用 `/api/role-c/continue` 时只提交已完成轮次的 `sessionId`、
`submissionId` 和 `learnerId`。新版画像由 B 会话绑定读取。同节点续跑使用
当前可信路径和证据；进阶或重建画像时，由后端取得 B 新路径和 A 新证据后
调用 C。

D 页面将当前 `anchor_pending` 或 `route_locked` 保存在学习计划中，只展示
当前 `requiredItemIds` 指定的题目。路由和最终提交使用稳定请求编号；请求
结果未确认时可用原答案重试。`profileVersion`、`pathNodeId` 和
`targetSourceIds` 随学习计划持久化，用于校验反馈身份和更新对应路径节点。

D 按 C 的 `GradeResult.item_results` 读取分数和 `feedback_code`；题型从已发布
测评中按 `item_id` 关联。D 在写入完成状态前校验冻结分数、提交身份、完整
逐题结果和最终建议的一致性。

本地开发服务提供：

```text
POST /api/role-c/generate
POST /api/role-c/route
POST /api/role-c/submit
POST /api/role-c/continue
```

启动 D 本地服务前构建并检查隔离代码运行环境：

```bash
bun run docker:role-c:build
bun run docker:role-c:doctor
bun run role-d:dev
```

`RoleDRoleCDeliveryReceiver` 分别保存审核内容、恢复状态和学习会话；
重复投递返回 `duplicate`。`RoleBLearningProgressAdapter` 接收 C 的学习
证据并生成 B 的新版画像。

## 6. 一键联调验证

BCD 下载仓库后运行：

```bash
bun run docker:role-c:build
bun run docker:role-c:doctor
bun scripts/team-integration-demo.ts
```

预期输出是一个 JSON，包含：

```text
b_profile
a_rag_result
c_content_contract
d_display_contract
adaptive_learning_loop
```

`adaptive_learning_loop` 会显示第一轮锚点选路、正式评分、B 画像更新、
下一轮发布和下一轮路线冻结。完整自动测试可运行：

```bash
bun test --isolate tests/team-adaptive-flow.test.ts
```

## 7. 更新规则

A 每次改知识库后：

```bash
git add <changed files>
git commit -m "chore: update knowledge base"
git push origin main
```

B/C/D 每次联调前：

```bash
git pull origin main
bun install
bun run check
```

## 8. 常见坑

| 坑 | 后果 | 正确做法 |
|---|---|---|
| B/C/D 直接读 A 本地路径 | 跨电脑访问不到 | 从 GitHub clone/pull |
| 每个人手动复制文件 | 版本不一致 | 统一以 GitHub main 为准 |
| C 不用 rag_result | 容易幻觉 | 只用 facts/examples/quizItems |
| D 不展示 trace | 看不到推荐依据 | 展示 retrieval_trace/citations |
| D 在锚点选路前提交全部题目 | 会话拒绝提交 | 先调用 route，再提交返回的必答题集 |
| D 在路线冻结后修改锚点答案 | 正式提交被拒绝 | 保存锚点题集合并禁用对应输入 |
| B 未保存 C 回传后的画像版本 | 下一轮版本不一致 | 以 B 接收端生成的新版本启动下一轮 |
| A 改完不 push | B/C/D 拿不到更新 | 每次改完 commit + push |
