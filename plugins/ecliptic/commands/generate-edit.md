---
description: Generate a beat-synced video edit from a video file and audio file
argument-hint: <video-path> <audio-path> [edit description]
allowed-tools: Read, Bash, Write, Glob
---

Generate a beat-synced video edit using AI.

**Inputs from arguments:**
- `$1` — Path to the source video file
- `$2` — Path to the audio/music file
- Remaining arguments (`$3` onward, or `$ARGUMENTS` minus first two words) — The user's edit description/prompt

**Step 1: Validate inputs**

Check that both files exist:
- Verify `$1` exists and is a video file
- Verify `$2` exists and is an audio file
- If either is missing, explain what's needed and stop

Check that required tools are available:
- `ffmpeg` must be installed
- `curl` and `jq` must be installed
- `GEMINI_API_KEY` must be set

**Step 2: Generate the edit plan**

Run the Gemini script to analyze video + audio and produce an EditPlan. Use `--no-cleanup` to preserve uploaded files for faster re-prompting:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/gemini-edit-plan.sh --video "$1" --audio "$2" --prompt "<edit description from remaining args>" --no-cleanup
```

This uploads both files to Gemini, which watches the video and listens to the audio simultaneously, then returns a structured edit plan. Save the JSON output. With `--no-cleanup`, the ECLIPTIC_FILES JSON is printed to stderr — capture the video/audio URIs and MIME types for potential reuse.

If the user is iterating on a previous edit and ECLIPTIC_FILES are available, skip the upload entirely:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/gemini-edit-plan.sh --video-uri <uri> --video-mime <mime> --audio-uri <uri> --audio-mime <mime> --prompt "<new description>"
```

**Step 3: Validate the plan**

Pipe the plan through the validator:

```bash
echo '<plan_json>' | bash ${CLAUDE_PLUGIN_ROOT}/scripts/validate-plan.sh
```

If validation fails, report the errors. Try to fix the plan by adjusting the last clip's duration to match `audio_duration`, then re-validate. If it still fails, inform the user and suggest re-running with a different prompt.

**Step 4: Build FFmpeg filters**

Convert the plan to FFmpeg filter strings:

```bash
echo '<plan_json>' | bash ${CLAUDE_PLUGIN_ROOT}/scripts/build-filter.sh
```

Extract the `fullFilter` from the output.

**Step 5: Render with FFmpeg**

Determine the output path — use the video file's directory with name `ecliptic-<hash>.mp4` where `<hash>` is a unique 5-character alphanumeric string (e.g. `ecliptic-a3f9b.mp4`). Generate it with: `cat /dev/urandom | LC_ALL=C tr -dc 'a-z0-9' | head -c5`

Run FFmpeg:

```bash
ffmpeg -y -i "<video_path>" -i "<audio_path>" -filter_complex "<fullFilter>" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 23 -c:a aac -shortest "<output_path>"
```

**Step 6: Report results**

If FFmpeg succeeded (output file exists and has size > 0):
- Report the output file path
- Summarize the edit: number of clips, total duration, audio range used
- If Gemini provided reasoning, share it
- Mention the user can play it with `open <output_path>` on macOS

If FFmpeg failed:
- Show the relevant error from stderr
- Suggest common fixes (codec issues, file format problems)
- Offer to retry with adjusted parameters

**Step 7: Cleanup (when done iterating)**

If `--no-cleanup` was used and the user is done iterating, clean up the Gemini files:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-gemini-files.sh <video_name> <audio_name>
```
