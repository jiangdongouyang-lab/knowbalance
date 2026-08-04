export interface CurriculumNode {
  node_id: string
  title: string
  module?: string
  source_ids: string[]
  children: CurriculumNode[]
}

export interface LearningGoalSpecInput {
  mode: "curriculum_node" | "custom_goal"
  selected_node_ids?: string[]
  custom_goal?: string
}

export interface LearningGoalSpec {
  mode: "curriculum_node" | "custom_goal"
  selected_node_ids: string[]
  custom_goal?: string
  mapped_source_ids: string[]
  goal_text: string
}

const TREE: CurriculumNode = {
  node_id: "PY",
  title: "Python基础",
  module: "Python基础",
  source_ids: [],
  children: [
    {
      node_id: "PY-CH01",
      title: "Python 入门基础",
      source_ids: ["K001", "K002", "K003", "K004", "K005"],
      children: [
        leaf("PY-CH01-S01", "Python 是什么", ["K001"]),
        leaf("PY-CH01-S02", "变量与赋值", ["K002"]),
        leaf("PY-CH01-S03", "基本数据类型", ["K003"]),
        leaf("PY-CH01-S04", "输入输出", ["K004"]),
        leaf("PY-CH01-S05", "运算符", ["K005"]),
      ],
    },
    {
      node_id: "PY-CH02",
      title: "控制结构",
      source_ids: ["K006", "K007", "K008"],
      children: [
        leaf("PY-CH02-S01", "条件判断", ["K006"]),
        leaf("PY-CH02-S02", "for 循环", ["K007"]),
        leaf("PY-CH02-S03", "while 循环", ["K008"]),
      ],
    },
    {
      node_id: "PY-CH03",
      title: "数据容器与综合项目",
      source_ids: ["K009", "K010", "K011", "K012"],
      children: [
        leaf("PY-CH03-S01", "列表", ["K009"]),
        leaf("PY-CH03-S02", "字典", ["K010"]),
        leaf("PY-CH03-S03", "元组与集合", ["K011"]),
        leaf("PY-CH03-S04", "字符串常用操作", ["K012"]),
      ],
    },
    {
      node_id: "PY-CH04",
      title: "函数、文件与项目实践",
      source_ids: ["K013", "K014", "K015", "K016", "K017", "K018"],
      children: [
        leaf("PY-CH04-S01", "函数定义与调用", ["K013"]),
        leaf("PY-CH04-S02", "参数与返回值", ["K014"]),
        leaf("PY-CH04-S03", "成绩统计器综合项目", ["K018"]),
        leaf("PY-CH04-S04", "文件读写", ["K015"]),
        leaf("PY-CH04-S05", "异常处理与模块", ["K016", "K017"]),
      ],
    },
  ],
}

export function getPythonCurriculumTree(): CurriculumNode {
  return structuredClone(TREE)
}

export function mapCurriculumNodeToSourceIds(nodeId: string): string[] {
  const node = findNode(TREE, nodeId)
  return node ? [...node.source_ids] : []
}

export function resolveLearningGoalSpec(input: LearningGoalSpecInput): LearningGoalSpec {
  if (input.mode === "curriculum_node") {
    const selected = input.selected_node_ids ?? []
    const nodes = selected.map((nodeId) => findNode(TREE, nodeId)).filter((node): node is CurriculumNode => Boolean(node))
    const mapped = unique(nodes.flatMap((node) => node.source_ids))
    return {
      mode: "curriculum_node",
      selected_node_ids: selected,
      mapped_source_ids: mapped,
      goal_text: nodes.length > 0 ? `学习${nodes.map((node) => node.title).join("、")}` : "学习 Python 基础",
    }
  }

  const customGoal = input.custom_goal?.trim() ?? ""
  return {
    mode: "custom_goal",
    selected_node_ids: [],
    custom_goal: customGoal,
    mapped_source_ids: mapCustomGoalToSourceIds(customGoal),
    goal_text: customGoal,
  }
}

function mapCustomGoalToSourceIds(goal: string): string[] {
  const rules: Array<[RegExp, string[]]> = [
    [/成绩|统计|平均|项目/, ["K007", "K009", "K018"]],
    [/循环|遍历|for/, ["K007"]],
    [/while|条件循环/, ["K008"]],
    [/列表|数组|一组数据/, ["K009"]],
    [/条件|判断|if/, ["K006"]],
    [/函数|def|return/, ["K013", "K014"]],
    [/输入|输出|print|input/, ["K004"]],
  ]
  return unique(rules.flatMap(([pattern, sourceIds]) => pattern.test(goal) ? sourceIds : []))
}

function findNode(node: CurriculumNode, nodeId: string): CurriculumNode | null {
  if (node.node_id === nodeId) return node
  for (const child of node.children) {
    const found = findNode(child, nodeId)
    if (found) return found
  }
  return null
}

function leaf(node_id: string, title: string, source_ids: string[]): CurriculumNode {
  return { node_id, title, source_ids, children: [] }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
