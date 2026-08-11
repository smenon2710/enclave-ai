export interface OpenRouterModel {
  id: string;
  name: string;
}

/** Public endpoint — no API key required to list models. */
export async function fetchAvailableModels(): Promise<OpenRouterModel[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) {
    throw new Error(`Failed to fetch model list (${response.status})`);
  }

  const data = await response.json();
  const raw = Array.isArray(data?.data) ? data.data : [];

  return raw
    .map((m: { id?: unknown; name?: unknown }) => ({
      id: typeof m.id === "string" ? m.id : "",
      name: typeof m.name === "string" ? m.name : "",
    }))
    .filter((m: OpenRouterModel) => m.id.length > 0)
    .sort((a: OpenRouterModel, b: OpenRouterModel) => a.name.localeCompare(b.name));
}
