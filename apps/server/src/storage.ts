import { createHash } from "node:crypto";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const WORKSPACE_BYTES = 1024 * 1024 * 1024;
export const MEDIA_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/plain",
];
export interface ObjectStorage {
  signUpload(key: string): Promise<string>;
  read(key: string): Promise<Buffer>;
  signDownload(key: string, name: string): Promise<string>;
  remove(key: string): Promise<void>;
}
export interface AttachmentOptions {
  storage: ObjectStorage;
  pilotOrgs: ReadonlySet<string>;
}
/** Signature checks are not malware scanning. External uploads remain disabled. */
export function validFile(
  bytes: Buffer,
  type: string,
  size: number,
  checksum: string,
) {
  if (
    bytes.length !== size ||
    bytes.length > MAX_FILE_BYTES ||
    createHash("sha256").update(bytes).digest("hex") !== checksum
  )
    return false;
  if (type === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg")
    return (
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255 &&
      bytes.at(-2) === 255 &&
      bytes.at(-1) === 217
    );
  if (type === "application/pdf")
    return (
      bytes.subarray(0, 5).toString() === "%PDF-" &&
      bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
    );
  if (type === "text/plain") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return (
        !bytes.some((b) => b < 32 && ![9, 10, 13].includes(b)) &&
        !/<\s*(?:!doctype|html|script|svg)\b/i.test(text)
      );
    } catch {
      return false;
    }
  }
  return false;
}
/** A dedicated server credential is confined to this adapter; never return provider errors/keys. */
export function supabaseStorage(
  origin: string,
  credential: string,
  bucket: string,
  request = fetch,
  kind: "attachments" | "exports" = "attachments",
): ObjectStorage & {
  verifyBucket(): Promise<void>;
  writeJson(key: string, value: unknown): Promise<void>;
} {
  const url = new URL(origin);
  if (
    (url.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Invalid storage origin");
  if (!/^[a-z0-9-]{1,63}$/.test(bucket) || !credential)
    throw new Error("Invalid storage configuration");
  const fileLimit = kind === "exports" ? 5242880 : MAX_FILE_BYTES;
  const allowedTypes = kind === "exports" ? ["application/json"] : MEDIA_TYPES;
  const base = `${url.origin}/storage/v1`;
  const path = (key: string) => {
    if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key))
      throw new Error("Invalid object key");
    return `${bucket}/${key}`;
  };
  async function call(route: string, method = "GET", body?: unknown) {
    const response = await request(`${base}${route}`, {
      method,
      headers: {
        apikey: credential,
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("storage_unavailable");
    return response;
  }
  function signed(relative: string) {
    if (typeof relative !== "string" || !relative.startsWith("/object/"))
      throw new Error("Invalid storage response");
    const result = new URL(`${base}${relative}`);
    if (result.origin !== url.origin || !result.searchParams.has("token"))
      throw new Error("Invalid storage response");
    return result;
  }
  return {
    async verifyBucket() {
      const info = (await (await call(`/bucket/${bucket}`)).json()) as {
        public: boolean;
        file_size_limit: number;
        allowed_mime_types: string[];
      };
      if (
        info.public !== false ||
        !Number.isInteger(info.file_size_limit) ||
        info.file_size_limit < 1 ||
        info.file_size_limit > fileLimit ||
        !Array.isArray(info.allowed_mime_types) ||
        !info.allowed_mime_types.length ||
        info.allowed_mime_types.some((t) => !allowedTypes.includes(t))
      )
        throw new Error(
          "Storage bucket must be private with the configured size limit and explicit allowed media types",
        );
    },
    async writeJson(key, value) {
      if (kind !== "exports") throw new Error("Export bucket required");
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > fileLimit)
        throw new Error("export_too_large");
      const response = await request(`${base}/object/${path(key)}`, {
        method: "POST",
        headers: {
          apikey: credential,
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
          "Cache-Control": "max-age=0",
        },
        body,
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          error?: string;
          statusCode?: string;
        };
        if (!(
          [400, 409].includes(response.status) &&
          (failure.error === "Duplicate" || failure.statusCode === "409")
        ))
          throw new Error("storage_unavailable");
      }
    },
    async signUpload(key) {
      if (kind !== "attachments")
        throw new Error("Uploads are not allowed in the export bucket");
      const data = (await (
        await call(`/object/upload/sign/${path(key)}`, "POST", {})
      ).json()) as { url: string };
      return signed(data.url).toString();
    },
    async signDownload(key, name) {
      const data = (await (
        await call(`/object/sign/${path(key)}`, "POST", { expiresIn: 60 })
      ).json()) as { signedURL: string };
      const result = signed(data.signedURL);
      result.searchParams.set("download", name);
      return result.toString();
    },
    async read(key) {
      const response = await call(`/object/authenticated/${path(key)}`);
      if (!response.body) throw new Error("storage_unavailable");
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > fileLimit) {
            await reader.cancel();
            throw new Error("oversized_object");
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    },
    async remove(key) {
      path(key);
      await call(`/object/${bucket}`, "DELETE", { prefixes: [key] });
    },
  };
}
export async function storageFromEnvironment(): Promise<
  AttachmentOptions | undefined
> {
  const ids =
    process.env.ATTACHMENT_PILOT_ORGS?.split(",")
      .map((x) => x.trim())
      .filter(Boolean) ?? [];
  if (!process.env.STORAGE_SERVER_KEY) {
    if (ids.length) throw new Error("Pilot uploads require STORAGE_SERVER_KEY");
    return undefined;
  }
  if (
    ids.some(
      (id) =>
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          id,
        ),
    )
  )
    throw new Error("Invalid ATTACHMENT_PILOT_ORGS");
  const storage = supabaseStorage(
    process.env.SUPABASE_URL ?? "",
    process.env.STORAGE_SERVER_KEY,
    process.env.STORAGE_BUCKET ?? "lira-attachments",
  );
  await storage.verifyBucket();
  return { storage, pilotOrgs: new Set(ids) };
}
