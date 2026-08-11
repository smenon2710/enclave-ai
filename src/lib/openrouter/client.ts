export interface SummarizeOptions {
  apiKey: string;
  model: string;
  transcriptText: string;
}

const SYSTEM_PROMPT = `You are an assistant that summarizes meeting transcripts for the meeting's owner.
The transcript has two speaker labels: "You" (the owner) and "Participants" (everyone else on the call — not individually identified, since this app doesn't diarize remote speakers).
Produce a concise Markdown summary with exactly these four sections, in this order:

## Executive Briefing
## Key Decisions Made
## Action Items & Task Assignments
## Unresolved Questions

If a section has nothing to report, write "None noted." under it. Only use information present in the transcript — do not invent names, dates, or facts.`;

/** Called directly from the browser — the user's key never touches a server we control. */
export async function summarizeTranscript({
  apiKey,
  model,
  transcriptText,
}: SummarizeOptions): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: transcriptText },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter request failed (${response.status}): ${body.slice(0, 300) || response.statusText}`
    );
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("OpenRouter returned an empty response");
  }
  return content;
}
