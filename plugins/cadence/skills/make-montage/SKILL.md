---
name: make-montage
description: Build a beat-synced video montage from a video and audio file by orchestrating cadence's MCP tools. Use when the user asks to create a montage, edit action footage to music, or cut video to the beat.
argument-hint: <video-path> <audio-path> [output-path]
---

Build a beat-synced montage from the arguments: `$0` is the video path, `$1` is the audio path, `$2` is the optional output path (default: `montage.mp4` in the current working directory).

## How this skill thinks

Cadence runs as a **three-party conversation**: you (Claude) orchestrate tool calls; Gemini acts as the subject-matter expert for video/audio perception and creative judgment; the user speaks through you. Gemini's reasoning carries *across* the calls in a session — it remembers what moments it found, which segment it picked, and why. Your job is to synthesize the user's raw request into a coherent `userIntent` at session-begin, then make targeted calls and inspect results.

## Interpreting the user's request

Split intent across two axes before calling tools:

- **Content intent** — *what* should appear in the montage. Feeds the session's `userIntent` (shapes every Gemini call) and the optional per-call `focusPrompt` for refinement.
- **Arrangement style** — *how* the content should be cut. Passed as `stylePrompt` to `reason-plan-edit`.

Enrich vague user phrases into concrete criteria before passing. "Badass close combat" → "physical melee engagements — punches, kicks, grapples, throws, blocks; exclude ranged attacks, environmental destruction, and dialogue."

If the user hasn't given arrangement direction, ask. Reasonable defaults:

- **Fast-paced anime action**: rapid cross-cutting, rarely hold a shot, anchor hardest hits on downbeats
- **Cinematic build**: longer holds, moments breathe, cuts only on strong beats
- **Sequential scene**: clips roughly follow the video's original order

## Pipeline

### 1. Begin the session

```
session-begin(videoPath: $0, audioPath: $1, userIntent: "<your synthesis>")
```

Uploads both files to Gemini and opens a cached conversation. Everything below runs within this session — Gemini remembers the intent across all `reason-*` calls.

### 2. Measure the audio

```
audio-detect-beats(audioPath: $1) → { bpm, durationS, beats }
```

Pure DSP, not in the Gemini conversation. Keep the full `beats` array.

### 3. Find action moments

```
reason-find-action-moments(fps?: 5, focusPrompt?: "<optional refinement>")
```

Stores moments on the session. Returns `{ momentCount, highestIntensity, usage }`. Gemini scores moments by fit-to-intent, not generic visual impact — a wide-shot explosion is low-intensity if the user wants hand-to-hand.

### 4. Pick the energy segment

```
reason-pick-energy-segment(beats: <full grid>, targetDurationS: 30, focusPrompt?: "<optional>")
```

Gemini picks the best audio window, snapped to beats. Returns `{ segmentStartS, segmentEndS, reasoning, usage }`; segment is stored on the session for planning.

### 5. Plan the edit (and apply it)

```
reason-plan-edit(beats: <full grid>, stylePrompt?: "<arrangement direction>")
```

Pulls moments + segment from the session, asks Gemini to plan clip placement (with per-clip anchor metadata + reasoning), and **applies the plan to the timeline directly**. Returns a summary: `{ clipCount, issueCount, errorCount, warningCount, clipIds, segmentBounds, totalGeminiTokens }`.

Each clip Gemini produces has an *anchor* — the source frame that should land on a specific beat on the output timeline — plus `buildupS`/`resolutionS` reservations that determine source range and timeline position. A clip can span multiple beat intervals if the moment needs room (explosions, reveals).

### 6. Resolve issues (only if needed)

If `errorCount > 0`, the timeline has overlaps or out-of-bounds clips. Warnings (gaps, small drift) are okay to ignore.

```
timeline-list-issues → { issues: [{ type, severity, affectedClipIds, message, deltaS }] }
```

For each error, inspect the affected clips:

```
timeline-inspect-clip(clipId) → { source, positionS, durationS, anchor, meta: { description, reasoning, intensity, origin } }
```

Decide which clip to modify based on the reasoning (e.g. "this clip's resolution is a low-motion dust-settle — trim it; the next clip's buildup is a critical dodge setup — keep it"). Apply the fix:

```
timeline-update-clip(clipId: "clip-16", sourceEndS: <new value>)   // trim a clip
timeline-remove-clip(clipId: "clip-9")                             // drop a clip
timeline-insert-clip(sourcePath, sourceStartS, sourceEndS, positionS, description)  // fill a gap
```

Each update revalidates. Loop until `timeline-list-issues` returns no errors.

### 7. Render

```
render-final(outputPath: $2 or "montage.mp4")
```

Refuses if errors remain. Returns `{ outputPath, outputBytes, clipCount, durationS, warnings }`.

### 8. End the session

```
session-end
```

Deletes the Gemini cache. Do this even if you hit errors — the cache has a TTL but explicit cleanup is polite.

## Report back to the user

After render, summarize in 3-4 lines:

- Output path and size (MB)
- Segment chosen (MM:SS → MM:SS)
- Clip count and BPM
- Total Gemini token usage (sum `usage.totalTokens` across `reason-*` calls)

Don't dump clip details — they're inspectable via `timeline-inspect-clip` and the plan thoughts blob is on the timeline resource. The per-call disk logs are at `${CLAUDE_PLUGIN_DATA}/cache/logs/`.
