---
name: make-montage
description: Build a beat-synced video montage from a video and audio file by orchestrating cadence's MCP tools. Use when the user asks to create a montage, edit action footage to music, or cut video to the beat.
argument-hint: <video-path> <audio-path> [output-path]
---

Build a beat-synced montage from the arguments: `$0` is the video path, `$1` is the audio path, `$2` is the optional output path (default: `montage.mp4` in the current working directory).

Ask the user what style they want if they haven't specified one. Reasonable defaults to offer:

- **Fast-paced anime action**: rapid cross-cutting, every beat lands on a different source moment, high/low intensity mixed for rhythm
- **Cinematic build**: longer held shots, moments allowed to play out, only cut on strong beats
- **Sequential scene**: clips roughly follow the video's original order, rebuilding story beats

Then run the pipeline:

## Pipeline

### 1. Measure the audio (classical)

Call `audio-detect-beats` with the audio path. This returns `{ bpm, durationS, beats }` where `beats` is the full decimal-seconds grid from librosa. Note the full grid — you'll need it twice.

### 2. Find action moments (Gemini vision)

Call `reason-find-action-moments` with the video path and `fps: 5`. This returns a list of visually striking moments with intensity scores. Note the `geminiFileId` for reference; subsequent calls on the same video will reuse it.

### 3. Pick the best energy segment (Gemini audio)

Call `reason-pick-energy-segment` with the audio path, the full beat grid from step 1, and a `targetDurationS` (default 30). This returns `segmentStartS` and `segmentEndS` snapped to the beat grid.

### 4. Plan the edit (Gemini editing)

Filter the beat grid to just the beats within the chosen segment (inclusive). Call `reason-plan-edit` with those segment beats, `segmentStartS`, `segmentEndS`, the action moments, and an optional `stylePrompt` based on the style the user chose. This returns an ordered list of `clips` with `videoStartS`/`videoEndS`.

### 5. Build the timeline

Call `timeline-reset` to clear any prior state.

Call `timeline-set-audio` with the audio source, `startS: segmentStartS`, and `durationS: segmentEndS - segmentStartS`.

For each clip `i` in the edit plan, call `timeline-add-clip` with `videoStartS`, `videoEndS` from the plan, and `positionS: segmentBeats[i] - segmentBeats[0]` (the beat's offset from segment start). These can all be called in parallel.

### 6. Render

Call `render-final` with `outputPath` from `$2` or default. The response gives `outputBytes`, `durationS`, `clipCount`, and any `warnings`.

## Report back to the user

After render, summarize in 3-4 lines:

- Output path and size (MB)
- Segment chosen (MM:SS to MM:SS)
- Clip count and BPM
- Total Gemini token usage (sum `usage.totalTokens` across the three reason-* calls)

Don't dump every clip or every moment — they're in the disk log at `${CLAUDE_PLUGIN_DATA}/cache/logs/` if the user wants to inspect them.
