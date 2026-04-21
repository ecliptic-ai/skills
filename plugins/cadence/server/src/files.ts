/**
 * Gemini Files API: upload + disk-backed cache.
 *
 * Gemini retains uploaded files for 48h. We cache file IDs keyed by
 * (absolute path, size, mtime) so re-runs within that window skip the upload.
 * Before trusting the cache we verify with `files.get` in case Gemini expired
 * or deleted the file early.
 */
import { GoogleGenAI } from "@google/genai";
import { readFile, stat, mkdir, writeFile, readFile as readFileRaw } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CACHE_DIR || resolve(__dirname, "../.mcp-cache");
const CACHE_PATH = resolve(CACHE_DIR, "gemini-files.json");

let cachedClient: GoogleGenAI | null = null;
export function client(): GoogleGenAI {
  if (!cachedClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Gemini API key is not configured. Open /plugin → Installed → cadence → Configure options to set gemini_api_key, then /reload-plugins.",
      );
    }
    cachedClient = new GoogleGenAI({ apiKey });
  }
  return cachedClient;
}

// --- MIME detection ---

const VIDEO_MIMES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  "3gp": "video/3gpp",
  flv: "video/x-flv",
  wmv: "video/wmv",
};

const AUDIO_MIMES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
};

export function detectMimeType(path: string, kind: "video" | "audio"): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const map = kind === "video" ? VIDEO_MIMES : AUDIO_MIMES;
  const found = map[ext];
  if (!found) {
    throw new Error(
      `Unsupported ${kind} extension: .${ext}. Supported: ${Object.keys(map).join(", ")}`,
    );
  }
  return found;
}

// --- Cache ---

export type GeminiFile = {
  name: string;
  uri: string;
  mimeType: string;
};

type CacheEntry = GeminiFile & {
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  uploadedAtMs: number;
};

let cacheMem: Record<string, CacheEntry> | null = null;

async function loadCache(): Promise<Record<string, CacheEntry>> {
  if (cacheMem) return cacheMem;
  try {
    const raw = await readFileRaw(CACHE_PATH, "utf8");
    cacheMem = JSON.parse(raw);
  } catch {
    cacheMem = {};
  }
  return cacheMem!;
}

async function saveCache(cache: Record<string, CacheEntry>): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

export async function uploadAndWait(path: string, mimeType: string): Promise<GeminiFile> {
  const ai = client();
  const absPath = resolve(path);
  const st = await stat(absPath);
  const cache = await loadCache();
  const cached = cache[absPath];

  if (cached && cached.sourceSize === st.size && cached.sourceMtimeMs === st.mtimeMs) {
    try {
      const remote = await ai.files.get({ name: cached.name });
      if (remote.state === "ACTIVE") {
        return { name: cached.name, uri: cached.uri, mimeType: cached.mimeType };
      }
    } catch {
      // Fall through to re-upload.
    }
  }

  const buffer = await readFile(absPath);
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  let file = await ai.files.upload({
    file: blob,
    config: { displayName: basename(absPath), mimeType },
  });

  while (file.state === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai.files.get({ name: file.name! });
  }
  if (file.state === "FAILED") {
    throw new Error(`File processing failed: ${file.name}`);
  }

  const result: GeminiFile = {
    name: file.name!,
    uri: file.uri!,
    mimeType: file.mimeType!,
  };

  cache[absPath] = {
    ...result,
    sourcePath: absPath,
    sourceSize: st.size,
    sourceMtimeMs: st.mtimeMs,
    uploadedAtMs: Date.now(),
  };
  await saveCache(cache);

  return result;
}

// --- Listing + purging (for the gemini-* tools) ---

export type UploadedFile = {
  name: string;
  displayName: string | null;
  uri: string;
  mimeType: string;
  sizeBytes: number | null;
  state: string;
  createTime: string | null;
  expirationTime: string | null;
};

export async function listUploadedFiles(): Promise<UploadedFile[]> {
  const ai = client();
  const pager = await ai.files.list();
  const out: UploadedFile[] = [];
  for await (const f of pager) {
    out.push({
      name: f.name ?? "",
      displayName: f.displayName ?? null,
      uri: f.uri ?? "",
      mimeType: f.mimeType ?? "",
      sizeBytes: f.sizeBytes ? Number(f.sizeBytes) : null,
      state: (f.state as any) ?? "UNKNOWN",
      createTime: f.createTime ? String(f.createTime) : null,
      expirationTime: f.expirationTime ? String(f.expirationTime) : null,
    });
  }
  return out;
}

export async function deleteUploadedFile(fileId: string): Promise<void> {
  const ai = client();
  await ai.files.delete({ name: fileId });
  const cache = await loadCache();
  let mutated = false;
  for (const [path, entry] of Object.entries(cache)) {
    if (entry.name === fileId) {
      delete cache[path];
      mutated = true;
    }
  }
  if (mutated) await saveCache(cache);
}

export async function purgeOrphans(dryRun: boolean): Promise<{
  kept: string[];
  orphans: UploadedFile[];
  deleted: string[];
}> {
  const cache = await loadCache();
  const cachedIds = new Set(Object.values(cache).map((e) => e.name));
  const all = await listUploadedFiles();
  const kept: string[] = [];
  const orphans: UploadedFile[] = [];
  for (const f of all) {
    if (cachedIds.has(f.name)) kept.push(f.name);
    else orphans.push(f);
  }

  const deleted: string[] = [];
  if (!dryRun) {
    const ai = client();
    for (const f of orphans) {
      await ai.files.delete({ name: f.name });
      deleted.push(f.name);
    }
  }
  return { kept, orphans, deleted };
}
