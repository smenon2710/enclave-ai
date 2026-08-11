import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { MeetingRecord } from "./types";

interface EnclaveDB extends DBSchema {
  meetings: {
    key: string;
    value: MeetingRecord;
    indexes: { "by-startedAt": number };
  };
}

const DB_NAME = "enclave-ai-history";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<EnclaveDB>> | null = null;

function getDb(): Promise<IDBPDatabase<EnclaveDB>> {
  if (!dbPromise) {
    dbPromise = openDB<EnclaveDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore("meetings", { keyPath: "id" });
        store.createIndex("by-startedAt", "startedAt");
      },
    });
  }
  return dbPromise;
}

export async function saveMeeting(meeting: MeetingRecord): Promise<void> {
  const db = await getDb();
  await db.put("meetings", meeting);
}

export async function listMeetings(): Promise<MeetingRecord[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex("meetings", "by-startedAt");
  return all.reverse();
}

export async function deleteMeeting(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("meetings", id);
}

export async function clearAllMeetings(): Promise<void> {
  const db = await getDb();
  await db.clear("meetings");
}

export async function importMeetings(meetings: MeetingRecord[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("meetings", "readwrite");
  await Promise.all(meetings.map((m) => tx.store.put(m)));
  await tx.done;
}
