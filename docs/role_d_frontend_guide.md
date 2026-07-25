# Role D 前端与联调指南

Role D 提供 KnowBalance 的独立 Web 学习应用，负责把本机用户资料、B 学习者画像、A RAG 检索证据及 C 的公开学习资源整合为可操作、可解释、可恢复的学习流程。

## 当前产品入口

1. **首次本机建档**：用户主动填写称呼、专业/年级/职业、Python 了解程度、每周学习时间和接触过的编程语言。
2. **用户切换**：同一浏览器可创建和切换多个本机用户；这些不是云端账号。
3. **学习计划单**：每个用户拥有独立计划列表，可新建计划、选择计划继续上次阶段、删除当前计划。
4. **学习流程**：客观诊断 → 学情画像 → 定制方案 → 学习实操 → 反馈状态。

用户资料与计划资料分开：专业、总体 Python 自评和时间预算属于用户档案；计划名、目标、已学知识、薄弱知识、画像、检索、资源、作答及当前阶段属于单个计划。新建计划不会覆盖旧计划，也不要求重复填写用户背景。

## 真实 A/B/C/D 执行链

- **A：知识与检索**：Python 基础知识库、真实 facts/examples/quiz seeds 和规则检索。当前是关键词、同义词及规则扩展，不是 embedding 服务。
- **B：画像构建**：`background-collector → self-assessor → objective-diagnostician → profile-builder` 的真实 prompt 与确定性参考实现。B 按 `objective > self > background` 合并证据并记录冲突。
- **C：资源生成**：`concept-tutor`、`code-lab`、`tiered-evaluator` 通过服务端 `runCPipeline()` 生成并验证讲义、代码实验和分阶测评。
- **D：学习交互**：采集用户/计划输入，展示画像、路径、检索证据、C 资源、Agent trace，保存作答和阶段，并提供本地恢复。

浏览器只接收 public artifacts、公开 citations 和 trace。以下安全信息不会进入前端：

- `answer_spec`
- `hidden_tests`
- `reference_solution`
- `correct_option_id`
- secure artifact references

## 动态入学诊断

D 不再固定只展示一道题，也不会硬编码固定数量：

1. 先检查 A 的 retrieval trace，只有关键词、标题、事实、任务意图等真实语义命中的结果才作为诊断锚点；仅有难度加分的弱结果不会出题；
2. 如果不足，则沿这些语义锚点的 `prerequisites` 关系补充前置知识题；
3. 只使用知识库中带真实选项和答案的题；
4. 有多少有效题就展示多少，最多 5 道；没有语义相关锚点时直接阻止创建并要求更换知识库支持的目标；
5. 前置扩展在证据抽屉中明确标记，检索分为 0，不伪装成高相关结果。

提交后，所有作答交给 B 的 `ObjectiveDiagnosisEvidence.items`。画像页显示：

- 正确数 / 总题数；
- 证据是否充分；
- 当前**教学起点**，并明确不是最终能力评分；
- 已掌握和优先补强概念；
- 自评与客观证据冲突。

B 还会用诊断题的 `source_id` 对齐概念表述，避免“循环”和“for 循环”因措辞不同同时出现在已掌握与待补强中。

等级更新保持保守但不再“只降不升”：任一答错仍触发客观封顶；至少 3 道真实客观题全部答对时，教学起点可在自评基础上最多上调一档，且不会超过本轮题目实际覆盖的最高难度。

## C 分阶测评作答

Role D 按 C 返回的动态 `modality` 渲染：

- `mcq`：选项按钮；
- `true_false`：判断选项；
- `trace`：代码追踪文本输入；
- `short_answer`：简答输入；
- `code`：基于 `starter_code` 的代码编辑区。

所有公开题完成后才允许“提交整套测评”。答案支持：

- 自动保存；
- 刷新恢复；
- 切换计划后恢复；
- JSON 导出与导入；
- 题目 ID 和选项 ID 外键校验。

当前提交是 **D 端本地提交**，提交后显示“等待 C 正式评分”。正式 `SubmissionEnvelope → gradeSubmission()`、隔离代码执行、掌握度更新和动态下一步决策仍待 Week 2 接入；前端不会伪造分数或正确答案。

## 本地用户与计划存储

`localStorage` 使用版本化 workspace：

```text
LearningWorkspaceState
├── activeUserId
├── activePlanId
├── users[]
└── plans[]
    ├── userId
    ├── title
    ├── updatedAt
    └── session (完整 RoleDSession)
```

安全与迁移规则：

- 旧版 `knowbalance.role-d.session` 单会话会自动迁移成一个本机用户和一个计划；
- 用户只能选择或删除自己的计划；
- 计划切换不会串联阶段、答案或 citations；
- workspace 中计划归属与内部 learner ID 必须一致；身份冲突会拒绝，损坏 workspace 会回退到仍有效的 legacy 会话迁移；
- 首次进入和刷新后先显示计划单，由用户选择继续哪个计划；
- 当前没有真实登录、服务端账号或跨设备云同步。

## 进度 JSON

“进度管理”是团队联调、手动备份和换浏览器恢复的低优先级功能：

- 导出当前选中的单个计划；
- 导入成功后作为当前用户的**新计划**加入计划单，不覆盖其他计划；
- 导入计划的内部 learner ID 会重新绑定当前本机用户，避免跨用户身份混入；
- 导入前严格校验格式、版本、嵌套结构、citations、诊断答案和测评答案；伪造 `assessmentGraded` 等正式评分字段会被拒绝；
- 导入失败不会改变现有计划。

## Week 1 / Week 2 边界

根据项目行动计划：

### Week 1 已完成

- 学习者背景与自评输入；
- B 画像构建；
- A 知识检索和可追溯证据；
- 路径规划；
- C 真实讲义、代码实验、分阶题；
- D 本机用户、多计划、断点恢复、资源展示和完整公开题型作答；
- 成绩统计金标路径端到端跑通。

### Week 2 仍需完成

- 正式服务端评分；
- digest-pinned OCI 学生代码执行；
- 学习证据与掌握度更新；
- 根据正确率自动选择补救、巩固或进阶；
- 更完整的事实/教学审核与仲裁可视化；
- 扩展确定性 C Provider，使更多自由 Python 目标不再 blocked。

当前 C 使用官方确定性 Provider、运行时 Schema、可信 verifier 和 public/secure 发布门禁，不需要模型 API Key，也不等同于实时大模型生成。顶部“A/B/C 本次实跑”表示一次同步调用已真实执行，不代表已接入实时事件流。K007 + K009 + K018 成绩统计目标是已验证金标路径；不支持的目标会明确 blocked，不回退成伪造内容。

## 运行与验证

```bash
bun install
bun run role-d:dev
bun run check
bun run role-d:test
bun x tsc -p src/role-d-ui/tsconfig.json --noEmit
bun run role-d:build
bun audit
```

生产构建位于 `dist/role-d-ui/`。当前 Vite 开发服务提供 `/api/role-c/generate`；部署纯静态 `dist` 时需要另行部署等价的服务端 API，不能把 C 的安全逻辑打包进浏览器。

## 主要目录

```text
src/role-d-ui/src/
├── components/       # 用户建档、用户切换、计划单、阶段组件、详情抽屉
├── data/             # 明确标注的兼容演示 handoff
├── domain/           # workspace、session、诊断、进度文件、A/B/C 适配
├── screens/          # 聚焦式学习阶段页面
├── test/             # 测试环境
├── App.tsx
└── styles.css
```

## 上游兼容

`adaptHandoff()` 同时兼容 camelCase / snake_case，例如：

- `b_profile` / `profile`
- `a_rag_result` / `rag_result`
- `workflow_events` / `workflowEvents`
- `learning_path` / `learningPath`
- `sourceId` / `source_id`
- `factId` / `fact_id`
- `retrievalTrace` / `retrieval_trace`

缺少引用的学习资源不会被自动补造引用，而会进入 `evidenceGaps` 并在界面中明确提示。
