"""Audio beat detection via librosa. Called as subprocess by the MCP server.

Usage:
    python beats.py <audio_path>

Outputs JSON to stdout:
    {"bpm": 123.05, "duration_s": 138.62, "beats": [0.093, 0.604, ...]}
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")

import librosa


def analyze(audio_path: str) -> dict:
    y, sr = librosa.load(audio_path)
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    duration = librosa.get_duration(y=y, sr=sr)

    bpm = float(tempo[0]) if hasattr(tempo, "__len__") else float(tempo)
    return {
        "bpm": round(bpm, 3),
        "duration_s": round(float(duration), 3),
        "beats": [round(float(t), 3) for t in beat_times],
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: beats.py <audio_path>"}), file=sys.stderr)
        sys.exit(1)
    result = analyze(sys.argv[1])
    print(json.dumps(result))
