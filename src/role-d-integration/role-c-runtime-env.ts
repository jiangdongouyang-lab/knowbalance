export function resolveRoleCRuntimeEnvironment(
  processEnvironment: Record<string, string | undefined>,
  privateEnvText = "",
): Record<string, string | undefined> {
  const fileEnvironment = parseEnvFile(privateEnvText)
  return { ...fileEnvironment, ...processEnvironment }
}

export function resolveRoleCProviderMode(
  environment: Record<string, string | undefined>,
): "model" | "deterministic" {
  return environment.ROLE_C_MODEL_ENDPOINT?.trim() && environment.ROLE_C_MODEL_ID?.trim()
    ? "model"
    : "deterministic"
}

function parseEnvFile(text: string): Record<string, string> {
  const output: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const rawValue = line.slice(separator + 1).trim()
    const value = rawValue.length >= 2
      && ((rawValue.startsWith('"') && rawValue.endsWith('"'))
        || (rawValue.startsWith("'") && rawValue.endsWith("'")))
      ? rawValue.slice(1, -1)
      : rawValue
    output[key] = value
  }
  return output
}
