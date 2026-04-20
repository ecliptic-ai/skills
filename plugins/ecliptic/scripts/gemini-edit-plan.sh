#!/usr/bin/env bash
set -euo pipefail

# Upload video + audio to Gemini via REST API, get a structured EditPlan back.
# Requires: curl, jq, GEMINI_API_KEY environment variable
#
# File lifecycle: uploaded files are KEPT by default (48h TTL) so subsequent
# runs can reuse them. Pass --cleanup (or export ECLIPTIC_CLEANUP=1) for
# one-shot behavior that deletes immediately after use.
#
# Usage (fresh upload; files kept for reuse):
#   bash gemini-edit-plan.sh --video clip.mp4 --audio song.mp3 --prompt "fast 30s action edit"
#
# Usage (reuse previously uploaded files; skips upload):
#   bash gemini-edit-plan.sh --video-uri <uri> --video-mime video/mp4 \
#     --audio-uri <uri> --audio-mime audio/mpeg --prompt "different prompt"
#
# Usage (one-shot: upload, run, delete):
#   bash gemini-edit-plan.sh --video clip.mp4 --audio song.mp3 --prompt "..." --cleanup
#
# Output (stdout): EditPlan JSON
# Logs (stderr): Progress + ECLIPTIC_FILES JSON (unless --cleanup)
# --no-cleanup is accepted as a no-op alias for the new default.

BASE_URL="https://generativelanguage.googleapis.com"
MODEL="${GEMINI_MODEL:-gemini-3-flash-preview}"
TMPDIR="${TMPDIR:-/tmp}"
WORK_DIR=$(mktemp -d "${TMPDIR}/ecliptic-XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

# Parse arguments
VIDEO_PATH=""
AUDIO_PATH=""
VIDEO_URI=""
VIDEO_MIME=""
AUDIO_URI=""
AUDIO_MIME=""
VIDEO_NAME=""
AUDIO_NAME=""
USER_PROMPT=""

# Cleanup behavior: keep files by default so users can iterate without
# re-uploading. CLI flags override the env var.
CLEANUP=false
case "${ECLIPTIC_CLEANUP:-}" in
  1|true|yes|TRUE|YES|True|Yes) CLEANUP=true ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --video) VIDEO_PATH="$2"; shift 2 ;;
    --audio) AUDIO_PATH="$2"; shift 2 ;;
    --video-uri) VIDEO_URI="$2"; shift 2 ;;
    --video-mime) VIDEO_MIME="$2"; shift 2 ;;
    --audio-uri) AUDIO_URI="$2"; shift 2 ;;
    --audio-mime) AUDIO_MIME="$2"; shift 2 ;;
    --prompt) USER_PROMPT="$2"; shift 2 ;;
    --cleanup) CLEANUP=true; shift ;;
    --no-cleanup) CLEANUP=false; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Determine mode: reuse (URIs provided) or upload (local files)
REUSE_MODE=false
if [[ -n "$VIDEO_URI" && -n "$AUDIO_URI" ]]; then
  REUSE_MODE=true
  if [[ -z "$VIDEO_MIME" || -z "$AUDIO_MIME" ]]; then
    echo "Error: --video-mime and --audio-mime are required when using --video-uri/--audio-uri" >&2
    exit 1
  fi
elif [[ -z "$VIDEO_PATH" || -z "$AUDIO_PATH" ]]; then
  echo "Usage: bash gemini-edit-plan.sh --video <path> --audio <path> [--prompt <text>] [--cleanup]" >&2
  echo "  Or:  bash gemini-edit-plan.sh --video-uri <uri> --video-mime <mime> --audio-uri <uri> --audio-mime <mime> [--prompt <text>]" >&2
  exit 1
fi

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "Error: GEMINI_API_KEY environment variable is required" >&2
  exit 1
fi

# Validate local files exist (upload mode only)
if [[ "$REUSE_MODE" == false ]]; then
  if [[ ! -f "$VIDEO_PATH" ]]; then
    echo "Error: Video file not found: $VIDEO_PATH" >&2
    exit 1
  fi
  if [[ ! -f "$AUDIO_PATH" ]]; then
    echo "Error: Audio file not found: $AUDIO_PATH" >&2
    exit 1
  fi
fi

# Detect MIME type
get_mime_type() {
  local path="$1"
  local ext="${path##*.}"
  ext=$(echo "$ext" | tr '[:upper:]' '[:lower:]')
  case "$ext" in
    mp4) echo "video/mp4" ;;
    mov) echo "video/quicktime" ;;
    avi) echo "video/x-msvideo" ;;
    mkv) echo "video/x-matroska" ;;
    webm) echo "video/webm" ;;
    mp3) echo "audio/mpeg" ;;
    wav) echo "audio/wav" ;;
    aac) echo "audio/aac" ;;
    ogg) echo "audio/ogg" ;;
    flac) echo "audio/flac" ;;
    m4a) echo "audio/mp4" ;;
    *) file -b --mime-type "$path" ;;
  esac
}

# Upload a file to Gemini using resumable upload protocol
# Args: $1=file_path $2=display_name $3=mime_type
# Outputs: JSON file info to stdout
upload_file() {
  local file_path="$1"
  local display_name="$2"
  local mime_type="$3"
  local num_bytes
  num_bytes=$(wc -c < "$file_path" | tr -d ' ')

  local header_file="${WORK_DIR}/upload-header-${display_name}.tmp"

  # Step 1: Initiate resumable upload
  curl -s "${BASE_URL}/upload/v1beta/files" \
    -H "x-goog-api-key: ${GEMINI_API_KEY}" \
    -D "${header_file}" \
    -H "X-Goog-Upload-Protocol: resumable" \
    -H "X-Goog-Upload-Command: start" \
    -H "X-Goog-Upload-Header-Content-Length: ${num_bytes}" \
    -H "X-Goog-Upload-Header-Content-Type: ${mime_type}" \
    -H "Content-Type: application/json" \
    -d "{\"file\": {\"display_name\": \"${display_name}\"}}" > /dev/null

  local upload_url
  upload_url=$(grep -i "x-goog-upload-url: " "${header_file}" | cut -d" " -f2 | tr -d "\r")

  if [[ -z "$upload_url" ]]; then
    echo "Error: Failed to get upload URL for ${display_name}" >&2
    return 1
  fi

  # Step 2: Upload the file bytes
  curl -s "${upload_url}" \
    -H "Content-Length: ${num_bytes}" \
    -H "X-Goog-Upload-Offset: 0" \
    -H "X-Goog-Upload-Command: upload, finalize" \
    --data-binary "@${file_path}"
}

# Wait for a file to reach ACTIVE state
# Args: $1=file_name (e.g. "files/abc123")
wait_for_file() {
  local file_name="$1"
  local max_attempts=60
  local attempt=0

  while [[ $attempt -lt $max_attempts ]]; do
    local info
    # file_name is already "files/abc123", so use it directly in the path
    info=$(curl -s "${BASE_URL}/v1beta/${file_name}" \
      -H "x-goog-api-key: ${GEMINI_API_KEY}")
    local state
    state=$(echo "$info" | jq -r '.state // empty')

    if [[ "$state" == "ACTIVE" ]]; then
      echo "  File ${file_name} is ACTIVE" >&2
      return 0
    elif [[ "$state" == "FAILED" ]]; then
      echo "Error: File processing failed: ${file_name}" >&2
      echo "  Response: $(echo "$info" | jq -c '.')" >&2
      return 1
    fi

    # Still PROCESSING or unknown state — keep waiting
    attempt=$((attempt + 1))
    echo "  Waiting for ${file_name}... (state: ${state:-unknown}, attempt ${attempt}/${max_attempts})" >&2
    sleep 3
  done

  echo "Error: Timed out waiting for file ${file_name} to become ACTIVE" >&2
  return 1
}

# Delete a file from Gemini
# Args: $1=file_name
delete_file() {
  local file_name="$1"
  curl -s --request "DELETE" "${BASE_URL}/v1beta/${file_name}" \
    -H "x-goog-api-key: ${GEMINI_API_KEY}" > /dev/null 2>&1 || true
}

# Upload or reuse files
if [[ "$REUSE_MODE" == true ]]; then
  echo "Reusing previously uploaded files..." >&2
else
  VIDEO_MIME=$(get_mime_type "$VIDEO_PATH")
  AUDIO_MIME=$(get_mime_type "$AUDIO_PATH")

  # Upload both files
  echo "Uploading video to Gemini..." >&2
  VIDEO_INFO=$(upload_file "$VIDEO_PATH" "video" "$VIDEO_MIME")
  VIDEO_NAME=$(echo "$VIDEO_INFO" | jq -r '.file.name')
  VIDEO_URI=$(echo "$VIDEO_INFO" | jq -r '.file.uri')
  echo "  video uploaded: ${VIDEO_NAME} (${VIDEO_MIME})" >&2

  echo "Uploading audio to Gemini..." >&2
  AUDIO_INFO=$(upload_file "$AUDIO_PATH" "audio" "$AUDIO_MIME")
  AUDIO_NAME=$(echo "$AUDIO_INFO" | jq -r '.file.name')
  AUDIO_URI=$(echo "$AUDIO_INFO" | jq -r '.file.uri')
  echo "  audio uploaded: ${AUDIO_NAME} (${AUDIO_MIME})" >&2

  if [[ -z "$VIDEO_NAME" || "$VIDEO_NAME" == "null" || -z "$AUDIO_NAME" || "$AUDIO_NAME" == "null" ]]; then
    echo "Error: File upload failed" >&2
    exit 1
  fi

  # Wait for processing
  echo "Waiting for Gemini to process files..." >&2
  wait_for_file "$VIDEO_NAME"
  wait_for_file "$AUDIO_NAME"
fi

# Build the prompt
if [[ -z "$USER_PROMPT" ]]; then
  USER_PROMPT="Create an engaging edit that syncs perfectly with the music"
fi

# Build the generateContent request
PROMPT_TEXT="You are an expert video editor with years of experience creating viral edits, music videos, and trailers.

Watch this video carefully. Listen to this audio track. Feel the rhythm, the energy, the emotion.

USER'S VISION: ${USER_PROMPT}

Your job is to create an edit that:

TIMING & RHYTHM:
- Cut ON the beat - not near it, ON it. Every cut should feel intentional.
- Match cut frequency to music energy: fast sections = rapid cuts, slow sections = longer holds
- Use the music's structure (verses, chorus, drops) to guide your pacing
- Land major cuts on downbeats, snare hits, or bass drops

VISUAL STORYTELLING:
- Build energy - start slower, build to climax moments
- Contrast is key: follow a wide shot with a close-up, static with motion
- Choose clips that have inherent motion, emotion, or visual interest
- Avoid cutting mid-action - let movements complete or cut at peak action

CLIP SELECTION:
- Pick the BEST moments - not just any moments that fit
- Favor clips with clear subjects, good lighting, interesting composition
- Match visual energy to audio energy (intense music = intense visuals)

OUTPUT REQUIREMENTS:
- audio_start: where to begin in the audio track, in MM:SS format (e.g. \"01:15\" for 1 minute 15 seconds)
- audio_duration: how long the edit should be in seconds (interpret from user's request, or pick the best section)
- clips: each with video_start (MM:SS format, e.g. \"02:30\") and duration (seconds) that sync to the music
- CRITICAL: clip durations MUST sum to exactly audio_duration
- CRITICAL: Use MM:SS format for all start times (audio_start, video_start). Use seconds for all durations.

Return the edit plan."

# Escape prompt text for JSON
ESCAPED_PROMPT_TEXT=$(printf '%s' "$PROMPT_TEXT" | jq -Rs '.')

# Build request body
REQUEST_BODY=$(jq -n \
  --arg video_uri "$VIDEO_URI" \
  --arg video_mime "$VIDEO_MIME" \
  --arg audio_uri "$AUDIO_URI" \
  --arg audio_mime "$AUDIO_MIME" \
  --argjson prompt_text "$ESCAPED_PROMPT_TEXT" \
  '{
    "contents": [{
      "parts": [
        {"file_data": {"mime_type": $video_mime, "file_uri": $video_uri}},
        {"file_data": {"mime_type": $audio_mime, "file_uri": $audio_uri}},
        {"text": $prompt_text}
      ]
    }],
    "generationConfig": {
      "responseMimeType": "application/json",
      "responseJsonSchema": {
        "type": "object",
        "properties": {
          "audio_start": {
            "type": "string",
            "description": "Start time in the audio track in MM:SS format (e.g. 01:15 for 1 minute 15 seconds)"
          },
          "audio_duration": {
            "type": "number",
            "description": "Total duration of the edit (seconds)"
          },
          "clips": {
            "type": "array",
            "description": "Video clips to use, in order. Durations should sum to audio_duration.",
            "items": {
              "type": "object",
              "properties": {
                "video_start": {
                  "type": "string",
                  "description": "Start time in the source video in MM:SS format (e.g. 02:30 for 2 minutes 30 seconds)"
                },
                "duration": {
                  "type": "number",
                  "description": "Duration of this clip (seconds)"
                },
                "description": {
                  "type": "string",
                  "description": "Brief description of why this clip was chosen"
                }
              },
              "required": ["video_start", "duration"]
            }
          },
          "reasoning": {
            "type": "string",
            "description": "Brief explanation of the edit choices"
          }
        },
        "required": ["audio_start", "audio_duration", "clips"]
      }
    }
  }')

echo "Generating edit plan..." >&2

# Call Gemini with timeout and single retry
generate() {
  curl -s --max-time 300 "${BASE_URL}/v1beta/models/${MODEL}:generateContent" \
    -H "x-goog-api-key: ${GEMINI_API_KEY}" \
    -H "Content-Type: application/json" \
    -X POST \
    -d "$REQUEST_BODY"
}

RESPONSE=$(generate)

# Retry once on empty response or HTTP error
if [[ -z "$RESPONSE" ]] || echo "$RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
  ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error.message // "empty response"' 2>/dev/null || echo "empty response")
  echo "  First attempt failed (${ERROR_MSG}), retrying in 5s..." >&2
  sleep 5
  RESPONSE=$(generate)
fi

# Cleanup or preserve uploaded files. Default is preserve (48h TTL).
if [[ "$REUSE_MODE" == false ]]; then
  if [[ "$CLEANUP" == true ]]; then
    echo "Cleaning up Gemini files..." >&2
    delete_file "$VIDEO_NAME" &
    delete_file "$AUDIO_NAME" &
    wait
  else
    ECLIPTIC_JSON=$(jq -n -c \
      --arg video_name "$VIDEO_NAME" --arg video_uri "$VIDEO_URI" --arg video_mime "$VIDEO_MIME" \
      --arg audio_name "$AUDIO_NAME" --arg audio_uri "$AUDIO_URI" --arg audio_mime "$AUDIO_MIME" \
      '{video_name: $video_name, video_uri: $video_uri, video_mime: $video_mime, audio_name: $audio_name, audio_uri: $audio_uri, audio_mime: $audio_mime}')
    echo "ECLIPTIC_FILES=${ECLIPTIC_JSON}" >&2
    echo "Files kept for reuse (48h TTL). Reuse with --video-uri/--audio-uri." >&2
    echo "Delete now: bash \${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-gemini-files.sh ${VIDEO_NAME} ${AUDIO_NAME}" >&2
  fi
fi

# Extract the text response
PLAN=$(echo "$RESPONSE" | jq -r '.candidates[0].content.parts[0].text // empty')

if [[ -z "$PLAN" ]]; then
  echo "Error: Failed to get edit plan from Gemini" >&2
  echo "Response: $(echo "$RESPONSE" | jq -r '.error.message // "Unknown error"')" >&2
  exit 1
fi

# Validate it's proper JSON and output
if echo "$PLAN" | jq empty 2>/dev/null; then
  CLIP_COUNT=$(echo "$PLAN" | jq '.clips | length')
  DURATION=$(echo "$PLAN" | jq '.audio_duration')
  REASONING=$(echo "$PLAN" | jq -r '.reasoning // empty')
  echo "Edit plan: ${CLIP_COUNT} clips, ${DURATION}s duration" >&2
  if [[ -n "$REASONING" ]]; then
    echo "Reasoning: ${REASONING}" >&2
  fi
  echo "$PLAN"
else
  echo "Error: Gemini returned invalid JSON" >&2
  echo "$PLAN" | head -c 500 >&2
  exit 1
fi
