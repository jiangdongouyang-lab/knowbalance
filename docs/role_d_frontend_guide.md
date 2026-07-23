# Role D 前端与联调指南

Role D 提供 KnowBalance 的独立 Web 学习应用，负责将 B 的学习者画像、A 的 RAG 检索证据以及 C 的个性化学习资源整合为可操作、可解释、可恢复的学习闭环。

## 当前能力

- React + Vite + TypeScript 独立前端。
- 面向大学生的六阶段引导流程：学习建档 → 客观诊断 → 学情画像 → 定制方案 → 学习实操 → 反馈调整。
- 单任务画布设计；Agent 协同和知识证据通过按需抽屉查看，不与主任务堆叠。
- 学习者等级、已掌握知识、薄弱知识与画像冲突展示。
- 个性化学习路径与资源难度匹配展示。
- 真实事件数据驱动的多 Agent 协同时间线。
- A 角色 `rag_result` 的推荐理由、检索轨迹、分数构成和知识事实展示。
- `source_id/fact_id` 引用跳转与来源文件展示。
- 版本化 `localStorage` 会话保存、恢复和损坏状态安全回退。
- 自动保存当前阶段、已解锁阶段、学习目标、自评、诊断答案、资源标签和证据选择。
- 支持导出版本化进度 JSON，并在另一浏览器中导入恢复完整会话；导入前会校验格式、版本、嵌套结构和引用一致性，失败不会覆盖当前进度。
- 支持“新建学习计划”：输入学习者编号、背景、时间预算、已学知识、薄弱知识和目标后，直接运行 B 画像合成器、A RAG 检索器和 C 官方内容流水线。
- Week 1 成绩统计金标路径会生成并发布真实讲义、代码实验和 5 道分阶测评公开题面；提交诊断后会重新执行 B、A 和 C。
- 分阶测评根据 C 返回的动态题型渲染选择、判断、代码追踪、简答和代码输入；整套完成后可在 D 端提交，答案支持自动保存、刷新恢复和进度文件迁移。
- D 端提交后明确显示“等待 C 正式评分”；在评分接口与安全代码执行器接入前，不提前展示正确答案、分数或动态路径决策。
- 支持“重新开始当前计划”：清空阶段和答案，但真实 A/B 新计划会保留当前学习者及其检索结果。
- 兼容上游 camelCase / snake_case 两种字段命名。

## 数据真实性边界

首页预填案例中的以下数据来自仓库已有的 A/B 契约和示例：

- 学习者画像与画像冲突。
- RAG 推荐知识点。
- `retrieval_trace`。
- 知识事实、来源文件及 `source_id/fact_id`。

知识证据抽屉按联调文档第 9 节逐项展示：推荐知识点、推荐原因、匹配证据、匹配字段、分数构成、知识来源和生成内容引用。资源难度匹配图是基于 `difficulty` 与画像等级的增强展示，不是联调文档规定的必做图表，也不会把检索分解释为能力百分比。

首页加载时保留明确的案例预览数据，方便用户先检查目标和证据；这些预览资源仍标为 MOCK。用户点击首页“下一步：客观诊断”或顶部“新建计划”后，系统会真实执行 B 画像、A 检索，并通过 Vite 本地服务端调用 C 官方 `runCPipeline()`。从诊断阶段起使用本次真实运行的数据；浏览器只接收 public artifacts 与 trace，不接收参考实现、隐藏测试、答案规范或 secure refs。

当前 Week 1 联调使用 C 官方确定性 Provider、运行时 Schema、可信 verifier 和 public/secure 发布门禁，不需要模型 API Key，也不等同于实时大模型生成。C 的离线代码实验基准当前只支持 K007 + K009 + K018 三目标成绩统计任务；其他 Python 目标仍可完成 A/B 建档与检索，但 C 会明确返回 blocked，不会回退成伪造内容。

正式整套测评提交、服务端评分、学习证据、掌握度和动态反馈尚未接入学生前端。因此第 6 阶段只显示 PENDING，不展示虚构分数或决策。

## 用户操作流程

1. **学习建档**：确认学习目标和自评水平。
2. **客观诊断**：回答知识库支持的诊断题。
3. **学情画像**：查看已掌握、薄弱知识和自评冲突。
4. **定制方案**：确认先修路径、推荐理由和匹配资源。
5. **学习实操**：依次使用讲义、代码实验和分阶测评。
6. **反馈调整**：根据测评结果进入补救、巩固、进阶或重新画像。

页面顶部的 Agent 与知识证据入口是辅助检查工具，不是主流程的必经步骤。

## Week 1 进度文件

页面顶部默认只保留一个低干扰的“进度管理”入口。展开后点击“导出 JSON”会下载 `knowbalance-progress-<learner-id>.json`；文件包含学习者、当前阶段、画像、检索结果、诊断答案、资源选择和引用状态，可通过同一菜单中的“导入 JSON”在另一浏览器恢复。

进度文件用于本地迁移和断点续传，不是云同步。格式错误、版本不兼容、字段损坏或引用不一致的文件会被拒绝，当前会话不会被替换。

## 安装与运行

```bash
bun install
bun run role-d:dev
```

Vite 会输出本地访问地址。生产构建：

```bash
bun run role-d:build
```

构建产物位于 `dist/role-d-ui/`。

## 验证

```bash
bun run check
bun run role-d:test
bun x tsc -p src/role-d-ui/tsconfig.json --noEmit
bun run role-d:build
```

## 目录说明

```text
src/role-d-ui/
├── index.html
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── components/       # 阶段导航、详情抽屉和复用组件
    ├── data/             # 明确标注的演示 handoff
    ├── domain/           # 统一视图类型、流程状态、适配器、会话存储
    ├── screens/          # 六个聚焦式用户操作页面
    ├── test/             # 测试环境
    ├── App.tsx
    ├── main.tsx
    └── styles.css
```

## 上游输入要求

Role D 的 `adaptHandoff()` 当前可消费：

- `b_profile` / `profile`
- `b_provenance` / `provenance`
- `a_rag_result` / `rag_result`
- `c_artifacts` / `artifacts`
- `workflow_events` / `workflowEvents`
- `learning_path` / `learningPath`
- `decision`

A 角色字段同时兼容：

- `sourceId` / `source_id`
- `factId` / `fact_id`
- `retrievalTrace` / `retrieval_trace`
- `matchedKeywords` / `matched_keywords`
- `matchedFields` / `matched_fields`
- `scoreBreakdown` / `score_breakdown`

缺少引用的学习资源不会被自动补造引用，而会进入 `evidenceGaps`，供界面和审核流程显式提示。

## Role C 后续对接

讲义、代码实验、分阶测评、citations 和 Agent trace 已完成 Week 1 对接。后续仍需接入：

1. 学生对完整 assessment form 的作答状态和 `SubmissionEnvelope`。
2. `gradeSubmission()` 与冻结后的公开评分结果。
3. 学习证据、掌握度更新和下一步决策。
4. 生产环境独立 API 服务与 digest-pinned OCI Python runner。
5. 可选的真实模型 Provider；不能将模型密钥放入浏览器。
