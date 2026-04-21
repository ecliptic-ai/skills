/**
 * Reasoning sensors — AI-based perception via Gemini.
 *
 * All reason-* calls run inside an active edit session (see ../session.ts).
 * The session carries the user's intent, uploaded files, and conversation
 * history; each call here issues one turn to Gemini and parses the JSON
 * response. findActionMoments / pickEnergySegment store their outputs in the
 * session's artifacts so downstream calls (planEdit) can retrieve them.
 *
 * planEdit additionally applies the resulting clips to the shared timeline
 * (see ../timeline.ts) and returns only a summary. The old model of returning
 * N clips for Claude to manually re-issue timeline-add-clip calls is gone.
 */
import { Type } from "@google/genai";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getActiveSession, sendTurn, storeMoments, storeSegment } from "../session.js";
import { applyPlan, setAudio } from "../timeline.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.CACHE_DIR || resolve(__dirname, "../../.mcp-cache");
const LOGS_DIR = resolve(CACHE_DIR, "logs");
// --- Timestamp conversion at the Gemini boundary ---
function secondsToMmss(s) {
    if (s < 0)
        throw new Error(`Cannot convert negative seconds to MM:SS: ${s}`);
    const totalMs = Math.round(s * 1000);
    const mm = Math.floor(totalMs / 60000);
    const remMs = totalMs - mm * 60000;
    const ss = Math.floor(remMs / 1000);
    const ms = remMs - ss * 1000;
    return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}
function mmssToSeconds(ts) {
    const parts = ts.trim().split(":");
    if (parts.length === 2)
        return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    if (parts.length === 3)
        return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
    throw new Error(`Timestamp must be MM:SS.mmm or HH:MM:SS.mmm, got: ${ts}`);
}
// --- Per-call logging (disk) ---
async function logTurn(tool, prompt, thoughts, usage, result) {
    try {
        await mkdir(LOGS_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const path = resolve(LOGS_DIR, `${ts}-${tool}.json`);
        await writeFile(path, JSON.stringify({ ts, tool, prompt, thoughts, usage, result }, null, 2));
    }
    catch {
        // swallow — logging is best-effort
    }
}
// --- Schemas (Gemini-facing; timestamps as MM:SS.mmm strings) ---
const actionMomentsSchema = {
    type: Type.OBJECT,
    properties: {
        moments: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    start: { type: Type.STRING, description: "MM:SS.mmm start" },
                    end: { type: Type.STRING, description: "MM:SS.mmm end" },
                    description: { type: Type.STRING, description: "Brief description of the moment" },
                    intensity: {
                        type: Type.NUMBER,
                        description: "Score 0-10 reflecting fit to the USER'S intent, not generic visual impact",
                    },
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
        segmentStart: { type: Type.STRING, description: "MM:SS.mmm, must appear in the provided beat grid" },
        segmentEnd: { type: Type.STRING, description: "MM:SS.mmm, must appear in the provided beat grid" },
        reasoning: { type: Type.STRING, description: "Brief explanation tying the pick to user intent and video content" },
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
                    anchorTimestamp: {
                        type: Type.STRING,
                        description: "MM:SS.mmm — the key frame in source video (e.g. the impact frame). For continuous moments with no single hit, use the clip's start or end.",
                    },
                    buildupS: {
                        type: Type.NUMBER,
                        description: "Seconds of source BEFORE the anchor. Must be >= 0. For clips that start on their anchor, use 0.",
                    },
                    resolutionS: {
                        type: Type.NUMBER,
                        description: "Seconds of source AFTER the anchor. Must be >= 0. For clips that end on their anchor, use 0.",
                    },
                    targetBeat: {
                        type: Type.STRING,
                        description: "MM:SS.mmm beat (copied verbatim from the provided segment beat grid) where the anchor frame should land on the output timeline",
                    },
                    description: { type: Type.STRING, description: "What this clip shows" },
                    reasoning: {
                        type: Type.STRING,
                        description: "Short rationale for THIS clip: why this source range, why this anchor, why this target beat",
                    },
                    intensity: {
                        type: Type.NUMBER,
                        description: "Intensity score carried from the source moment, 0-10",
                    },
                },
                required: ["anchorTimestamp", "buildupS", "resolutionS", "targetBeat", "description", "reasoning"],
            },
        },
    },
    required: ["clips"],
};
// --- Sensor implementations ---
export async function findActionMoments(fps = 5, focusPrompt) {
    const session = getActiveSession();
    const focusSection = focusPrompt
        ? `\n\nFOCUS — narrow selection to match this; exclude moments that don't fit (even if visually striking in isolation):\n${focusPrompt}`
        : "";
    const message = `Find every striking moment in the video that fits the user's creative intent.

Watch the whole video (sampling at ${fps} fps) and identify visually striking moments.

Scoring axis: intensity 0-10 as the fit to the user's intent — not generic visual impact. A wide-shot jutsu is intensity 2 if the user wants hand-to-hand, even if it would be intensity 10 for a general montage.

For each moment provide:
- start, end: MM:SS.mmm with millisecond precision (land on specific impact frames)
- description: brief
- intensity: 0-10, fit-to-intent${focusSection}

Spread moments across the video. Return them sorted by intensity (highest first).`;
    const { text, thoughts, usage } = await sendTurn(message, {
        responseJsonSchema: actionMomentsSchema,
    });
    const parsed = JSON.parse(text);
    const moments = parsed.moments.map((m) => ({
        startS: mmssToSeconds(m.start),
        endS: mmssToSeconds(m.end),
        description: m.description,
        intensity: m.intensity,
    }));
    storeMoments(moments);
    await logTurn("find-action-moments", message, thoughts, usage, { moments });
    return {
        momentCount: moments.length,
        highestIntensity: moments.reduce((m, x) => Math.max(m, x.intensity), 0),
        usage,
    };
}
export async function pickEnergySegment(beats, targetDurationS, focusPrompt) {
    const beatsMmss = beats.map(secondsToMmss);
    const focusSection = focusPrompt
        ? `\n\nSEGMENT PREFERENCE (apply this structural hint):\n${focusPrompt}`
        : "";
    const message = `Pick the best ~${targetDurationS}s audio segment for this montage.

Beat grid (${beatsMmss.length} beats, MM:SS.mmm):
${JSON.stringify(beatsMmss)}

Choose:
- segmentStart and segmentEnd both copied VERBATIM from the grid above
- The highest-energy passage that suits the user's intent (drop, chorus, climax)
- Target duration ~${targetDurationS}s; small deviations okay for structural fit${focusSection}`;
    const { text, thoughts, usage } = await sendTurn(message, {
        responseJsonSchema: segmentPickSchema,
    });
    const parsed = JSON.parse(text);
    const segment = {
        segmentStartS: mmssToSeconds(parsed.segmentStart),
        segmentEndS: mmssToSeconds(parsed.segmentEnd),
        reasoning: parsed.reasoning,
    };
    storeSegment(segment);
    await logTurn("pick-energy-segment", message, thoughts, usage, segment);
    return { ...segment, usage };
}
export async function planEdit(beats, stylePrompt) {
    const session = getActiveSession();
    const moments = session.artifacts.moments;
    const segment = session.artifacts.segment;
    if (!moments) {
        throw new Error("No action moments stored on session. Call reason-find-action-moments before reason-plan-edit.");
    }
    if (!segment) {
        throw new Error("No segment picked on session. Call reason-pick-energy-segment before reason-plan-edit.");
    }
    const segmentBeats = beats.filter((b) => b >= segment.segmentStartS - 1e-6 && b <= segment.segmentEndS + 1e-6);
    if (segmentBeats.length < 2) {
        throw new Error(`Not enough beats in segment [${segment.segmentStartS}, ${segment.segmentEndS}]: got ${segmentBeats.length}`);
    }
    const segmentBeatsMmss = segmentBeats.map(secondsToMmss);
    const momentsForGemini = moments.map((m) => ({
        start: secondsToMmss(m.startS),
        end: secondsToMmss(m.endS),
        description: m.description,
        intensity: m.intensity,
    }));
    const styleSection = stylePrompt
        ? `\n\nSTYLE DIRECTION (applies to how clips are arranged; overrides defaults where they conflict):\n${stylePrompt}`
        : "";
    const message = `Plan the montage for the chosen segment.

Beat grid for segment (${segmentBeatsMmss.length} beats, MM:SS.mmm — these are absolute audio timestamps):
${JSON.stringify(segmentBeatsMmss)}

Segment bounds: ${secondsToMmss(segment.segmentStartS)} → ${secondsToMmss(segment.segmentEndS)}.

Available video moments (previously identified; intensity reflects fit to user intent):
${JSON.stringify(momentsForGemini, null, 2)}
${styleSection}

For each clip output:
- anchorTimestamp: MM:SS.mmm of the impact/key frame in the source video
- buildupS, resolutionS: source seconds needed before/after the anchor for the moment to read (0 is allowed if the clip starts or ends on its anchor)
- targetBeat: MM:SS.mmm from the segment beat grid above, copied verbatim — the timeline beat where the anchor lands
- description, reasoning: short
- intensity: 0-10 carried from the source moment

Constraints:
- Clips must tile the segment: cumulative (buildupS + resolutionS) across clips in order must equal (segmentEnd - segmentStart). Adjacent clips share no overlap and leave no gap.
- The first clip's buildupS must not extend before the segment start.
- The last clip's resolutionS must not extend beyond the segment end.
- Not every beat has to be a cut. A clip can span multiple beat intervals if the moment benefits from holding — e.g. an explosion clip might anchor on one beat and cover several.
- Higher-intensity (fit-to-intent) moments should anchor on stronger beats.`;
    const { text, thoughts, usage } = await sendTurn(message, {
        responseJsonSchema: editPlanSchema,
    });
    const parsed = JSON.parse(text);
    // Convert Gemini's MM:SS strings to seconds and compute positions.
    // targetBeat is an absolute audio timestamp; convert to timeline time by subtracting segmentStart.
    const planClips = parsed.clips.map((c, idx) => {
        const anchorS = mmssToSeconds(c.anchorTimestamp);
        const beatAbsS = mmssToSeconds(c.targetBeat);
        const beatOnTimelineS = beatAbsS - segment.segmentStartS;
        const positionS = beatOnTimelineS - c.buildupS;
        return {
            sourcePath: session.project.videoPath,
            sourceStartS: anchorS - c.buildupS,
            sourceEndS: anchorS + c.resolutionS,
            positionS,
            anchor: {
                sourceTimestampS: anchorS,
                beatS: beatOnTimelineS,
                buildupS: c.buildupS,
                resolutionS: c.resolutionS,
            },
            description: c.description,
            reasoning: c.reasoning,
            intensity: c.intensity,
        };
    });
    const origin = `reason-plan-edit:${new Date().toISOString()}`;
    const planThoughts = thoughts.join("\n\n---\n\n");
    const applyResult = applyPlan(planClips, {
        origin,
        planThoughts,
        segmentBounds: { startS: segment.segmentStartS, endS: segment.segmentEndS },
        resetFirst: true,
    });
    // applyPlan's resetFirst wipes the audio track too. Restore it here so the
    // caller never needs to call timeline-set-audio manually after plan-edit.
    setAudio(session.project.audioPath, segment.segmentStartS, segment.segmentEndS - segment.segmentStartS);
    await logTurn("plan-edit", message, thoughts, usage, {
        rawClips: parsed.clips,
        appliedClips: planClips.length,
        issues: applyResult,
    });
    return {
        clipCount: planClips.length,
        issueCount: applyResult.issueCount,
        errorCount: applyResult.errorCount,
        warningCount: applyResult.warningCount,
        clipIds: applyResult.clipIds,
        segmentBounds: { startS: segment.segmentStartS, endS: segment.segmentEndS },
        totalGeminiTokens: usage.totalTokens,
    };
}
// --- Re-exports for the gemini-* management tools ---
export { listUploadedFiles, deleteUploadedFile, purgeOrphans } from "../files.js";
//# sourceMappingURL=reason.js.map