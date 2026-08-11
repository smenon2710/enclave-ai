export interface OpenRouterModel {
  id: string;
  name: string;
  isFree: boolean;
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
    .map(
      (m: { id?: unknown; name?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }) => ({
        id: typeof m.id === "string" ? m.id : "",
        name: typeof m.name === "string" ? m.name : "",
        // OpenRouter's own convention for its free tier — checking the id
        // suffix (rather than trusting pricing === "0" alone) excludes
        // zero-priced non-text/preview models that aren't really "pick this
        // for free chat" options.
        isFree:
          typeof m.id === "string" &&
          (m.id.endsWith(":free") || m.id === "openrouter/free"),
      })
    )
    .filter((m: OpenRouterModel) => m.id.length > 0)
    .sort((a: OpenRouterModel, b: OpenRouterModel) => a.name.localeCompare(b.name));
}
