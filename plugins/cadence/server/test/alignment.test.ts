/**
 * Integration test: verifies anchor frames in the rendered output match the
 * source video's frame at the declared anchorTimestamp.
 *
 * Runs against three fixtures, set via env vars:
 *   CADENCE_TEST_PLAN_LOG  — path to a plan-edit log JSON
 *   CADENCE_TEST_VIDEO     — path to the source video (the one the plan was built from)
 *   CADENCE_TEST_OUTPUT    — path to the rendered montage MP4
 *
 * Self-skips if any fixture is missing. Run with:
 *   CADENCE_TEST_PLAN_LOG=... CADENCE_TEST_VIDEO=... CADENCE_TEST_OUTPUT=... npm test
 */
import { describe, it, expect } from "vitest";
import { execa } from "execa";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG_PATH = process.env.CADENCE_TEST_PLAN_LOG;
const VIDEO_PATH = process.env.CADENCE_TEST_VIDEO;
const OUTPUT_PATH = process.env.CADENCE_TEST_OUTPUT;

const fixturesReady =
  !!LOG_PATH &&
  !!VIDEO_PATH &&
  !!OUTPUT_PATH &&
  existsSync(LOG_PATH) &&
  existsSync(VIDEO_PATH) &&
  existsSync(OUTPUT_PATH);

const SSIM_THRESHOLD = 0.85; // anime re-encoded at libx264/fast; pretty lossy but clips should still be visibly identical

function mmssToSeconds(ts: string): number {
  const parts = ts.trim().split(":");
  if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  if (parts.length === 3)
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  throw new Error(`bad MM:SS timestamp: ${ts}`);
}

function parseSegmentStart(prompt: string): number {
  const m = prompt.match(/Segment bounds:\s*(\d+:\d+\.\d+)\s*→/);
  if (!m) throw new Error("could not find 'Segment bounds:' in plan-edit prompt");
  return mmssToSeconds(m[1]);
}

async function extractFrame(videoPath: string, timestampS: number, outPath: string): Promise<void> {
  // -ss AFTER -i = frame-accurate decode-then-seek
  await execa("ffmpeg", [
    "-v", "error",
    "-y",
    "-i", videoPath,
    "-ss", timestampS.toFixed(3),
    "-frames:v", "1",
    outPath,
  ]);
}

async function computeSSIM(refPath: string, testPath: string): Promise<number> {
  const { stderr } = await execa(
    "ffmpeg",
    ["-v", "info", "-i", refPath, "-i", testPath, "-lavfi", "ssim=-", "-f", "null", "-"],
    { reject: false },
  );
  const m = stderr.match(/All:(\d+\.\d+)/);
  if (!m) throw new Error(`could not parse SSIM from ffmpeg stderr:\n${stderr}`);
  return parseFloat(m[1]);
}

describe.skipIf(!fixturesReady)("anchor-frame alignment on rendered output", async () => {
  const log = fixturesReady ? JSON.parse(await readFile(LOG_PATH!, "utf8")) : null;
  const clips: any[] = log?.result?.rawClips ?? [];
  const segmentStartS = log ? parseSegmentStart(log.prompt) : 0;
  const workDir = mkdtempSync(join(tmpdir(), "cadence-align-"));

  it("has at least one clip", () => {
    expect(clips.length).toBeGreaterThan(0);
  });

  for (const [i, clip] of clips.entries()) {
    it(`clip ${i}: ${String(clip.description).slice(0, 60)}`, async () => {
      const anchorSrcS = mmssToSeconds(clip.anchorTimestamp);
      const targetBeatAbsS = mmssToSeconds(clip.targetBeat);
      const beatOnTimelineS = targetBeatAbsS - segmentStartS;

      // Probe slightly past each position so ffmpeg seek lands squarely inside
      // the clip (not on the prior-clip boundary).
      const probeOffset = 0.05;
      const timelineProbeS = beatOnTimelineS + probeOffset;
      const sourceProbeS = anchorSrcS + probeOffset;

      const outFrame = join(workDir, `out-${i}.png`);
      const srcFrame = join(workDir, `src-${i}.png`);
      await Promise.all([
        extractFrame(OUTPUT_PATH!, timelineProbeS, outFrame),
        extractFrame(VIDEO_PATH!, sourceProbeS, srcFrame),
      ]);

      const ssim = await computeSSIM(srcFrame, outFrame);
      expect(
        ssim,
        `clip ${i} anchor drift: expected SSIM >= ${SSIM_THRESHOLD}, got ${ssim.toFixed(4)}. ` +
          `timelineProbeS=${timelineProbeS.toFixed(3)} sourceProbeS=${sourceProbeS.toFixed(3)} desc=${clip.description}`,
      ).toBeGreaterThanOrEqual(SSIM_THRESHOLD);
    });
  }

  // vitest calls afterAll via test hooks, but we're inside an async describe so
  // use a normal cleanup test at the tail.
  it("cleanup", () => {
    rmSync(workDir, { recursive: true, force: true });
  });
});
