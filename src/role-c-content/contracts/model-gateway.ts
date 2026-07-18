/** Vendor-neutral boundary. Prompt/model work can replace this without changing C contracts. */
export interface ModelGateway {
  generateStructured<T>(request: {
    task: string
    system_prompt: string
    input: unknown
    output_schema_id: string
    temperature: number
    max_tokens: number
    idempotency_key: string
  }): Promise<T>
}

/** No production default is provided: an absent provider returns a clear blocked state. */
export class ModelProviderUnavailableError extends Error {
  constructor(message = "未配置 ModelGateway，C 生成阶段不能开始") {
    super(message)
    this.name = "ModelProviderUnavailableError"
  }
}
