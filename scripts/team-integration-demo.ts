import { retrieveKnowledge } from "../src/rag/retriever"
import type { KnowledgeDifficulty } from "../src/knowledge/types"

interface LearnerProfile {
  learner_id: string
  level: KnowledgeDifficulty
  known_concepts: string[]
  weak_concepts: string[]
  goal: string
}

const profile = (await Bun.file("examples/learner_loop_weak.json").json()) as LearnerProfile

const query = [
  `学习者水平：${profile.level}`,
  `已掌握：${profile.known_concepts.join("、")}`,
  `薄弱点：${profile.weak_concepts.join("、")}`,
  `学习目标：${profile.goal}`,
].join("；")

const ragResult = await retrieveKnowledge({ query, learnerLevel: profile.level, topK: 5 })

const handoff = {
  workflow: "B_profile_to_A_rag_to_C_content_to_D_display",
  github: {
    repository: "https://github.com/jiangdongouyang-lab/knowbalance.git",
    update_command: "git pull origin main",
  },
  b_profile: {
    ...profile,
    learner_id: "demo_loop_weak",
  },
  a_rag_request: {
    learner_profile: profile,
    query,
    top_k: 5,
  },
  a_rag_result: ragResult,
  c_content_contract: {
    allowed_sources: ["facts", "examples", "practiceTasks", "quizItems"],
    rule: "C must generate lessons, labs, and quizzes only from rag_result evidence.",
    required_citations: ragResult.results.flatMap((item) =>
      item.facts.slice(0, 1).map((fact) => ({ source_id: item.source_id, fact_id: fact.fact_id ?? fact.factId })),
    ),
  },
  d_display_contract: {
    required_sections: ["profile", "rag_result", "retrieval_trace", "citations"],
    trace_fields: ["matched_keywords", "matched_fields", "score_breakdown"],
  },
}

console.log(JSON.stringify(handoff, null, 2))
