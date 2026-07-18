import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"

const text = (path: string) => readFileSync(path, "utf8")

describe("GitHub collaboration package", () => {
  test("documents branch, permission, and pull request workflow for A/B/C/D", () => {
    expect(existsSync("docs/github_collaboration_guide.md")).toBe(true)
    const guide = text("docs/github_collaboration_guide.md")

    expect(guide).toContain("https://github.com/jiangdongouyang-lab/knowbalance.git")
    expect(guide).toContain("Collaborator")
    expect(guide).toContain("Fork")
    expect(guide).toContain("Pull Request")
    expect(guide).toContain("role-a/")
    expect(guide).toContain("role-b/")
    expect(guide).toContain("role-c/")
    expect(guide).toContain("role-d/")
    expect(guide).toContain("bun run check")
    expect(guide).toContain("bun scripts/team-integration-demo.ts")
  })

  test("provides a pull request template with role and verification checklist", () => {
    expect(existsSync(".github/pull_request_template.md")).toBe(true)
    const template = text(".github/pull_request_template.md")

    expect(template).toContain("角色")
    expect(template).toContain("A")
    expect(template).toContain("B")
    expect(template).toContain("C")
    expect(template).toContain("D")
    expect(template).toContain("bun run check")
    expect(template).toContain("bun scripts/team-integration-demo.ts")
  })

  test("declares role ownership expectations", () => {
    expect(existsSync(".github/CODEOWNERS")).toBe(true)
    const codeowners = text(".github/CODEOWNERS")

    expect(codeowners).toContain("/knowledge_base/")
    expect(codeowners).toContain("/src/rag/")
    expect(codeowners).toContain("/src/role-b-profile/")
    expect(codeowners).toContain("/src/role-c-content/")
    expect(codeowners).toContain("/src/role-d-ui/")
  })

  test("creates role directory skeletons for teammates", () => {
    const roleDirectories = [
      "src/role-a-knowledge/.gitkeep",
      "src/role-b-profile/.gitkeep",
      "src/role-c-content/.gitkeep",
      "src/role-d-ui/.gitkeep",
    ]

    for (const file of roleDirectories) {
      expect(existsSync(file)).toBe(true)
    }
  })
})
