#!/usr/bin/env bash
set -euo pipefail

# Convert an EditPlan JSON into FFmpeg filter_complex strings.
# Reads from stdin or file argument.
# Requires: jq
#
# Timestamp format: audio_start and video_start are MM:SS strings.
# Duration format: audio_duration and clip durations are numbers (seconds).
#
# Usage:
#   echo '{"audio_start":"00:13",...}' | bash build-filter.sh
#   bash build-filter.sh plan.json
#
# Output:
#   {"videoFilter":"...","audioFilter":"...","fullFilter":"..."}

if [[ "${1:-}" != "" && -f "$1" ]]; then
  PLAN=$(cat "$1")
else
  PLAN=$(cat)
fi

echo "$PLAN" | jq -r '
  # Convert MM:SS string to seconds (also handles plain numbers for backwards compat)
  def mmss_to_sec:
    if type == "number" then .
    elif type == "string" then
      split(":") | ((.[0] | tonumber) * 60) + (.[1] | tonumber)
    else 0
    end;

  # Format a number to 3 decimal places for FFmpeg
  def fmt:
    . * 1000 | round / 1000 | tostring |
    if test("\\.") then . else . + ".0" end |
    split(".") | .[0] + "." + (.[1] + "000")[0:3];

  .clips as $clips |
  (.audio_start | mmss_to_sec) as $astart |
  .audio_duration as $adur |

  # Build trim filters for each clip
  ($clips | to_entries | map(
    (.value.video_start | mmss_to_sec) as $vs |
    "[0:v]trim=start=\($vs | fmt):duration=\(.value.duration | fmt),setpts=PTS-STARTPTS[v\(.key)]"
  ) | join("; ")) as $trims |

  # Build concat input labels
  ($clips | to_entries | map("[v\(.key)]") | join("")) as $labels |

  # Video filter
  ($trims + "; " + $labels + "concat=n=\($clips | length):v=1:a=0[outv]") as $vf |

  # Audio filter
  ("[1:a]atrim=start=\($astart | fmt):duration=\($adur | fmt),asetpts=PTS-STARTPTS[outa]") as $af |

  {
    videoFilter: $vf,
    audioFilter: $af,
    fullFilter: ($vf + "; " + $af)
  }
'
