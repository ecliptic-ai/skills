/**
 * Shared mutable timeline — authoritative state for an edit.
 *
 * Clips are documents, not just geometry. Each carries Gemini's description,
 * reasoning, and optional anchor metadata (which frame aligns to which beat,
 * and how much buildup/resolution the moment needs). Validation runs on every
 * mutation and surfaces issues Claude can inspect and resolve before render.
 */

export type ClipSource = {
  path: string;
  startS: number;
  endS: number;
};

export type ClipAnchor = {
  sourceTimestampS: number; // beat-sync frame, in source-video time
  beatS: number;            // timeline time where the anchor should land
  buildupS: number;         // source seconds before the anchor
  resolutionS: number;      // source seconds after the anchor
};

export type ClipMeta = {
  description: string;
  reasoning?: string;
  intensity?: number;
  origin: string;           // which plan call or manual op produced this clip
};

export type TimelineClip = {
  id: string;
  source: ClipSource;
  positionS: number;        // on the output timeline
  durationS: number;        // cached: source.endS - source.startS
  anchor?: ClipAnchor;
  meta: ClipMeta;
};

export type AudioTrack = {
  path: string;
  startS: number;           // offset in source audio
  durationS: number;
};

export type IssueType =
  | "overlap"
  | "gap"
  | "anchor-drift"
  | "source-bounds"
  | "out-of-segment";

export type IssueSeverity = "error" | "warning";

export type Issue = {
  type: IssueType;
  severity: IssueSeverity;
  affectedClipIds: string[];
  message: string;
  deltaS?: number;
};

export type SegmentBounds = { startS: number; endS: number };

export type TimelineState = {
  clips: TimelineClip[];
  audio: AudioTrack | null;
  issues: Issue[];
  planThoughts: string | null;
  segmentBounds: SegmentBounds | null;
  version: number;
};

const TOLERANCE_S = 0.03; // 30ms rounding tolerance for adjacency / drift checks

let state: TimelineState = {
  clips: [],
  audio: null,
  issues: [],
  planThoughts: null,
  segmentBounds: null,
  version: 0,
};
let clipCounter = 0;

// --- Lifecycle ---

export function reset(): TimelineState {
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

export function get(): TimelineState {
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
    totalDurationS: state.clips.reduce(
      (max, c) => Math.max(max, c.positionS + c.durationS),
      0,
    ),
  };
}

// --- Audio ---

export function setAudio(path: string, startS: number, durationS: number): AudioTrack {
  state.audio = { path, startS, durationS };
  state.version++;
  revalidate();
  return state.audio;
}

// --- Plan application (bulk) ---

export type PlanClipInput = {
  sourcePath: string;
  sourceStartS: number;
  sourceEndS: number;
  positionS: number;
  anchor?: ClipAnchor;
  description: string;
  reasoning?: string;
  intensity?: number;
};

export type ApplyPlanOptions = {
  origin: string;
  planThoughts?: string;
  segmentBounds?: SegmentBounds;
  resetFirst?: boolean;
};

export type ApplyPlanResult = {
  clipIds: string[];
  issueCount: number;
  errorCount: number;
  warningCount: number;
};

export function applyPlan(clips: PlanClipInput[], opts: ApplyPlanOptions): ApplyPlanResult {
  if (opts.resetFirst) reset();
  if (opts.segmentBounds) state.segmentBounds = opts.segmentBounds;
  if (opts.planThoughts !== undefined) state.planThoughts = opts.planThoughts;

  const ids: string[] = [];
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

// --- Clip-level mutators ---

export type ClipPatch = {
  sourceStartS?: number;
  sourceEndS?: number;
  positionS?: number;
  anchor?: ClipAnchor | null;
  description?: string;
  reasoning?: string;
};

export function updateClip(id: string, patch: ClipPatch): TimelineClip {
  const clip = state.clips.find((c) => c.id === id);
  if (!clip) throw new Error(`Clip not found: ${id}`);
  if (patch.sourceStartS !== undefined) clip.source.startS = patch.sourceStartS;
  if (patch.sourceEndS !== undefined) clip.source.endS = patch.sourceEndS;
  if (patch.positionS !== undefined) clip.positionS = patch.positionS;
  if (patch.anchor !== undefined) clip.anchor = patch.anchor ?? undefined;
  if (patch.description !== undefined) clip.meta.description = patch.description;
  if (patch.reasoning !== undefined) clip.meta.reasoning = patch.reasoning;
  clip.durationS = clip.source.endS - clip.source.startS;
  state.clips.sort((a, b) => a.positionS - b.positionS);
  state.version++;
  revalidate();
  return clip;
}

export function removeClip(id: string): void {
  const before = state.clips.length;
  state.clips = state.clips.filter((c) => c.id !== id);
  if (state.clips.length === before) throw new Error(`Clip not found: ${id}`);
  state.version++;
  revalidate();
}

export function insertClip(input: PlanClipInput, origin = "manual"): TimelineClip {
  if (input.sourceEndS <= input.sourceStartS) {
    throw new Error(
      `Clip has non-positive duration: sourceStartS=${input.sourceStartS}, sourceEndS=${input.sourceEndS}.`,
    );
  }
  if (input.sourceStartS < 0) {
    throw new Error(`Clip sourceStartS must be non-negative, got ${input.sourceStartS}.`);
  }
  if (input.positionS < 0) {
    throw new Error(`Clip positionS must be non-negative, got ${input.positionS}.`);
  }

  const id = `clip-${clipCounter++}`;
  const clip: TimelineClip = {
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
export function addClip(
  sourceUri: string,
  videoStart: number,
  videoEnd: number,
  position: number,
): TimelineClip {
  return insertClip(
    {
      sourcePath: sourceUri,
      sourceStartS: videoStart,
      sourceEndS: videoEnd,
      positionS: position,
      description: "manually added",
    },
    "manual",
  );
}

// --- Inspection ---

export function listIssues(): Issue[] {
  return state.issues;
}

export function inspectClip(id: string): TimelineClip {
  const clip = state.clips.find((c) => c.id === id);
  if (!clip) throw new Error(`Clip not found: ${id}`);
  return clip;
}

export function hasErrors(): boolean {
  return state.issues.some((i) => i.severity === "error");
}

// --- Validation ---

function revalidate(): void {
  const issues: Issue[] = [];
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
      const anchorInBounds =
        a.sourceTimestampS >= c.source.startS - TOLERANCE_S &&
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
    } else if (gap > TOLERANCE_S) {
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
