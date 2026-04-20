---
description: Generate a beat-synced video edit from a video and an audio track
argument-hint: <video/audio paths + edit description, in any order>
allowed-tools: Read Glob
---

Kick off a beat-synced video edit. The user's request is:

$ARGUMENTS

Parse out the video path, the audio path, and the edit description (any order, any phrasing). If a path is missing or ambiguous, use Glob to find likely candidates in the current directory and confirm with the user before proceeding.

Once you have both files and a description, delegate the full pipeline to the `video-editor` agent — it handles analysis, validation, rendering, retries, and iteration. Pass the resolved paths and description along in the delegation.
