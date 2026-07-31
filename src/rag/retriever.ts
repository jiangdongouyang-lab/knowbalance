import { loadKnowledgeBase } from "../knowledge/loader"
import type {
  KnowledgeBase,
  KnowledgeDifficulty,
  KnowledgeExample,
  KnowledgeFact,
  KnowledgeQuizItem,
} from "../knowledge/types"

export interface RetrieveKnowledgeInput {
  query: string
  learnerLevel?: KnowledgeDifficulty
  topK?: number
}

export interface RagResultItem {
  sourceId: string
  source_id: string
  title: string
  difficulty: KnowledgeDifficulty
  score: number
  reason: string
  snippet: string
  facts: KnowledgeFact[]
  examples: KnowledgeExample[]
  practiceTasks: string[]
  quizItems: KnowledgeQuizItem[]
  file: string
  retrievalTrace: RetrievalTrace
  retrieval_trace: RetrievalTraceJson
}

export interface RetrievalTrace {
  matchedKeywords: string[]
  matchedFields: string[]
  difficultyMatch: boolean
  scoreBreakdown: {
    keyword: number
    title: number
    facts: number
    practiceTasks: number
    difficulty: number
    bonus: number
  }
}

export interface RetrievalTraceJson {
  matched_keywords: string[]
  matched_fields: string[]
  difficulty_match: boolean
  score_breakdown: RetrievalTrace["scoreBreakdown"]
}

export interface RagResult {
  query: string
  learnerLevel?: KnowledgeDifficulty
  topK: number
  results: RagResultItem[]
}

const DIFFICULTY_ORDER: Record<KnowledgeDifficulty, number> = { beginner: 0, basic: 1, intermediate: 2, integrated: 3 }

const SYNONYMS: Record<string, string[]> = {
  循环: ["一遍遍", "反复", "多次执行", "重复处理"],
  重复执行: ["一遍遍", "反复", "多次执行", "重复处理"],
  列表: ["很多数据", "多个数据", "一组数据", "一批成绩"],
  函数: ["封装", "复用代码", "小工具"],
}

export async function retrieveKnowledge(input: RetrieveKnowledgeInput): Promise<RagResult> {
  return retrieveKnowledgeFromKnowledgeBase(input, await loadKnowledgeBase())
}

/** Content-based retrieval over an injected knowledge base. */
export function retrieveKnowledgeFromKnowledgeBase(
  input: RetrieveKnowledgeInput,
  knowledgeBase: KnowledgeBase,
): RagResult {
  const topK = input.topK ?? 3
  const normalizedQuery = normalize(input.query)
  const expandedTerms = expandQueryTerms(normalizedQuery)

  const scored = knowledgeBase.items
    .map((item) => {
      const matchedKeywords = item.keywords.filter((keyword) => expandedTerms.includes(normalize(keyword)))
      const synonymHits = item.keywords.filter((keyword) => !normalizedQuery.includes(normalize(keyword)) && expandedTerms.includes(normalize(keyword)))
      const titleHit = normalizedQuery.includes(normalize(item.title))
      const factHits = item.facts.filter((fact) => normalizedQueryIncludesAny(normalizedQuery, fact.content)).length
      const taskHits = item.practiceTasks.filter((task) => normalizedQueryIncludesAny(normalizedQuery, task)).length
      const levelBonus = input.learnerLevel ? Math.max(0, 3 - Math.abs(DIFFICULTY_ORDER[item.difficulty] - DIFFICULTY_ORDER[input.learnerLevel])) : 0
      const scoreBreakdown = {
        keyword: matchedKeywords.length * 10,
        title: titleHit ? 5 : 0,
        facts: factHits * 3,
        practiceTasks: taskHits * 2,
        difficulty: levelBonus,
        bonus: synonymHits.length * 6,
      }
      const score = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0)
      const matchedFields = [
        ...(matchedKeywords.length > 0 ? ["keywords"] : []),
        ...(titleHit ? ["title"] : []),
        ...(factHits > 0 ? ["facts"] : []),
        ...(taskHits > 0 ? ["practiceTasks"] : []),
        ...(levelBonus > 0 ? ["difficulty"] : []),
        ...(synonymHits.length > 0 ? ["synonyms"] : []),
      ]

      return {
        item,
        score,
        reason: matchedKeywords.length > 0 ? `query 命中关键词：${matchedKeywords.join("、")}` : "query 与知识点内容存在弱匹配",
        retrievalTrace: {
          matchedKeywords,
          matchedFields,
          difficultyMatch: levelBonus > 0,
          scoreBreakdown,
        },
      }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.item.sourceId.localeCompare(right.item.sourceId))
    .slice(0, topK)

  return {
    query: input.query,
    learnerLevel: input.learnerLevel,
    topK,
    results: scored.map(({ item, score, reason, retrievalTrace }) => ({
      sourceId: item.sourceId,
      source_id: item.sourceId,
      title: item.title,
      difficulty: item.difficulty,
      score,
      reason,
      snippet: item.snippet,
      facts: item.facts.map((fact) => ({ ...fact, source_id: fact.source_id ?? fact.sourceId, fact_id: fact.fact_id ?? fact.factId })),
      examples: item.examples,
      practiceTasks: item.practiceTasks,
      quizItems: item.quizItems,
      file: item.file,
      retrievalTrace,
      retrieval_trace: {
        matched_keywords: retrievalTrace.matchedKeywords,
        matched_fields: retrievalTrace.matchedFields,
        difficulty_match: retrievalTrace.difficultyMatch,
        score_breakdown: retrievalTrace.scoreBreakdown,
      },
    })),
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "")
}

function expandQueryTerms(normalizedQuery: string): string {
  const expansions = Object.entries(SYNONYMS)
    .filter(([, aliases]) => aliases.some((alias) => normalizedQuery.includes(normalize(alias))))
    .map(([canonical]) => normalize(canonical))

  return [normalizedQuery, ...expansions].join(" ")
}

function normalizedQueryIncludesAny(normalizedQuery: string, value: string): boolean {
  return value.split(/[，。、“”"'：:；;、\s]+/).map(normalize).filter((part) => part.length >= 2).some((part) => normalizedQuery.includes(part))
}
