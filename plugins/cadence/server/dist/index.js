/**
 * Cadence MCP server — stdio transport.
 *
 * Uses the official `@modelcontextprotocol/sdk` so this server can be spawned
 * by Claude Code as a plugin via `.mcp.json`'s `"command": "node"` form.
 *
 * IMPORTANT: stdout is the MCP protocol channel. Never write to it.
 * Use `console.error` for anything that needs to reach a log.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as timeline from "./src/timeline.js";
import * as audioSensor from "./src/sensors/audio.js";
import * as videoSensor from "./src/sensors/video.js";
import * as reason from "./src/sensors/reason.js";
import { renderFinal } from "./src/render/ffmpeg.js";
// Small helpers to mirror the mcp-use response shapes we used before.
const json = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data) }],
});
const err = (message) => ({
    content: [{ type: "text", text: message }],
    isError: true,
});
const server = new McpServer({
    name: "cadence",
    version: "0.1.0",
});
// ---------- Resources ----------
server.registerResource("active_timeline", "timeline://active", {
    title: "Active Timeline",
    description: "Current edit state: clips, audio track, and computed total duration.",
    mimeType: "application/json",
}, async (uri) => ({
    contents: [
        {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(timeline.toJSON()),
        },
    ],
}));
// ---------- Measurement sensors (deterministic) ----------
server.registerTool("audio-detect-beats", {
    description: "Detect BPM and every beat timestamp in an audio file using librosa. Deterministic signal processing, not AI inference.",
    inputSchema: {
        audioPath: z.string().describe("Absolute path to the audio file"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ audioPath }) => json(await audioSensor.detectBeats(audioPath)));
server.registerTool("audio-metadata", {
    description: "Get audio duration via ffprobe",
    inputSchema: {
        audioPath: z.string().describe("Absolute path to the audio file"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ audioPath }) => json({ durationS: await audioSensor.getDuration(audioPath) }));
server.registerTool("video-metadata", {
    description: "Get video duration, fps, resolution, codec via ffprobe",
    inputSchema: {
        videoPath: z.string().describe("Absolute path to the video file"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ videoPath }) => json(await videoSensor.getMetadata(videoPath)));
// ---------- Gemini file inventory ----------
server.registerTool("gemini-list-files", {
    description: "List all files currently uploaded to the Gemini Files API for this API key. Useful for debugging what's cached, finding orphaned uploads, or checking file state/expiry. Files auto-expire after 48 hours.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => {
    const files = await reason.listUploadedFiles();
    return json({ count: files.length, files });
});
server.registerTool("gemini-delete-file", {
    description: "Delete a single file from the Gemini Files API by its file ID (e.g. 'files/abc123'). Also removes it from the local disk cache if referenced.",
    inputSchema: {
        fileId: z.string().describe("Gemini file ID, e.g. 'files/abc123'"),
    },
    annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: true },
}, async ({ fileId }) => {
    await reason.deleteUploadedFile(fileId);
    return json({ deleted: fileId });
});
server.registerTool("gemini-purge-orphans", {
    description: "Delete every file in the Gemini Files API that is NOT referenced by our local disk cache. Orphans are left over from old uploads before the cache existed or from source files that have since changed. Use dryRun: true first to preview what would be deleted.",
    inputSchema: {
        dryRun: z
            .boolean()
            .default(true)
            .describe("If true (default), only report what would be deleted; don't actually delete."),
    },
    annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: true },
}, async ({ dryRun }) => {
    const result = await reason.purgeOrphans(dryRun);
    const totalBytes = result.orphans.reduce((s, f) => s + (f.sizeBytes ?? 0), 0);
    return json({
        dryRun,
        keptCount: result.kept.length,
        orphanCount: result.orphans.length,
        orphanBytes: totalBytes,
        deletedCount: result.deleted.length,
        orphans: result.orphans.map((f) => ({
            name: f.name,
            displayName: f.displayName,
            sizeBytes: f.sizeBytes,
            createTime: f.createTime,
        })),
    });
});
// ---------- Reasoning sensors (AI-based) ----------
server.registerTool("reason-find-action-moments", {
    description: "Ask Gemini to watch a video and return every visually striking action moment with timestamps and intensity scores. Use this to populate a candidate pool for edit planning. The fps parameter controls how densely Gemini samples frames from the video — higher fps catches sub-second impacts at the cost of more tokens.",
    inputSchema: {
        videoPath: z.string().describe("Absolute path to the video file"),
        fps: z
            .number()
            .min(0.1)
            .max(60)
            .optional()
            .describe("Frames per second to sample from the video. Default 5 (good for action). Use 1-2 for static/slow footage, 10+ for very fast action. Cost scales linearly."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ videoPath, fps }) => json(await reason.findActionMoments(videoPath, fps)));
server.registerTool("reason-pick-energy-segment", {
    description: "Ask Gemini to listen to audio and choose the best high-energy segment for a montage. The choice snaps to a beat grid you provide (pairs well with audio-detect-beats).",
    inputSchema: {
        audioPath: z.string().describe("Absolute path to the audio file"),
        beats: z.array(z.number()).describe("Beat timestamps (seconds) from audio-detect-beats"),
        targetDurationS: z.number().describe("Desired segment duration in seconds"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ audioPath, beats, targetDurationS }) => json(await reason.pickEnergySegment(audioPath, beats, targetDurationS)));
server.registerTool("reason-plan-edit", {
    description: "Ask Gemini to map video action moments onto beat intervals. Returns a list of clips (videoStartS/videoEndS) sized to fit each beat gap. Does NOT mutate the timeline — call timeline-add-clip to apply. Pass stylePrompt to steer the edit's aesthetic (e.g. 'fast-paced anime montage', 'slow cinematic build', 'rhythmic match cuts').",
    inputSchema: {
        beats: z.array(z.number()).describe("Beat timestamps in the chosen segment"),
        segmentStartS: z.number().describe("Segment start (seconds)"),
        segmentEndS: z.number().describe("Segment end (seconds)"),
        moments: z
            .array(z.object({
            startS: z.number(),
            endS: z.number(),
            description: z.string(),
            intensity: z.number(),
        }))
            .describe("Action moments from reason-find-action-moments"),
        stylePrompt: z
            .string()
            .optional()
            .describe("Optional creative direction for the edit style (cross-cutting rules, pacing, aesthetic references). Prepended to the default planner prompt."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ beats, segmentStartS, segmentEndS, moments, stylePrompt }) => json(await reason.planEdit(beats, segmentStartS, segmentEndS, moments, stylePrompt)));
// ---------- Timeline operations (mutable state) ----------
server.registerTool("timeline-reset", {
    description: "Clear the timeline — remove all clips and audio.",
    inputSchema: {},
    annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: false },
}, async () => json({ version: timeline.reset().version }));
server.registerTool("timeline-add-clip", {
    description: "Add a video clip to the timeline at a specific output-timeline position. videoEndS must be strictly greater than videoStartS, and videoStartS/positionS must be non-negative. The call is rejected with an error if these invariants are violated.",
    inputSchema: {
        sourceUri: z.string().describe("Path to source video file"),
        videoStartS: z.number().min(0).describe("Start timestamp in source video (seconds, >= 0)"),
        videoEndS: z.number().describe("End timestamp in source video (seconds, must be > videoStartS)"),
        positionS: z.number().min(0).describe("Position on the output timeline (seconds, >= 0)"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
}, async ({ sourceUri, videoStartS, videoEndS, positionS }) => {
    try {
        return json(timeline.addClip(sourceUri, videoStartS, videoEndS, positionS));
    }
    catch (e) {
        return err(e instanceof Error ? e.message : String(e));
    }
});
server.registerTool("timeline-set-audio", {
    description: "Set the audio track for the timeline (a range from a source audio file).",
    inputSchema: {
        sourceUri: z.string().describe("Path to source audio file"),
        startS: z.number().min(0).describe("Start offset in source audio (seconds, >= 0)"),
        durationS: z.number().positive().describe("Duration to play (seconds, > 0)"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
}, async ({ sourceUri, startS, durationS }) => json(timeline.setAudio(sourceUri, startS, durationS)));
// ---------- Rendering ----------
server.registerTool("render-final", {
    description: "Render the current timeline to an MP4 file using ffmpeg. Requires at least one clip and an audio track.",
    inputSchema: {
        outputPath: z.string().describe("Absolute path where the rendered MP4 should be written"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
}, async ({ outputPath }) => {
    const state = timeline.get();
    if (state.clips.length === 0)
        return err("Timeline has no clips. Add clips with timeline-add-clip first.");
    if (!state.audio)
        return err("Timeline has no audio track. Set one with timeline-set-audio first.");
    return json(await renderFinal(state, outputPath));
});
// ---------- Connect over stdio ----------
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=index.js.map