import "server-only";

export interface TaskFileRecord {
  id: string;
  organization_id: string;
  project_id: string;
  task_id: string;
  original_filename: string;
  mime_type: string;
  byte_size: string | number;
  sha256: string;
  storage_key: string;
  uploaded_by_user_id: string;
  uploaded_by_name?: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_by_user_id: string | null;
}

export interface PublicTaskFile {
  id: string;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  uploaded_by_name: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export function publicTaskFile(file: TaskFileRecord): PublicTaskFile {
  return {
    id: file.id,
    original_filename: file.original_filename,
    mime_type: file.mime_type,
    byte_size: Number(file.byte_size),
    uploaded_by_name: file.uploaded_by_name ?? null,
    version: file.version,
    created_at: file.created_at,
    updated_at: file.updated_at,
  };
}

export function privateFileSigningKey(): string | null {
  const key = process.env.NEXORA_FILE_SIGNING_KEY;
  return key && Buffer.byteLength(key, "utf8") >= 32 ? key : null;
}

export function requestedPrivateFilename(request: Request): string | null {
  const value = request.headers.get("x-file-name");
  if (!value || value.length > 720) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function privateFileContentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
