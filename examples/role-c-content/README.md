# Role C 样例

| 入口 | 内容 |
|---|---|
| `learning_path_node_score_project.json` | 含必填 `assessment_blueprint` 的路径节点样例 |
| `bun run demo:role-c` | concept-tutor 讲义与证据门禁 |
| `bun run demo:role-c:lab` | code-lab public 产物、可信验证与 opaque secure ref |
| `bun run demo:role-c:full` | 三 Agent、提交、评分、学习证据、mastery 与 trace |
| `bun run smoke:role-c:model` | 三个 Author 的真实模型冒烟 |
| `bun run demo:role-c:lab:oci` | digest-pinned OCI 隔离执行验收 |

真实模型参数从 `.env.role-c.local` 读取。`scripts/role-c-real-model-smoke.ts` 支持 `--agents`、`--no-repair`、staged/monolithic、阶段 token 预算和 concept 并发配置。

自动测试位于 `tests/role-c-*.test.ts`，覆盖 ready、blocked、failed、revision、checkpoint、cache、runner 与 secure store 路径。
