#!/usr/bin/env bash
set -euo pipefail

# Delete previously uploaded files from Gemini's File API.
# Requires: curl, GEMINI_API_KEY environment variable
#
# Usage:
#   bash cleanup-gemini-files.sh <file_name> [<file_name> ...]
#
# Example:
#   bash cleanup-gemini-files.sh files/abc123 files/def456
#
# File names are in the format "files/<id>" as returned by the upload API
# (visible in the ECLIPTIC_FILES JSON output from gemini-edit-plan.sh --no-cleanup)

BASE_URL="https://generativelanguage.googleapis.com"

if [[ $# -eq 0 ]]; then
  echo "Usage: bash cleanup-gemini-files.sh <file_name> [<file_name> ...]" >&2
  echo "  file_name: Gemini file name (e.g. files/abc123)" >&2
  echo "" >&2
  echo "File names are printed by gemini-edit-plan.sh --no-cleanup in the ECLIPTIC_FILES line." >&2
  exit 1
fi

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "Error: GEMINI_API_KEY environment variable is required" >&2
  exit 1
fi

for file_name in "$@"; do
  echo "Deleting ${file_name}..." >&2
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --request "DELETE" \
    "${BASE_URL}/v1beta/${file_name}" \
    -H "x-goog-api-key: ${GEMINI_API_KEY}")

  if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "204" ]]; then
    echo "  Deleted ${file_name}" >&2
  else
    echo "  Warning: DELETE ${file_name} returned HTTP ${HTTP_CODE}" >&2
  fi
done

echo "Cleanup complete." >&2
