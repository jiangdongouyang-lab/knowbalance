# Learning Orchestrator 持续会话 HTTP API

## 启动

```bash
bun scripts/learning-orchestrator-api.ts \
  --host=127.0.0.1 \
  --port=8787 \
  --data-root=.tmp/orchestrator
```

`data-root` 由服务端配置。浏览器请求中的 `root_dir` 会被忽略。

## 接口

### 健康检查

```http
GET /health
```

### 创建持续会话

```http
POST /orchestrator/sessions
Authorization: Bearer learner-001
Content-Type: application/json
```

```json
{
  "session_id": "SESSION-001",
  "mode": "deterministic",
  "learner_request": {
    "learner_id": "learner-001",
    "goal": "学习 Python 循环并完成成绩统计",
    "background": "零基础",
    "self_rating": "beginner"
  }
}
```

创建后不会一次性跑完。主 Agent 先返回：

```json
{
  "status": "waiting_for_user",
  "current_stage": "objective_diagnosis",
  "waiting_for": {
    "type": "diagnosis_answers",
    "items": []
  }
}
```

诊断题的可信答案只保存在服务端会话文件中，不会返回浏览器。

### 查询并恢复会话

```http
GET /orchestrator/sessions/:sessionId
Authorization: Bearer learner-001
```

返回当前会话完整公开视图。服务重启后使用同一 `data-root` 即可恢复。

### 提交命令

```http
POST /orchestrator/sessions/:sessionId/commands
Authorization: Bearer learner-001
Content-Type: application/json
```

每个命令必须带唯一 `command_id`。相同 ID 和相同内容会幂等重放；相同 ID 但内容不同会返回冲突。

#### 提交诊断答案

```json
{
  "command_id": "CMD-DIAG-001",
  "type": "submit_diagnosis_answers",
  "payload": {
    "answers": {
      "DIAG-1-K007": "遍历序列"
    }
  }
}
```

完成诊断后，主 Agent 继续调用画像、路径和三个内容 Worker，并在正式测评处再次暂停：

```json
{
  "status": "waiting_for_user",
  "current_stage": "assessment",
  "waiting_for": {
    "type": "assessment_answers",
    "items": []
  }
}
```

#### 提交测评答案

```json
{
  "command_id": "CMD-ASSESS-001",
  "type": "submit_assessment_answers",
  "payload": {
    "answers": [
      {
        "item_id": "ITEM-O1-T1-MCQ",
        "selected_option_id": "opt_iterate",
        "hint_level_used": 0
      }
    ]
  }
}
```

主 Agent 使用服务端私有的 `assessment_secure` 评分，返回公开 `feedback.final_decision`，然后执行：

- `remediate`：保持当前正式路径节点，生成补救轮；
- `reinforce`：保持当前节点，生成巩固轮；
- `advance`：推进 B 正式路径；如果下一节点不受离线 Provider 支持，公开返回 `blocked`，不伪造资源；
- 路径结束：返回 `completed`。

#### 重试阻塞阶段

```json
{
  "command_id": "CMD-RETRY-001",
  "type": "retry"
}
```

### 读取 Worker 事件

```http
GET /orchestrator/sessions/:sessionId/events
Authorization: Bearer learner-001
```

返回主 Agent 持久化的 Worker 调用、等待、完成和阻塞事件。

## D 可直接使用的公开字段

- `session_id`
- `status`
- `current_stage`
- `round_no`
- `waiting_for`
- `worker_ledger`
- `profile`
- `formal_path`
- `current_path_node`
- `rag_result`
- `learning_resources.concept_lesson`
- `learning_resources.code_lab`
- `assessment`
- `feedback`
- `blocked_reason`

公开响应不会包含：

- 诊断正确答案；
- `assessment_secure`（由 Role C 私有 opaque store 保存）；
- `correct_option_id`；
- 服务端命令账本；
- 服务端文件根目录。

## 当前运行边界

当前实现是可重复验证的 `deterministic` 联调运行时。持续会话接口已要求 Bearer 学习者身份并校验会话所有权；正式联网部署仍应把当前本地身份头替换为可信身份提供方签发的令牌，同时增加 Origin/Host 校验、限流和超时，并将确定性代码 Runner 换为生产 Docker Runner。
