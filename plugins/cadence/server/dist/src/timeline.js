/**
 * Shared mutable timeline — authoritative state for an edit.
 *
 * Clips are documents, not just geometry. Each carries Gemini's description,
 * reasoning, and optional anchor metadata (which frame aligns to which beat,
 * and how much buildup/resolution the moment needs). Validation runs on every
 * mutation and surfaces issues Claude can inspect and resolve before render.
 */
const TOLERANCE_S = 0.03; // 30ms rounding tolerance for adjacency / drift checks
let state = {
    clips: [],
    audio: null,
    issues: [],
    planThoughts: null,
    segmentBounds: null,
    version: 0,
};
let clipCounter = 0;
// --- Lifecycle ---
export function reset() {
    state = {
        clips: [],
        audio: null,
        issues: [],
        planThoughts: null,
        segmentBounds: null,
        version: state.version + 1,
    };
    clipCounter = 0;
    return state;
}
export function get() {
    return state;
}
export function toJSON() {
    return {
        version: state.version,
        audio: state.audio,
        clips: state.clips,
        issues: state.issues,
        planThoughts: state.planThoughts,
        segmentBounds: state.segmentBounds,
        totalDurationS: state.clips.reduce((max, c) => Math.max(max, c.positionS + c.durationS), 0),
    };
}
// --- Audio ---
export function setAudio(path, startS, durationS) {
    state.audio = { path, startS, durationS };
    state.version++;
    revalidate();
    return state.audio;
}
export function applyPlan(clips, opts) {
    if (opts.resetFirst)
        reset();
    if (opts.segmentBounds)
        state.segmentBounds = opts.segmentBounds;
    if (opts.planThoughts !== undefined)
        state.planThoughts = opts.planThoughts;
    const ids = [];
    for (const c of clips) {
        const id = `clip-${clipCounter++}`;
        ids.push(id);
        state.clips.push({
            id,
            source: { path: c.sourcePath, startS: c.sourceStartS, endS: c.sourceEndS },
            positionS: c.positionS,
            durationS: c.sourceEndS - c.sourceStartS,
            anchor: c.anchor,
            meta: {
                description: c.description,
                reasoning: c.reasoning,
                intensity: c.intensity,
                origin: opts.origin,
            },
        });
    }
    state.clips.sort((a, b) => a.positionS - b.positionS);
    state.version++;
    revalidate();
    return {
        clipIds: ids,
        issueCount: state.issues.length,
        errorCount: state.issues.filter((i) => i.severity === "error").length,
        warningCount: state.issues.filter((i) => i.severity === "warning").length,
    };
}
export function updateClip(id, patch) {
    const clip = state.clips.find((c) => c.id === id);
    if (!clip)
        throw new Error(`Clip not found: ${id}`);
    if (patch.sourceStartS !== undefined)
        clip.source.startS = patch.sourceStartS;
    if (patch.sourceEndS !== undefined)
        clip.source.endS = patch.sourceEndS;
    if (patch.positionS !== undefined)
        clip.positionS = patch.positionS;
    if (patch.anchor !== undefined)
        clip.anchor = patch.anchor ?? undefined;
    if (patch.description !== undefined)
        clip.meta.description = patch.description;
    if (patch.reasoning !== undefined)
        clip.meta.reasoning = patch.reasoning;
    clip.durationS = clip.source.endS - clip.source.startS;
    state.clips.sort((a, b) => a.positionS - b.positionS);
    state.version++;
    revalidate();
    return clip;
}
export function removeClip(id) {
    const before = state.clips.length;
    state.clips = state.clips.filter((c) => c.id !== id);
    if (state.clips.length === before)
        throw new Error(`Clip not found: ${id}`);
    state.version++;
    revalidate();
}
export function insertClip(input, origin = "manual") {
    if (input.sourceEndS <= input.sourceStartS) {
        throw new Error(`Clip has non-positive duration: sourceStartS=${input.sourceStartS}, sourceEndS=${input.sourceEndS}.`);
    }
    if (input.sourceStartS < 0) {
        throw new Error(`Clip sourceStartS must be non-negative, got ${input.sourceStartS}.`);
    }
    if (input.positionS < 0) {
        throw new Error(`Clip positionS must be non-negative, got ${input.positionS}.`);
    }
    const id = `clip-${clipCounter++}`;
    const clip = {
        id,
        source: { path: input.sourcePath, startS: input.sourceStartS, endS: input.sourceEndS },
        positionS: input.positionS,
        durationS: input.sourceEndS - input.sourceStartS,
        anchor: input.anchor,
        meta: {
            description: input.description,
            reasoning: input.reasoning,
            intensity: input.intensity,
            origin,
        },
    };
    state.clips.push(clip);
    state.clips.sort((a, b) => a.positionS - b.positionS);
    state.version++;
    revalidate();
    return clip;
}
// Backward-compat simple add (manual-path tool keeps a flat signature).
export function addClip(sourceUri, videoStart, videoEnd, position) {
    return insertClip({
        sourcePath: sourceUri,
        sourceStartS: videoStart,
        sourceEndS: videoEnd,
        positionS: position,
        description: "manually added",
    }, "manual");
}
// --- Inspection ---
export function listIssues() {
    return state.issues;
}
export function inspectClip(id) {
    const clip = state.clips.find((c) => c.id === id);
    if (!clip)
        throw new Error(`Clip not found: ${id}`);
    return clip;
}
export function hasErrors() {
    return state.issues.some((i) => i.severity === "error");
}
// --- Validation ---
function revalidate() {
    const issues = [];
    const clips = state.clips; // already sorted by positionS
    for (const c of clips) {
        if (c.source.startS < 0) {
            issues.push({
                type: "source-bounds",
                severity: "error",
                affectedClipIds: [c.id],
                message: `${c.id}: source.startS is negative (${c.source.startS.toFixed(3)}s)`,
            });
        }
        if (c.source.endS <= c.source.startS) {
            issues.push({
                type: "source-bounds",
                severity: "error",
                affectedClipIds: [c.id],
                message: `${c.id}: source.endS (${c.source.endS.toFixed(3)}) must exceed source.startS (${c.source.startS.toFixed(3)})`,
            });
        }
        if (c.positionS < 0) {
            issues.push({
                type: "out-of-segment",
                severity: "error",
                affectedClipIds: [c.id],
                message: `${c.id}: positionS is negative (${c.positionS.toFixed(3)}s)`,
            });
        }
        if (c.anchor) {
            const a = c.anchor;
            const anchorInBounds = a.sourceTimestampS >= c.source.startS - TOLERANCE_S &&
                a.sourceTimestampS <= c.source.endS + TOLERANCE_S;
            if (!anchorInBounds) {
                issues.push({
                    type: "source-bounds",
                    severity: "error",
                    affectedClipIds: [c.id],
                    message: `${c.id}: anchor.sourceTimestampS (${a.sourceTimestampS.toFixed(3)}) outside source [${c.source.startS.toFixed(3)}, ${c.source.endS.toFixed(3)}]`,
                });
            }
            const anchorOnTimeline = c.positionS + (a.sourceTimestampS - c.source.startS);
            const drift = anchorOnTimeline - a.beatS;
            if (Math.abs(drift) > TOLERANCE_S) {
                issues.push({
                    type: "anchor-drift",
                    severity: "warning",
                    affectedClipIds: [c.id],
                    message: `${c.id}: anchor lands at ${anchorOnTimeline.toFixed(3)}s on timeline, targetBeat is ${a.beatS.toFixed(3)}s (drift ${drift.toFixed(3)}s)`,
                    deltaS: drift,
                });
            }
        }
    }
    // Adjacent tile checks
    for (let i = 0; i < clips.length - 1; i++) {
        const a = clips[i];
        const b = clips[i + 1];
        const aEnd = a.positionS + a.durationS;
        const gap = b.positionS - aEnd;
        if (gap < -TOLERANCE_S) {
            issues.push({
                type: "overlap",
                severity: "error",
                affectedClipIds: [a.id, b.id],
                message: `${a.id} ends at ${aEnd.toFixed(3)}s, ${b.id} starts at ${b.positionS.toFixed(3)}s — overlap ${(-gap).toFixed(3)}s`,
                deltaS: -gap,
            });
        }
        else if (gap > TOLERANCE_S) {
            issues.push({
                type: "gap",
                severity: "warning",
                affectedClipIds: [a.id, b.id],
                message: `${a.id} ends at ${aEnd.toFixed(3)}s, ${b.id} starts at ${b.positionS.toFixed(3)}s — gap ${gap.toFixed(3)}s`,
                deltaS: gap,
            });
        }
    }
    // Segment-bounds checks
    if (state.segmentBounds && clips.length > 0) {
        const expectedDuration = state.segmentBounds.endS - state.segmentBounds.startS;
        const first = clips[0];
        const last = clips[clips.length - 1];
        const lastEnd = last.positionS + last.durationS;
        if (first.positionS > TOLERANCE_S) {
            issues.push({
                type: "out-of-segment",
                severity: "error",
                affectedClipIds: [first.id],
                message: `${first.id}: first clip starts at ${first.positionS.toFixed(3)}s, not 0 (segment origin)`,
                deltaS: first.positionS,
            });
        }
        if (Math.abs(lastEnd - expectedDuration) > TOLERANCE_S) {
            issues.push({
                type: "out-of-segment",
                severity: "warning",
                affectedClipIds: [last.id],
                message: `timeline duration ${lastEnd.toFixed(3)}s doesn't match segment duration ${expectedDuration.toFixed(3)}s`,
                deltaS: lastEnd - expectedDuration,
            });
        }
    }
    state.issues = issues;
}
//# sourceMappingURL=timeline.js.map