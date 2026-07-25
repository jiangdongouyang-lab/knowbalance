import { describe, expect, test } from "bun:test"

const REQUIRED_DOC_PHRASES = [
  "https://github.com/jiangdongouyang-lab/knowbalance.git",
  "B 画像构建",
  "A RAG 检索",
  "C 内容生成",
  "D 展示与状态",
  "git pull origin main",
  "bun scripts/team-integration-demo.ts",
]

describe("team integration assets", () => {
  test("documents the GitHub-based B/C/D integration workflow", async () => {
    const guide = await Bun.file("docs/team_integration_guide.md").text()

    for (const phrase of REQUIRED_DOC_PHRASES) {
      expect(guide).toContain(phrase)
    }
  })

  test("ships a RAG request schema that B can target", async () => {
    const schema = await Bun.file("schemas/rag_request.schema.json").json()

    expect(schema.$schema).toContain("json-schema")
    expect(schema.required).toEqual(expect.arrayContaining(["learner_profile", "query", "top_k"]))
    expect(schema.properties.learner_profile.required).toEqual(expect.arrayContaining(["level", "known_concepts", "weak_concepts", "goal"]))
  })

  test("ships an example RAG result that C/D can consume", async () => {
    const example = await Bun.file("examples/rag_result_example.json").json()

    expect(example.query.length).toBeGreaterThan(0)
    expect(example.results.length).toBeGreaterThan(0)
    expect(example.results[0].source_id).toMatch(/^K\d{3}$/)
    expect(example.results[0].facts[0].fact_id).toMatch(/^F\d{3}$/)
    expect(example.results[0].retrieval_trace.matched_keywords.length).toBeGreaterThan(0)
  })

  test("ships a knowledge base changelog with current GitHub sync entry", async () => {
    const changelog = await Bun.file("docs/knowledge_base_changelog.md").text()

    expect(changelog).toContain("1d9cabb")
    expect(changelog).toContain("GitHub")
    expect(changelog).toContain("B/C/D")
    expect(changelog).toContain("git pull origin main")
  })

  test("team integration demo produces B/A/C/D handoff JSON", async () => {
    const proc = Bun.spawn(["bun", "scripts/team-integration-demo.ts"], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)

    const output = JSON.parse(stdout)
    expect(output.workflow).toEqual("B_profile_to_A_rag_to_C_content_to_D_display")
    expect(output.github.repository).toBe("https://github.com/jiangdongouyang-lab/knowbalance.git")
    expect(output.b_profile.learner_id).toBe("demo_loop_weak")
    expect(output.a_rag_result.results.length).toBeGreaterThanOrEqual(3)
    expect(output.c_content_contract.required_citations[0]).toHaveProperty("source_id")
    expect(output.d_display_contract.required_sections).toEqual(expect.arrayContaining(["profile", "rag_result", "retrieval_trace", "citations"]))
    expect(output.d_display_contract.implementation).toContain("React + Vite")
    expect(output.d_display_contract.ui_files).toEqual(expect.arrayContaining([
      "src/role-d-ui/src/App.tsx",
      "src/role-d-ui/src/domain/workspace-store.ts",
      "src/role-d-ui/src/domain/progress-file.ts",
      "src/role-d-ui/src/components/EvidenceInspector.tsx",
    ]))
    expect(output.d_display_contract.progress_file).toMatchObject({
      format: "knowbalance-progress",
      version: 1,
      session_valid: true,
    })
    expect(output.d_display_contract.role_c_status).toBe("ready")
    expect(output.d_display_contract.public_artifacts.map((artifact: { kind: string; status: string }) => `${artifact.kind}:${artifact.status}`)).toEqual([
      "lesson:real",
      "lab:real",
      "assessment:real",
    ])
    expect(output.d_display_contract.role_d_session_summary).toMatchObject({
      valid: true,
      retrieval_items: expect.any(Number),
      artifacts: 3,
    })
    expect(output.d_display_contract.role_d_session_summary.workflow_events).toBeGreaterThan(0)
  })
})
