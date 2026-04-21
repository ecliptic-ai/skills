# cadence

AI-augmented video splicing framework. Sensors + shared timeline + renderer, packaged as a Claude Code plugin.

## What it does

Given a video and an audio track, cadence produces a beat-synced montage. The framework separates **measurement** (librosa beats, ffprobe metadata), **judgment** (Gemini vision and editing decisions), and **execution** (ffmpeg). The default workflow produces an action montage; prompts can steer it toward other styles (cinematic, dialogue, etc.).

## Layout

```
cadence/
├── .claude-plugin/plugin.json   # plugin manifest + userConfig
├── .mcp.json                    # MCP server config (injects env vars)
├── skills/make-montage/         # /cadence:make-montage workflow
└── server/                      # the bundled MCP server
    ├── src/                     # TypeScript source
    │   └── bootstrap.ts         # prereq + venv setup on startup
    ├── index.ts                 # entry
    ├── package.json
    └── python/                  # Python sidecars (librosa)
        ├── beats.py
        └── requirements.txt
```

Three layers:

- **Measurement sensors** — classical, deterministic. `audio-detect-beats` (librosa BPM + beat grid), `audio-metadata`, `video-metadata` (ffprobe).
- **Reasoning sensors** — Gemini-backed. `reason-find-action-moments` (video → ranked moments), `reason-pick-energy-segment` (audio + beat grid → best segment), `reason-plan-edit` (beats + moments → clip list, with optional `stylePrompt` for creative direction).
- **Timeline + render** — `timeline-reset`, `timeline-add-clip`, `timeline-set-audio`, `render-final`.

Plus utilities: `gemini-list-files`, `gemini-delete-file`, `gemini-purge-orphans`.

## Local development

```bash
# One-time
cd server
npm install
python3 -m venv python/venv && python/venv/bin/pip install -r python/requirements.txt

# Per session (from server/)
GEMINI_API_KEY=... npm run dev
```

Server runs at `http://localhost:3000/mcp`. Add to Claude Code:

```bash
claude mcp add --transport http cadence http://localhost:3000/mcp
```

## Plugin install

```bash
# Add the marketplace once
claude plugin marketplace add ecliptic-ai/skills

# Install
claude plugin install cadence@skills
# → prompted for Gemini API key (stored in keychain; if deferred, set via
#   /plugin → Installed → cadence → Configure options)
# → MCP server bootstraps on first spawn: verifies python3/ffmpeg/ffprobe,
#   creates a Python venv + installs librosa to ${CLAUDE_PLUGIN_DATA}/venv
# → tools available
```

Then: `/cadence:make-montage <video> <audio>` runs the full pipeline as a skill, or have Claude call individual tools.

## Prerequisites

The plugin needs these on the host system (cannot be bundled):

- Python 3.11+ (the venv and librosa install into `${CLAUDE_PLUGIN_DATA}`, but need a base interpreter)
- ffmpeg + ffprobe

The server's bootstrap step detects missing prereqs on startup and exits with a clear message. The bootstrap also re-runs `pip install` whenever `requirements.txt` changes, so plugin updates that bump Python deps apply automatically.

## Framework principles

1. **Measurement vs judgment** — classical tools for signal processing, LLMs only for creative decisions. Never ask an LLM to count beats.
2. **Format boundaries** — librosa speaks seconds, Gemini speaks MM:SS.mmm, ffmpeg speaks seconds. Conversions live at the `reason.ts` boundary; everyone else sees seconds.
3. **Lean tool responses** — MCP responses stay small; verbose Gemini reasoning traces go to `.mcp-cache/logs/` on disk.
4. **No fallbacks** — errors surface at trust boundaries (file I/O, subprocess, API calls); internal algorithms run unguarded.
