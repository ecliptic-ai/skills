/**
 * Audio measurement sensors. librosa via Python subprocess for BPM/beats.
 * Everything else via ffprobe.
 */
import { execa } from "execa";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In plugin mode these are set by .mcp.json (CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA).
// In local dev, fall back to repo-relative paths under server/.
const BEATS_SCRIPT = process.env.BEATS_SCRIPT || resolve(__dirname, "../../python/beats.py");
const PYTHON = process.env.PYTHON_BIN || resolve(__dirname, "../../python/venv/bin/python3");

export type BeatAnalysis = {
  bpm: number;
  durationS: number;
  beats: number[];
};

export async function detectBeats(audioPath: string): Promise<BeatAnalysis> {
  const { stdout } = await execa(PYTHON, [BEATS_SCRIPT, audioPath]);
  const parsed = JSON.parse(stdout);
  return {
    bpm: parsed.bpm,
    durationS: parsed.duration_s,
    beats: parsed.beats,
  };
}

export async function getDuration(audioPath: string): Promise<number> {
  const { stdout } = await execa("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    audioPath,
  ]);
  return parseFloat(stdout.trim());
}
