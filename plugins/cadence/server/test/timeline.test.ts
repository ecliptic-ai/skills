/**
 * Unit tests for the timeline state machine.
 *
 * The timeline module is module-level singleton state (intentional — there's
 * one active timeline per server). We reset() between tests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  reset,
  applyPlan,
  updateClip,
  removeClip,
  insertClip,
  setAudio,
  listIssues,
  inspectClip,
  hasErrors,
  get,
  type PlanClipInput,
} from "../src/timeline.js";

const SRC = "/tmp/fake-video.mp4";

function mkClip(partial: Partial<PlanClipInput> & Pick<PlanClipInput, "positionS" | "sourceStartS" | "sourceEndS">): PlanClipInput {
  return {
    sourcePath: SRC,
    description: "test",
    ...partial,
  };
}

describe("applyPlan positioning", () => {
  beforeEach(() => reset());

  it("applies clips in positionS order and assigns sequential IDs", () => {
    const result = applyPlan(
      [
        mkClip({ positionS: 2.0, sourceStartS: 10, sourceEndS: 11 }),
        mkClip({ positionS: 0.0, sourceStartS: 0, sourceEndS: 2 }),
        mkClip({ positionS: 3.0, sourceStartS: 20, sourceEndS: 21 }),
      ],
      { origin: "test", resetFirst: true },
    );

    expect(result.clipIds).toHaveLength(3);
    const clips = get().clips;
    // Sorted by positionS
    expect(clips.map((c) => c.positionS)).toEqual([0, 2, 3]);
  });

  it("computes durationS from source range", () => {
    applyPlan(
      [mkClip({ positionS: 0, sourceStartS: 5, sourceEndS: 7.5 })],
      { origin: "test", resetFirst: true },
    );
    expect(get().clips[0].durationS).toBeCloseTo(2.5);
  });

  it("stores origin + planThoughts + segmentBounds", () => {
    applyPlan(
      [mkClip({ positionS: 0, sourceStartS: 0, sourceEndS: 10 })],
      {
        origin: "plan-edit:abc",
        planThoughts: "I thought about it.",
        segmentBounds: { startS: 60, endS: 70 },
        resetFirst: true,
      },
    );
    const s = get();
    expect(s.clips[0].meta.origin).toBe("plan-edit:abc");
    expect(s.planThoughts).toBe("I thought about it.");
    expect(s.segmentBounds).toEqual({ startS: 60, endS: 70 });
  });

  it("tiles cleanly with zero issues when clips are adjacent", () => {
    applyPlan(
      [
        mkClip({ positionS: 0.0, sourceStartS: 10, sourceEndS: 11 }),
        mkClip({ positionS: 1.0, sourceStartS: 20, sourceEndS: 22 }),
        mkClip({ positionS: 3.0, sourceStartS: 30, sourceEndS: 31 }),
      ],
      {
        origin: "test",
        segmentBounds: { startS: 0, endS: 4 },
        resetFirst: true,
      },
    );
    expect(listIssues()).toEqual([]);
    expect(hasErrors()).toBe(false);
  });
});

describe("validation", () => {
  beforeEach(() => reset());

  it("detects overlaps as errors", () => {
    applyPlan(
      [
        mkClip({ positionS: 0, sourceStartS: 0, sourceEndS: 2 }),
        // second clip starts at 1.5 but previous ends at 2 → 0.5s overlap
        mkClip({ positionS: 1.5, sourceStartS: 10, sourceEndS: 11 }),
      ],
      { origin: "test", resetFirst: true },
    );
    const overlaps = listIssues().filter((i) => i.type === "overlap");
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].severity).toBe("error");
    expect(overlaps[0].deltaS).toBeCloseTo(0.5);
    expect(overlaps[0].affectedClipIds).toHaveLength(2);
    expect(hasErrors()).toBe(true);
  });

  it("detects gaps as warnings (not errors)", () => {
    applyPlan(
      [
        mkClip({ positionS: 0, sourceStartS: 0, sourceEndS: 1 }),
        // previous ends at 1.0, this starts at 2.0 → 1s gap
        mkClip({ positionS: 2.0, sourceStartS: 10, sourceEndS: 11 }),
      ],
      { origin: "test", resetFirst: true },
    );
    const gaps = listIssues().filter((i) => i.type === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].severity).toBe("warning");
    expect(gaps[0].deltaS).toBeCloseTo(1.0);
    expect(hasErrors()).toBe(false); // only a warning
  });

  it("tolerates sub-30ms drift", () => {
    applyPlan(
      [
        mkClip({ positionS: 0, sourceStartS: 0, sourceEndS: 1 }),
        // 10ms overlap — within tolerance, should not fire
        mkClip({ positionS: 0.99, sourceStartS: 10, sourceEndS: 11 }),
      ],
      { origin: "test", resetFirst: true },
    );
    expect(listIssues()).toHaveLength(0);
  });

  it("detects anchor drift as a warning", () => {
    applyPlan(
      [
        {
          sourcePath: SRC,
          sourceStartS: 0,
          sourceEndS: 2,
          positionS: 0,
          anchor: {
            sourceTimestampS: 1.0, // at 1s into clip
            beatS: 2.0, // but targetBeat says anchor should be at 2s on timeline
            buildupS: 1.0,
            resolutionS: 1.0,
          },
          description: "test",
        },
      ],
      { origin: "test", resetFirst: true },
    );
    // positionS=0, anchorOffset=1 → anchor lands at 1s, beatS is 2 → drift 1s
    const drift = listIssues().filter((i) => i.type === "anchor-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0].severity).toBe("warning");
    expect(drift[0].deltaS).toBeCloseTo(-1.0);
  });

  it("flags anchor outside source range as error", () => {
    applyPlan(
      [
        {
          sourcePath: SRC,
          sourceStartS: 10,
          sourceEndS: 12,
          positionS: 0,
          anchor: {
            sourceTimestampS: 5.0, // outside [10, 12]
            beatS: 0,
            buildupS: -5, // bogus but not the thing being tested
            resolutionS: 2,
          },
          description: "test",
        },
      ],
      { origin: "test", resetFirst: true },
    );
    const issues = listIssues().filter((i) => i.type === "source-bounds");
    expect(issues.length).toBeGreaterThan(0);
    expect(hasErrors()).toBe(true);
  });

  it("flags first clip not at origin when segmentBounds set", () => {
    applyPlan(
      [mkClip({ positionS: 2.0, sourceStartS: 0, sourceEndS: 1 })],
      {
        origin: "test",
        segmentBounds: { startS: 0, endS: 5 },
        resetFirst: true,
      },
    );
    const outOfSeg = listIssues().filter((i) => i.type === "out-of-segment" && i.severity === "error");
    expect(outOfSeg.length).toBeGreaterThan(0);
  });

  it("flags total duration mismatch as warning when segmentBounds set", () => {
    applyPlan(
      [mkClip({ positionS: 0, sourceStartS: 0, sourceEndS: 3 })],
      {
        origin: "test",
        segmentBounds: { startS: 0, endS: 10 }, // expect 10s total, got 3
        resetFirst: true,
      },
    );
    const outOfSeg = listIssues().filter(
      (i) => i.type === "out-of-segment" && i.severity === "warning",
    );
    expect(outOfSeg.length).toBeGreaterThan(0);
  });
});

describe("mutations", () => {
  beforeEach(() => reset());

  it("updateClip revalidates and can resolve an overlap", () => {
    applyPlan(
      [
        mkClip({ positionS: 0, sourceStartS: 0, sourceEndS: 2 }),
        mkClip({ positionS: 1.5, sourceStartS: 10, sourceEndS: 11 }),
      ],
      { origin: "test", resetFirst: true },
    );
    expect(listIssues().filter((i) => i.type === "overlap")).toHaveLength(1);

    // Trim clip-0's end to eliminate the overlap
    updateClip("clip-0", { sourceEndS: 1.5 });
    expect(listIssues().filter((i) => i.type === "overlap")).toHaveLength(0);
  });

  it("removeClip shrinks the timeline and revalidates", () => {
    applyPlan(
      [
        mkClip({ positionS: 0, sourceStartS: 0, sourceEndS: 1 }),
        mkClip({ positionS: 1, sourceStartS: 10, sourceEndS: 11 }),
        mkClip({ positionS: 2, sourceStartS: 20, sourceEndS: 21 }),
      ],
      { origin: "test", resetFirst: true },
    );
    removeClip("clip-1");
    expect(get().clips).toHaveLength(2);
    expect(get().clips.map((c) => c.id)).toEqual(["clip-0", "clip-2"]);
  });

  it("insertClip adds at any position and resorts", () => {
    applyPlan(
      [mkClip({ positionS: 0, sourceStartS: 0, sourceEndS: 1 })],
      { origin: "test", resetFirst: true },
    );
    const inserted = insertClip(
      mkClip({ positionS: 5, sourceStartS: 50, sourceEndS: 51 }),
      "manual",
    );
    expect(get().clips).toHaveLength(2);
    expect(inserted.meta.origin).toBe("manual");
  });

  it("inspectClip returns full clip document", () => {
    applyPlan(
      [
        {
          sourcePath: SRC,
          sourceStartS: 0,
          sourceEndS: 1,
          positionS: 0,
          description: "the description",
          reasoning: "why I chose it",
          intensity: 7,
        },
      ],
      { origin: "test", resetFirst: true },
    );
    const clip = inspectClip("clip-0");
    expect(clip.meta.description).toBe("the description");
    expect(clip.meta.reasoning).toBe("why I chose it");
    expect(clip.meta.intensity).toBe(7);
  });

  it("inspectClip throws on unknown ID", () => {
    expect(() => inspectClip("clip-nonexistent")).toThrow(/not found/);
  });
});

describe("reset", () => {
  it("clears everything", () => {
    applyPlan(
      [mkClip({ positionS: 0, sourceStartS: 0, sourceEndS: 1 })],
      {
        origin: "test",
        planThoughts: "thoughts",
        segmentBounds: { startS: 0, endS: 1 },
        resetFirst: true,
      },
    );
    setAudio("/tmp/audio.mp3", 10, 30);
    reset();
    const s = get();
    expect(s.clips).toHaveLength(0);
    expect(s.audio).toBeNull();
    expect(s.issues).toHaveLength(0);
    expect(s.planThoughts).toBeNull();
    expect(s.segmentBounds).toBeNull();
  });
});
