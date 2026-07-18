# KnowBalance GitHub 小组协作指南

## 1. 仓库地址

```text
https://github.com/jiangdongouyang-lab/knowbalance.git
```

这个仓库是 A/B/C/D 的共同工作台。所有成员第一次下载用 `git clone`，后续同步用 `git pull`，不需要重复 clone。

## 2. 权限规则

| 操作 | 是否需要仓库 owner 授权 | 说明 |
|---|---:|---|
| 查看公开仓库 | 不需要 | Public 仓库任何人可读 |
| clone 仓库 | 不需要 | 可下载完整代码和知识库 |
| fork 仓库 | 不需要 | 可复制到自己的 GitHub 账号下 |
| 向自己的 fork push | 不需要本仓库权限 | 适合无 collaborator 权限的成员 |
| 向本仓库 push 分支 | 需要 Collaborator Write 权限 | 适合小组内部成员 |
| 合并 Pull Request 到 main | 需要 owner/maintainer 权限 | main 保持稳定版 |

结论：B/C/D 想直接往 `jiangdongouyang-lab/knowbalance` 推分支，需要你把他们加为 Collaborator；如果不给权限，他们也可以 Fork 后提交 Pull Request。

## 3. 推荐协作模式

小组内部推荐：

```text
Collaborator + 角色分支 + Pull Request
```

不要直接 push 到 `main`。`main` 只保存全组能跑通的稳定版本。

## 4. 角色分工

| 角色 | 负责内容 | 主要目录 |
|---|---|---|
| A | Python 知识库、RAG 检索、schema、联调样例 | `knowledge_base/`, `src/knowledge/`, `src/rag/`, `schemas/`, `examples/`, `scripts/` |
| B | 学习者画像、诊断结果、学习状态输入 | `src/role-b-profile/`, `examples/learner_*.json` |
| C | 个性化讲解、代码实验、题目生成 | `src/role-c-content/`, `src/prompts/` |
| D | 展示界面、交互流程、引用/检索依据展示 | `src/role-d-ui/`, `docs/` |

## 5. 分支命名规范

```text
role-a/update-knowledge
role-b/profile-builder
role-c/content-generator
role-d/frontend
contract/update-schemas
docs/update-guide
fix/rag-ranking
```

规则：

```text
角色/任务名
```

例如 B 做画像模块：

```bash
git checkout -b role-b/profile-builder
```

## 6. Collaborator 模式：B/C/D 直接推分支

仓库 owner 需要在 GitHub 网页操作：

```text
Repository → Settings → Collaborators → Add people → 输入 GitHub 用户名 → Role: Write → Send invitation
```

B/C/D 接受邀请后：

```bash
git clone https://github.com/jiangdongouyang-lab/knowbalance.git
cd knowbalance
bun install
git checkout -b role-b/profile-builder
# 修改自己的模块
bun run check
bun scripts/team-integration-demo.ts
git add src/role-b-profile tests docs
git commit -m "feat(role-b): add learner profile builder"
git push origin role-b/profile-builder
```

然后在 GitHub 页面创建 Pull Request。

## 7. Fork 模式：不给写权限也能送代码

B/C/D 在 GitHub 页面点 `Fork`，复制到自己的账号。

然后：

```bash
git clone https://github.com/<成员用户名>/knowbalance.git
cd knowbalance
bun install
git checkout -b role-c/content-generator
# 修改自己的模块
bun run check
bun scripts/team-integration-demo.ts
git add src/role-c-content tests docs
git commit -m "feat(role-c): add content generator"
git push origin role-c/content-generator
```

最后在 GitHub 页面创建 Pull Request 到：

```text
jiangdongouyang-lab/knowbalance:main
```

## 8. Pull Request 合并前检查

每个 PR 必须说明：

```text
1. 改了哪个角色模块
2. 输入/输出协议是否变更
3. 是否影响 A 的 RAG 结果
4. 是否运行了验证命令
```

必须运行：

```bash
bun run check
bun scripts/team-integration-demo.ts
```

## 9. main 分支保护建议

建议在 GitHub 网页设置：

```text
Settings → Branches → Add branch protection rule → Branch name pattern: main
```

建议开启：

```text
Require a pull request before merging
Require approvals: 1
Do not allow force pushes
Do not allow deletions
```

如果后续配置 GitHub Actions，再开启：

```text
Require status checks to pass before merging
```

## 10. 冲突处理原则

| 场景 | 处理方式 |
|---|---|
| B/C/D 改了不同角色目录 | 正常 PR 合并 |
| 多人同时改 schema | 先讨论协议，再合并 |
| C/D 需要 A 新增知识点 | 开 issue 或 PR，说明需要的 `source_id/fact_id` |
| 测试失败 | 不合并，先修复 |
| 不确定是否影响别人 | 在 PR 描述里标注“需要 A/B/C/D 联合确认” |

## 11. 给 B/C/D 的最短说明

```bash
git clone https://github.com/jiangdongouyang-lab/knowbalance.git
cd knowbalance
bun install
bun run check
bun scripts/team-integration-demo.ts
```

开发时：

```bash
git checkout -b role-b/profile-builder
# 修改自己的角色目录
bun run check
git add src/role-b-profile tests docs
git commit -m "feat(role-b): add learner profile builder"
git push origin role-b/profile-builder
```

然后开 Pull Request，不直接改 `main`。
