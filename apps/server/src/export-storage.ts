import { supabaseStorage } from "./storage.js";
export interface ExportStorage {
  writeJson(key: string, value: unknown): Promise<void>;
  read(key: string): Promise<Buffer>;
  signDownload(key: string, name: string): Promise<string>;
  remove(key: string): Promise<void>;
}
export async function exportStorageFromEnvironment(): Promise<
  ExportStorage | undefined
> {
  if (!process.env.EXPORT_BUCKET) return undefined;
  if (!process.env.STORAGE_SERVER_KEY)
    throw new Error("EXPORT_BUCKET requires STORAGE_SERVER_KEY");
  if (
    process.env.EXPORT_BUCKET ===
    (process.env.STORAGE_BUCKET ?? "lira-attachments")
  )
    throw new Error("Exports require a separate private bucket");
  const storage = supabaseStorage(
    process.env.SUPABASE_URL ?? "",
    process.env.STORAGE_SERVER_KEY,
    process.env.EXPORT_BUCKET,
    fetch,
    "exports",
  );
  await storage.verifyBucket();
  return storage;
}
