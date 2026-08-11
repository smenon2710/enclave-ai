import type { TranscriptSegment } from "@/lib/stt/types";

export interface MeetingRecord {
  id: string;
  title: string;
  startedAt: number;
  durationSeconds: number;
  segments: TranscriptSegment[];
  summary: string | null;
  summaryModel: string | null;
}
