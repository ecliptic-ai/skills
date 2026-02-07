#!/usr/bin/env bash
set -euo pipefail

# Validate an EditPlan JSON from stdin or file argument.
# Exits 0 if valid, exits 1 with error details if invalid.
# Requires: jq
#
# Timestamp format: audio_start and video_start use MM:SS strings.
# Duration format: audio_duration and clip durations use numbers (seconds).
#
# Usage:
#   echo '{"audio_start":"00:13",...}' | bash validate-plan.sh
#   bash validate-plan.sh plan.json

TOLERANCE="0.5"

if [[ "${1:-}" != "" && -f "$1" ]]; then
  PLAN=$(cat "$1")
else
  PLAN=$(cat)
fi

# Validate JSON
if ! echo "$PLAN" | jq empty 2>/dev/null; then
  echo '{"valid":false,"errors":["Invalid JSON"]}' >&2
  exit 1
fi

# Run all validation checks, collect errors
ERRORS=$(echo "$PLAN" | jq -r --arg tol "$TOLERANCE" '
  # Convert MM:SS string to seconds
  def mmss_to_sec:
    if type == "number" then .
    elif type == "string" then
      split(":") | if length == 2 then
        ((.[0] | tonumber) * 60) + (.[1] | tonumber)
      else
        -1
      end
    else -1
    end;

  # Validate MM:SS format
  def valid_mmss:
    if type == "string" then
      test("^[0-9]{1,3}:[0-9]{2}$")
    elif type == "number" then true
    else false
    end;

  def check:
    . as $plan |
    []
    + (if ($plan.clips | length) == 0 then ["No clips provided"] else [] end)
    + (if ($plan.audio_start | valid_mmss | not) then ["Invalid audio_start format: \($plan.audio_start) (must be MM:SS like 01:15)"] else [] end)
    + (if ($plan.audio_start | mmss_to_sec) < 0 then ["Invalid audio_start: \($plan.audio_start) (must be non-negative)"] else [] end)
    + (if $plan.audio_duration <= 0 then ["Invalid audio_duration: \($plan.audio_duration) (must be positive)"] else [] end)
    + ([range($plan.clips | length)] | map(
        . as $i | $plan.clips[$i] |
        (if (.video_start | valid_mmss | not) then "Clip \($i): invalid video_start format \(.video_start) (must be MM:SS)" else null end),
        (if (.video_start | mmss_to_sec) < 0 then "Clip \($i): invalid video_start \(.video_start)" else null end),
        (if .duration <= 0 then "Clip \($i): invalid duration \(.duration)" else null end)
      ) | map(select(. != null)))
    + (
        ($plan.clips | map(.duration) | add) as $total |
        if (($total - $plan.audio_duration) | fabs) > ($tol | tonumber)
        then ["Duration mismatch: clips total \($total)s but audio_duration is \($plan.audio_duration)s"]
        else []
        end
      );
  check
')

ERROR_COUNT=$(echo "$ERRORS" | jq 'length')

if [[ "$ERROR_COUNT" -eq 0 ]]; then
  echo '{"valid":true,"errors":[]}'
  exit 0
else
  echo "$ERRORS" | jq '{valid: false, errors: .}'
  exit 1
fi
