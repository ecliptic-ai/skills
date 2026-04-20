/**
 * Renderer — turns the timeline into a video file via ffmpeg.
 */
import { execa } from "execa";
import { stat } from "node:fs/promises";

import type { TimelineState } from "../timeline.js";

export type RenderResult = {
  outputPath: string;
  outputBytes: number;
  clipCount: number;
  durationS: number;
  warnings: string[];
};

// Patterns for warnings we know are benign in our use case and should be
// filtered out to reduce noise in the tool response.
const BENIGN_WARNING_PATTERNS: RegExp[] = [
  /\d+ buffers queued in out_/i, // "N buffers queued, something may be wrong" — queue depth chatter on large filter graphs
];

function parseFfmpegWarnings(stderr: string): string[] {
  // ffmpeg mixes \r (progress overwrite) and \n (new message). Split on both.
  const lines = stderr.split(/[\r\n]+/);
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (BENIGN_WARNING_PATTERNS.some((p) => p.test(line))) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    warnings.push(line);
  }
  return warnings;
}

export async function renderFinal(timeline: TimelineState, outputPath: string): Promise<RenderResult> {
  if (timeline.clips.length === 0) throw new Error("Timeline has no clips");
  if (!timeline.audio) throw new Error("Timeline has no audio track");

  const sourceUri = timeline.clips[0].sourceUri;
  const sameSource = timeline.clips.every((c) => c.sourceUri === sourceUri);
  if (!sameSource) {
    throw new Error("Multi-source rendering not yet supported; all clips must share a source");
  }

  const filters: string[] = [];
  const concatInputs: string[] = [];
  for (const [i, clip] of timeline.clips.entries()) {
    filters.push(
      `[0:v]trim=start=${clip.videoStart.toFixed(3)}:end=${clip.videoEnd.toFixed(3)},` +
        `setpts=PTS-STARTPTS,format=yuv420p[v${i}]`
    );
    concatInputs.push(`[v${i}]`);
  }
  filters.push(`${concatInputs.join("")}concat=n=${timeline.clips.length}:v=1:a=0[outv]`);

  const cmd = [
    // Keep ffmpeg's stderr lean: no banner, no per-frame progress, warnings+errors only.
    "-hide_banner",
    "-nostats",
    "-loglevel", "warning",
    "-y",
    "-i", sourceUri,
    "-ss", timeline.audio.start.toFixed(3),
    "-to", (timeline.audio.start + timeline.audio.duration).toFixed(3),
    "-i", timeline.audio.sourceUri,
    "-filter_complex", filters.join(";"),
    "-map", "[outv]",
    "-map", "1:a",
    "-c:v", "libx264",
    "-preset", "fast",
    "-c:a", "aac",
    "-shortest",
    outputPath,
  ];

  const result = await execa("ffmpeg", cmd, { reject: true });
  const { size } = await stat(outputPath);

  return {
    outputPath,
    outputBytes: size,
    clipCount: timeline.clips.length,
    // Authoritative duration from the timeline (don't parse from ffmpeg's progress output).
    durationS: timeline.audio.duration,
    warnings: parseFfmpegWarnings(result.stderr ?? ""),
  };
}
