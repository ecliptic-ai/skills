/**
 * Reasoning sensors — AI-based perception via Gemini.
 *
 * Timestamp format at the Gemini boundary is MM:SS.mmm (Gemini's native format
 * for video/audio). The rest of the framework uses decimal seconds. We convert
 * at the boundary so the Gemini layer is isolated and everyone else speaks
 * one consistent unit.
 */
import { GoogleGenAI, Type } from "@google/genai";
import { readFile, stat, mkdir, writeFile, readFile as readFileRaw } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

let cachedClient: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (!cachedClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Gemini API key is not configured. Open Claude Code's plugin browser (`/plugin`), select 'cadence', choose 'Configure options', and paste your key (get one at https://aistudio.google.com/apikey)."
      );
    }
    cachedClient = new GoogleGenAI({ apiKey });
  }
  return cachedClient;
}

// --- Timestamp conversion at the Gemini boundary ---

function secondsToMmss(s: number): string {
  if (s < 0) throw new Error(`Cannot convert negative seconds to MM:SS: ${s}`);
  const totalMs = Math.round(s * 1000);
  const mm = Math.floor(totalMs / 60000);
  const remMs = totalMs - mm * 60000;
  const ss = Math.floor(remMs / 1000);
  const ms = remMs - ss * 1000;
  return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

function mmssToSeconds(ts: string): number {
  const parts = ts.trim().split(":");
  if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  if (parts.length === 3) return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  throw new Error(`Timestamp must be MM:SS.mmm or HH:MM:SS.mmm, got: ${ts}`);
}

// --- MIME detection at the upload boundary ---
//
// Gemini sniffs from bytes in most cases, but sending the correct MIME keeps
// the Files API metadata accurate and makes failures easier to diagnose.

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

function detectMimeType(path: string, kind: "video" | "audio"): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const map = kind === "video" ? VIDEO_MIMES : AUDIO_MIMES;
  const found = map[ext];
  if (!found) {
    throw new Error(
      `Unsupported ${kind} extension: .${ext}. Supported: ${Object.keys(map).join(", ")}`
    );
  }
  return found;
}

// --- File upload with state polling and disk-backed cache ---
//
// Gemini retains uploaded files for 48 hours. We cache file IDs on disk keyed
// by (absolute path, size, mtime) so re-runs within that window skip the upload
// entirely. Before trusting the cache we verify with `files.get` in case Gemini
// expired or deleted the file early.

type GeminiFile = {
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

const __dirname = dirname(fileURLToPath(import.meta.url));
// In plugin mode, CACHE_DIR is set to ${CLAUDE_PLUGIN_DATA}/cache via .mcp.json.
// In local dev, fall back to server/.mcp-cache/.
const CACHE_DIR = process.env.CACHE_DIR || resolve(__dirname, "../../.mcp-cache");
const CACHE_PATH = resolve(CACHE_DIR, "gemini-files.json");
const LOGS_DIR = resolve(CACHE_DIR, "logs");

async function logGeminiCall(tool: string, prompt: string, extracted: any, result: unknown): Promise<void> {
  // Best-effort logging — never fail the caller because of log I/O.
  try {
    await mkdir(LOGS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = resolve(LOGS_DIR, `${ts}-${tool}.json`);
    await writeFile(
      path,
      JSON.stringify(
        {
          ts,
          tool,
          prompt,
          thoughts: extracted.thoughts,
          usage: extracted.usage,
          result,
        },
        null,
        2
      )
    );
  } catch {
    // swallow
  }
}

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
  // Prune from our disk cache too if referenced
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

async function uploadAndWait(path: string, mimeType: string): Promise<GeminiFile> {
  const ai = client();
  const absPath = resolve(path);
  const st = await stat(absPath);
  const cache = await loadCache();
  const cached = cache[absPath];

  if (cached && cached.sourceSize === st.size && cached.sourceMtimeMs === st.mtimeMs) {
    // Cache hit — verify the file still exists on Gemini's side
    try {
      const remote = await ai.files.get({ name: cached.name });
      if (remote.state === "ACTIVE") {
        return { name: cached.name, uri: cached.uri, mimeType: cached.mimeType };
      }
    } catch {
      // fall through to re-upload
    }
  }

  // Cache miss or stale — upload fresh
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

// --- Gemini-facing schemas (MM:SS.mmm strings) ---

const actionMomentsSchema = {
  type: Type.OBJECT,
  properties: {
    moments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          start: { type: Type.STRING, description: "Start timestamp in MM:SS.mmm format (e.g. 01:23.456)" },
          end: { type: Type.STRING, description: "End timestamp in MM:SS.mmm format" },
          description: { type: Type.STRING, description: "Brief description" },
          intensity: { type: Type.NUMBER, description: "Visual intensity score, 0-10" },
        },
        required: ["start", "end", "description", "intensity"],
      },
    },
  },
  required: ["moments"],
};

const segmentPickSchema = {
  type: Type.OBJECT,
  properties: {
    segmentStart: { type: Type.STRING, description: "Start of the best segment in MM:SS.mmm format (must match a beat from the grid)" },
    segmentEnd: { type: Type.STRING, description: "End of the best segment in MM:SS.mmm format (must match a beat from the grid)" },
    reasoning: { type: Type.STRING, description: "Why this segment was chosen" },
  },
  required: ["segmentStart", "segmentEnd", "reasoning"],
};

const editPlanSchema = {
  type: Type.OBJECT,
  properties: {
    clips: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          videoStart: { type: Type.STRING, description: "Clip start in MM:SS.mmm format" },
          videoEnd: { type: Type.STRING, description: "Clip end in MM:SS.mmm format" },
          momentDescription: { type: Type.STRING },
        },
        required: ["videoStart", "videoEnd", "momentDescription"],
      },
    },
  },
  required: ["clips"],
};

// --- Sensor implementations ---

export type ActionMoment = {
  startS: number;
  endS: number;
  description: string;
  intensity: number;
};

export async function findActionMoments(
  videoPath: string,
  fps: number = 5
): Promise<{ moments: ActionMoment[]; geminiFileId: string; usage: any }> {
  const file = await uploadAndWait(videoPath, detectMimeType(videoPath, "video"));
  const ai = client();

  const prompt = `You are a professional video editor analyzing footage for an action montage.

Watch this entire video. Identify every visually striking moment that would look exciting in a fast-paced montage.

Look for: impacts, hits, fast movement, explosions, dramatic poses, scene transitions, strong visual energy.

For each moment provide:
- start, end: timestamps in MM:SS.mmm format. For example "00:12.340" means 12.34 seconds into the video, "01:23.456" means 1 minute 23.456 seconds. Use millisecond precision to land on specific impact frames.
- description: brief description
- intensity: visual intensity 0-10 (10 = most striking)

Spread moments across the whole video. Return them sorted by intensity (highest first).`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        fileData: { fileUri: file.uri, mimeType: file.mimeType },
        videoMetadata: { fps },
      },
      { text: prompt },
    ],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: actionMomentsSchema,
      thinkingConfig: { includeThoughts: true },
    },
  });

  const extracted = extractResponse(response);
  const moments: ActionMoment[] = extracted.moments.map((m: any) => ({
    startS: mmssToSeconds(m.start),
    endS: mmssToSeconds(m.end),
    description: m.description,
    intensity: m.intensity,
  }));
  await logGeminiCall("find-action-moments", prompt, extracted, { moments });
  return { moments, geminiFileId: file.name, usage: extracted.usage };
}

export async function pickEnergySegment(
  audioPath: string,
  beats: number[],
  targetDurationS: number
): Promise<{ segmentStartS: number; segmentEndS: number; reasoning: string; geminiFileId: string; usage: any }> {
  const file = await uploadAndWait(audioPath, detectMimeType(audioPath, "audio"));
  const ai = client();

  const beatsMmss = beats.map(secondsToMmss);
  const prompt = `You are an expert DJ. Listen to this audio track.

You have been given a precise beat grid from signal processing (${beatsMmss.length} beats, already accurate). Timestamps are in MM:SS.mmm format (e.g. "01:23.456" means 1 minute 23.456 seconds into the track).

Your job is to identify the single best ~${targetDurationS} second segment for an action montage — the highest-energy passage (drop, chorus, climax).

Constraints:
- segmentStart and segmentEnd must EXACTLY match values from the provided beat grid — copy them verbatim, do not invent new timestamps
- Target duration ~${targetDurationS}s (can be slightly shorter/longer to land cleanly)

Full beat grid (${beatsMmss.length} beats):
${JSON.stringify(beatsMmss)}

Return the chosen segmentStart and segmentEnd in MM:SS.mmm format (copied verbatim from the grid above) plus brief reasoning.`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
      { text: prompt },
    ],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: segmentPickSchema,
      thinkingConfig: { includeThoughts: true },
    },
  });

  const extracted = extractResponse(response);
  const result = {
    segmentStartS: mmssToSeconds(extracted.segmentStart),
    segmentEndS: mmssToSeconds(extracted.segmentEnd),
    reasoning: extracted.reasoning,
  };
  await logGeminiCall("pick-energy-segment", prompt, extracted, result);
  return { ...result, geminiFileId: file.name, usage: extracted.usage };
}

export async function planEdit(
  beats: number[],
  segmentStartS: number,
  segmentEndS: number,
  moments: ActionMoment[],
  stylePrompt?: string
): Promise<{ clips: Array<{ videoStartS: number; videoEndS: number; momentDescription: string }>; usage: any }> {
  const ai = client();

  const segmentBeats = beats.filter((b) => b >= segmentStartS && b <= segmentEndS);
  const segmentBeatsMmss = segmentBeats.map(secondsToMmss);
  const momentsMmss = moments.map((m) => ({
    start: secondsToMmss(m.startS),
    end: secondsToMmss(m.endS),
    description: m.description,
    intensity: m.intensity,
  }));

  const styleSection = stylePrompt
    ? `\n\nSTYLE DIRECTION (override defaults where they conflict):\n${stylePrompt}\n`
    : "";

  const prompt = `You are a professional editor planning a beat-synced action montage.

All timestamps are in MM:SS.mmm format (e.g. "00:46.184" means 46.184 seconds into the source video/audio).

Beat grid for the chosen audio segment (${segmentBeatsMmss.length} beats, creates ${segmentBeatsMmss.length - 1} cut intervals):
${JSON.stringify(segmentBeatsMmss)}

Available video action moments (sorted by intensity):
${JSON.stringify(momentsMmss, null, 2)}
${styleSection}
Your task: for each consecutive pair of beats, choose a video clip. The clip's duration should match the beat interval. Set videoStart and videoEnd in MM:SS.mmm format.

Rules:
- Produce exactly ${segmentBeatsMmss.length - 1} clips
- videoEnd must be strictly greater than videoStart for every clip
- Higher-intensity moments should land on stronger beats (downbeats, drop moments)
- Prefer variety over repeating the same clip back-to-back
- You can take a sub-range of a moment (e.g. if the moment is 00:02.000-00:04.000 and the beat interval is 0.5s, pick 00:02.000-00:02.500 or 00:03.500-00:04.000)
- All timestamps in MM:SS.mmm format, copy beat values verbatim when they appear`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: editPlanSchema,
      thinkingConfig: { includeThoughts: true },
    },
  });

  const extracted = extractResponse(response);
  const clips = extracted.clips.map((c: any) => ({
    videoStartS: mmssToSeconds(c.videoStart),
    videoEndS: mmssToSeconds(c.videoEnd),
    momentDescription: c.momentDescription,
  }));
  await logGeminiCall("plan-edit", prompt, extracted, { clips });
  return { clips, usage: extracted.usage };
}

// --- Response extraction (thoughts + data) ---

function extractResponse(response: any): any {
  const thoughts: string[] = [];
  let answerText = "";
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (!part.text) continue;
    if (part.thought) thoughts.push(part.text);
    else answerText += part.text;
  }
  const data = JSON.parse(answerText);
  const um = response.usageMetadata || {};
  return {
    ...data,
    thoughts,
    usage: {
      promptTokens: um.promptTokenCount ?? 0,
      responseTokens: um.candidatesTokenCount ?? 0,
      thoughtsTokens: um.thoughtsTokenCount ?? 0,
      totalTokens: um.totalTokenCount ?? 0,
    },
  };
}
