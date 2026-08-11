import type { MeetingRecord } from "./types";

function formatTimestamp(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function transcriptLines(meeting: MeetingRecord): string[] {
  return meeting.segments
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((seg) => {
      const speaker = seg.channel === "mic" ? "You" : "Participants";
      return `[${formatTimestamp(seg.start)}] ${speaker}: ${seg.text}`;
    });
}

export function toMarkdown(meeting: MeetingRecord): string {
  const lines = [`# ${meeting.title}`, "", `_${new Date(meeting.startedAt).toLocaleString()}_`, ""];
  if (meeting.summary) {
    lines.push("## Summary", "", meeting.summary, "");
  }
  lines.push("## Transcript", "", ...transcriptLines(meeting).map((line) => `- ${line}`));
  return lines.join("\n");
}

export function toPlainText(meeting: MeetingRecord): string {
  const lines = [meeting.title, new Date(meeting.startedAt).toLocaleString(), ""];
  if (meeting.summary) {
    lines.push("SUMMARY", "", meeting.summary, "");
  }
  lines.push("TRANSCRIPT", "", ...transcriptLines(meeting));
  return lines.join("\n");
}

export function toJson(meeting: MeetingRecord): string {
  return JSON.stringify(meeting, null, 2);
}

export function downloadTextFile(filename: string, content: string, mimeType = "text/plain"): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
