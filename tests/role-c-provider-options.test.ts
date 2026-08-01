import { describe, expect, test } from "bun:test"
import { modelBackedProviderOptionsFromEnv } from "../src/role-c-content"

describe("Role C model Provider environment", () => {
  test("uses stable staged production defaults", () => {
    expect(modelBackedProviderOptionsFromEnv({})).toEqual({
      generation_strategy: "staged",
      max_repair_attempts: 1,
      concept_temperature: 0,
      code_lab_temperature: 0,
      assessment_temperature: 0,
      concept_max_tokens: 8_000,
      code_lab_max_tokens: 7_000,
      assessment_max_tokens: 8_000,
      concept_group_size: 1,
      concept_concurrency: 1,
      concept_segment_max_tokens: 3_500,
      code_lab_public_max_tokens: 3_500,
      code_lab_secure_max_tokens: 5_000,
      assessment_public_max_tokens: 4_500,
      assessment_secure_max_tokens: 5_500,
    })
  })

  test("applies configurable budgets and concurrency to every production caller", () => {
    const options = modelBackedProviderOptionsFromEnv({
      ROLE_C_MODEL_GENERATION_STRATEGY: "monolithic",
      ROLE_C_MODEL_MAX_REPAIR_ATTEMPTS: "0",
      ROLE_C_MODEL_CONCEPT_TEMPERATURE: "0.1",
      ROLE_C_MODEL_CODE_LAB_TEMPERATURE: "0.2",
      ROLE_C_MODEL_ASSESSMENT_TEMPERATURE: "0.3",
      ROLE_C_MODEL_CONCEPT_GROUP_SIZE: "2",
      ROLE_C_MODEL_CONCEPT_CONCURRENCY: "3",
      ROLE_C_MODEL_CODE_LAB_SECURE_MAX_TOKENS: "6200",
    })

    expect(options).toMatchObject({
      generation_strategy: "monolithic",
      max_repair_attempts: 0,
      concept_temperature: 0.1,
      code_lab_temperature: 0.2,
      assessment_temperature: 0.3,
      concept_group_size: 2,
      concept_concurrency: 3,
      code_lab_secure_max_tokens: 6200,
    })
  })

  test("rejects malformed values instead of silently changing them", () => {
    expect(() => modelBackedProviderOptionsFromEnv({ ROLE_C_MODEL_CONCEPT_CONCURRENCY: "0" })).toThrow()
    expect(() => modelBackedProviderOptionsFromEnv({ ROLE_C_MODEL_MAX_REPAIR_ATTEMPTS: "2" })).toThrow()
    expect(() => modelBackedProviderOptionsFromEnv({ ROLE_C_MODEL_ASSESSMENT_TEMPERATURE: "3" })).toThrow()
  })
})
