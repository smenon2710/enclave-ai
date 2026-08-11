"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteMeeting, importMeetings, listMeetings, saveMeeting } from "@/lib/history/db";
import type { MeetingRecord } from "@/lib/history/types";

export function useMeetingHistory() {
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);

  const refresh = useCallback(async () => {
    setMeetings(await listMeetings());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadInitial() {
      const all = await listMeetings();
      if (!cancelled) setMeetings(all);
    }
    loadInitial();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (meeting: MeetingRecord) => {
      await saveMeeting(meeting);
      await refresh();
    },
    [refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteMeeting(id);
      await refresh();
    },
    [refresh]
  );

  const importAll = useCallback(
    async (records: MeetingRecord[]) => {
      await importMeetings(records);
      await refresh();
    },
    [refresh]
  );

  return { meetings, save, remove, importAll };
}
