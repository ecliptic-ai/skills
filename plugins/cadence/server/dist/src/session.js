/**
 * Gemini edit session — persistent chat + explicit content cache for one project.
 *
 * The session holds the user's intent, uploaded files, and growing conversation
 * history across reason-* tool calls. Subsequent turns reference an explicit
 * cache (system instruction + files) so the large stable prefix bills at the
 * Gemini caching discount rather than being re-sent each turn.
 *
 * One active session at a time, module-level. Turns are serialized via a
 * promise chain so concurrent sendTurn calls don't race on the same history.
 */
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { client, detectMimeType, uploadAndWait } from "./files.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CACHE_DIR || resolve(__dirname, "../.mcp-cache");
const SESSION_DIR = resolve(CACHE_DIR, "sessions");
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const GEMINI_CACHE_TTL = process.env.GEMINI_CACHE_TTL || "3600s"; // 1h default
let active = null;
let turnLock = Promise.resolve();
// --- Begin / end ---
export async function beginSession(project) {
    if (active)
        await endSession();
    const videoMime = detectMimeType(project.videoPath, "video");
    const audioMime = detectMimeType(project.audioPath, "audio");
    const [video, audio] = await Promise.all([
        uploadAndWait(project.videoPath, videoMime),
        uploadAndWait(project.audioPath, audioMime),
    ]);
    const id = `session-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const systemInstruction = buildSystemInstruction(project);
    let cacheName;
    try {
        const ai = client();
        const cache = await ai.caches.create({
            model: GEMINI_MODEL,
            config: {
                systemInstruction,
                contents: [
                    {
                        role: "user",
                        parts: [
                            { fileData: { fileUri: video.uri, mimeType: video.mimeType } },
                            { fileData: { fileUri: audio.uri, mimeType: audio.mimeType } },
                        ],
                    },
                ],
                ttl: GEMINI_CACHE_TTL,
            },
        });
        cacheName = cache.name ?? undefined;
    }
    catch (e) {
        // Cache creation can fail if content is below the minimum-token threshold
        // (1024 for Flash). The session still works without cache — just pricier.
        console.error(`cadence: Gemini cache creation failed (proceeding without): ${e instanceof Error ? e.message : String(e)}`);
    }
    active = {
        id,
        project,
        files: { video, audio },
        cacheName,
        history: [],
        artifacts: {},
        createdAt: Date.now(),
    };
    await persistSession(active);
    return active;
}
export async function endSession() {
    if (!active)
        return { closedSessionId: null };
    const closed = active.id;
    if (active.cacheName) {
        try {
            await client().caches.delete({ name: active.cacheName });
        }
        catch {
            // Best-effort. Cache may have TTL-expired.
        }
    }
    active = null;
    turnLock = Promise.resolve();
    return { closedSessionId: closed };
}
export function getActiveSession() {
    if (!active) {
        throw new Error("No active edit session. Call `session-begin` with videoPath, audioPath, and userIntent first.");
    }
    return active;
}
export function hasActiveSession() {
    return active !== null;
}
export function sessionStatus() {
    if (!active)
        return { active: false };
    return {
        active: true,
        id: active.id,
        project: active.project,
        cachedContentEnabled: !!active.cacheName,
        turnCount: Math.floor(active.history.length / 2),
        artifacts: {
            hasMoments: !!active.artifacts.moments,
            momentCount: active.artifacts.moments?.length,
            hasSegment: !!active.artifacts.segment,
            segment: active.artifacts.segment,
        },
        createdAt: new Date(active.createdAt).toISOString(),
    };
}
export async function sendTurn(message, config = {}) {
    const session = getActiveSession();
    const next = turnLock.then(async () => {
        const ai = client();
        const userContent = { role: "user", parts: [{ text: message }] };
        const contents = [...session.history, userContent];
        const request = {
            model: GEMINI_MODEL,
            contents,
            config: {
                thinkingConfig: { includeThoughts: config.includeThoughts ?? true },
            },
        };
        if (config.responseJsonSchema) {
            request.config.responseMimeType = "application/json";
            request.config.responseJsonSchema = config.responseJsonSchema;
        }
        if (session.cacheName) {
            request.config.cachedContent = session.cacheName;
        }
        const response = await ai.models.generateContent(request);
        const thoughts = [];
        let answerText = "";
        const parts = response.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
            if (!part.text)
                continue;
            if (part.thought)
                thoughts.push(part.text);
            else
                answerText += part.text;
        }
        session.history.push(userContent);
        session.history.push({ role: "model", parts: [{ text: answerText }] });
        const um = response.usageMetadata || {};
        const usage = {
            promptTokens: um.promptTokenCount ?? 0,
            responseTokens: um.candidatesTokenCount ?? 0,
            thoughtsTokens: um.thoughtsTokenCount ?? 0,
            cachedTokens: um.cachedContentTokenCount ?? 0,
            totalTokens: um.totalTokenCount ?? 0,
        };
        await persistSession(session);
        return { text: answerText, thoughts, usage };
    });
    turnLock = next.catch(() => { }); // keep chain alive even on error
    return next;
}
// --- Artifact storage helpers (callable from reason.ts) ---
export function storeMoments(moments) {
    getActiveSession().artifacts.moments = moments;
}
export function storeSegment(segment) {
    getActiveSession().artifacts.segment = segment;
}
// --- Persistence ---
async function persistSession(session) {
    if (!existsSync(SESSION_DIR))
        mkdirSync(SESSION_DIR, { recursive: true });
    const path = resolve(SESSION_DIR, `${session.id}.json`);
    await writeFile(path, JSON.stringify({
        id: session.id,
        project: session.project,
        files: session.files,
        cacheName: session.cacheName,
        artifacts: session.artifacts,
        historyLength: session.history.length,
        createdAt: session.createdAt,
    }, null, 2));
}
function buildSystemInstruction(project) {
    return `You are the editor working on a beat-synced video montage.

PROJECT
- Video: ${project.videoPath}
- Audio: ${project.audioPath}
- User's creative intent: ${project.userIntent}

Over the course of this edit you will be called multiple times — to analyze the video for striking moments, to pick the best audio segment, and to plan clip placement. Your prior answers are available as conversation history. Keep decisions coherent with the user's intent and with your own earlier choices.

When scoring visual moments, the user's intent is the PRIMARY scoring axis — not generic visual intensity. A wide-shot explosion may be visually striking but irrelevant if the user asked for hand-to-hand combat; score it low.

Always return JSON matching the provided schema. Put reasoning into the schema's reasoning/description fields; do not prose outside of JSON.`;
}
//# sourceMappingURL=session.js.map