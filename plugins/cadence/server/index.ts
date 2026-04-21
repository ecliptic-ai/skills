/**
 * Cadence MCP server — stdio transport.
 *
 * IMPORTANT: stdout is the MCP protocol channel. Never write to it.
 * Use `console.error` for anything that needs to reach a log.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { bootstrap } from "./src/bootstrap.js";
import * as timeline from "./src/timeline.js";
import * as audioSensor from "./src/sensors/audio.js";
import * as videoSensor from "./src/sensors/video.js";
import * as reason from "./src/sensors/reason.js";
import * as session from "./src/session.js";
import { renderFinal } from "./src/render/ffmpeg.js";

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const err = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

const server = new McpServer({
  name: "cadence",
  version: "0.2.0",
});

// ---------- Resources ----------

server.registerResource(
  "active_timeline",
  "timeline://active",
  {
    title: "Active Timeline",
    description: "Current edit state: clips (with per-clip reasoning and anchors), audio track, validation issues, and plan thoughts.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(timeline.toJSON()),
      },
    ],
  }),
);

// ---------- Session lifecycle ----------

server.registerTool(
  "session-begin",
  {
    description:
      "Begin a new Gemini edit session for this montage. Uploads the video and audio to the Gemini Files API, creates an explicit cache with a system instruction summarizing the user's creative intent, and opens a conversation Gemini will carry across subsequent reason-* calls. Must be called before any reason-* tool. Ends any prior session first.",
    inputSchema: {
      videoPath: z.string().describe("Absolute path to the video source"),
      audioPath: z.string().describe("Absolute path to the audio source"),
      userIntent: z
        .string()
        .describe(
          "The user's creative direction for this edit, in their own words or your synthesis. Examples: 'fast-paced hand-to-hand combat highlights for an anime action montage', 'slow cinematic showcase of the protagonist's powers'. This becomes Gemini's primary scoring axis throughout the session.",
        ),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ videoPath, audioPath, userIntent }) => {
    const s = await session.beginSession({ videoPath, audioPath, userIntent });
    return json({
      sessionId: s.id,
      cachedContentEnabled: !!s.cacheName,
      videoFile: s.files.video.name,
      audioFile: s.files.audio.name,
    });
  },
);

server.registerTool(
  "session-status",
  {
    description: "Return the active session's status, including cached artifacts (moments, segment) and turn count.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => json(session.sessionStatus()),
);

server.registerTool(
  "session-end",
  {
    description: "End the active session. Deletes the Gemini cache if one was created. No-op if no session is active.",
    inputSchema: {},
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async () => json(await session.endSession()),
);

server.registerTool(
  "session-send-message",
  {
    description:
      "Send a free-form message to the session's Gemini chat. Use this for ad-hoc questions that don't fit the structured reason-* tools — e.g. 'which of these two conflicting clips matters more?' or 'describe what's happening in the video around 00:45'. Accepts an optional JSON schema to get a structured response. Otherwise returns plain text. The message joins the session's conversation history, so later reason-* calls will see it.",
    inputSchema: {
      message: z.string().describe("The message to send to Gemini within the active session"),
      responseJsonSchema: z
        .any()
        .optional()
        .describe(
          "Optional JSON schema. If provided, Gemini must return JSON matching this shape. Otherwise returns free-form text.",
        ),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ message, responseJsonSchema }) => {
    const result = await session.sendTurn(message, { responseJsonSchema });
    return json({
      text: result.text,
      thoughtCount: result.thoughts.length,
      usage: result.usage,
    });
  },
);

// ---------- Measurement sensors (deterministic) ----------

server.registerTool(
  "audio-detect-beats",
  {
    description:
      "Detect BPM and every beat timestamp in an audio file using librosa. Deterministic signal processing, not AI inference.",
    inputSchema: {
      audioPath: z.string().describe("Absolute path to the audio file"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ audioPath }) => json(await audioSensor.detectBeats(audioPath)),
);

server.registerTool(
  "audio-metadata",
  {
    description: "Get audio duration via ffprobe",
    inputSchema: {
      audioPath: z.string().describe("Absolute path to the audio file"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ audioPath }) => json({ durationS: await audioSensor.getDuration(audioPath) }),
);

server.registerTool(
  "video-metadata",
  {
    description: "Get video duration, fps, resolution, codec via ffprobe",
    inputSchema: {
      videoPath: z.string().describe("Absolute path to the video file"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ videoPath }) => json(await videoSensor.getMetadata(videoPath)),
);

// ---------- Gemini file inventory ----------

server.registerTool(
  "gemini-list-files",
  {
    description:
      "List all files currently uploaded to the Gemini Files API for this API key. Files auto-expire after 48 hours.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const files = await reason.listUploadedFiles();
    return json({ count: files.length, files });
  },
);

server.registerTool(
  "gemini-delete-file",
  {
    description:
      "Delete a single file from the Gemini Files API by its file ID (e.g. 'files/abc123'). Also removes it from the local disk cache if referenced.",
    inputSchema: {
      fileId: z.string().describe("Gemini file ID, e.g. 'files/abc123'"),
    },
    annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: true },
  },
  async ({ fileId }) => {
    await reason.deleteUploadedFile(fileId);
    return json({ deleted: fileId });
  },
);

server.registerTool(
  "gemini-purge-orphans",
  {
    description:
      "Delete every file in the Gemini Files API that is NOT referenced by our local disk cache. Use dryRun: true first to preview.",
    inputSchema: {
      dryRun: z
        .boolean()
        .default(true)
        .describe("If true (default), only report what would be deleted; don't actually delete."),
    },
    annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: true },
  },
  async ({ dryRun }) => {
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
  },
);

// ---------- Reasoning sensors (session-bound Gemini) ----------

server.registerTool(
  "reason-find-action-moments",
  {
    description:
      "Ask Gemini to watch the session's video and return every moment that fits the user's intent. Requires an active session (see session-begin). Stores the full moments list in the session's artifacts; returns a compact summary (count + highest intensity).",
    inputSchema: {
      fps: z
        .number()
        .min(0.1)
        .max(60)
        .optional()
        .describe(
          "Frames per second to sample. Default 5 (good for action). Use 1-2 for slow footage, 10+ for very fast action. Cost scales linearly.",
        ),
      focusPrompt: z
        .string()
        .optional()
        .describe(
          "Optional additional narrowing for this step. The session's userIntent already steers selection; use this only to refine (e.g. 'exclude moments shorter than 0.5s', 'prefer character-driven frames over environmental shots').",
        ),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ fps, focusPrompt }) => json(await reason.findActionMoments(fps, focusPrompt)),
);

server.registerTool(
  "reason-pick-energy-segment",
  {
    description:
      "Ask Gemini to listen to the session's audio and pick the best segment for the montage, snapped to the provided beat grid. Requires an active session. Stores the segment in the session's artifacts; returns the picked bounds and reasoning.",
    inputSchema: {
      beats: z
        .array(z.number())
        .describe("Full beat timestamp array (seconds) from audio-detect-beats"),
      targetDurationS: z.number().describe("Desired segment duration in seconds (e.g. 30)"),
      focusPrompt: z
        .string()
        .optional()
        .describe(
          "Optional structural preference (e.g. 'prefer the drop after the build; avoid intro/outro'). Skip unless the user has a specific preference.",
        ),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ beats, targetDurationS, focusPrompt }) =>
    json(await reason.pickEnergySegment(beats, targetDurationS, focusPrompt)),
);

server.registerTool(
  "reason-plan-edit",
  {
    description:
      "Ask Gemini to plan the montage and APPLY the plan to the timeline. Uses the session's stored moments and picked segment (call reason-find-action-moments and reason-pick-energy-segment first). Clears any prior timeline state. Returns a summary — for clip-level detail, inspect via timeline-inspect-clip or the timeline resource. If issues exist, resolve them before render-final.",
    inputSchema: {
      beats: z
        .array(z.number())
        .describe("Full beat timestamp array (seconds) from audio-detect-beats. The server filters to the segment."),
      stylePrompt: z
        .string()
        .optional()
        .describe(
          "Arrangement direction — how clips should be cut and paced (e.g. 'fast anime cross-cutting, rarely hold a shot', 'slow cinematic holds with cuts on downbeats'). Applied after intent filtering.",
        ),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ beats, stylePrompt }) => json(await reason.planEdit(beats, stylePrompt)),
);

// ---------- Timeline inspection + conflict resolution ----------

server.registerTool(
  "timeline-list-issues",
  {
    description:
      "Return every validation issue on the current timeline (overlaps, gaps, anchor drift, out-of-segment). Each issue includes affected clip IDs and a human-readable message. Call timeline-inspect-clip for full clip metadata.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => json({ issues: timeline.listIssues() }),
);

server.registerTool(
  "timeline-inspect-clip",
  {
    description:
      "Return the full clip document for a given clip ID: source range, position, anchor metadata, and Gemini's description + reasoning.",
    inputSchema: {
      clipId: z.string().describe("Clip ID, e.g. 'clip-16'"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ clipId }) => {
    try {
      return json(timeline.inspectClip(clipId));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "timeline-update-clip",
  {
    description:
      "Patch a clip's source range, position, anchor, description, or reasoning. Use this to resolve validation issues (e.g. trim a clip's source end to remove an overlap with the next clip). Revalidates the timeline after the change.",
    inputSchema: {
      clipId: z.string().describe("Clip ID to update"),
      sourceStartS: z.number().optional(),
      sourceEndS: z.number().optional(),
      positionS: z.number().optional(),
      description: z.string().optional(),
      reasoning: z.string().optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ clipId, sourceStartS, sourceEndS, positionS, description, reasoning }) => {
    try {
      const updated = timeline.updateClip(clipId, {
        sourceStartS,
        sourceEndS,
        positionS,
        description,
        reasoning,
      });
      return json({ clip: updated, issues: timeline.listIssues() });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "timeline-remove-clip",
  {
    description: "Delete a clip from the timeline. Revalidates the timeline.",
    inputSchema: {
      clipId: z.string().describe("Clip ID to remove"),
    },
    annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: false },
  },
  async ({ clipId }) => {
    try {
      timeline.removeClip(clipId);
      return json({ removed: clipId, issues: timeline.listIssues() });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "timeline-insert-clip",
  {
    description:
      "Insert a new clip into the timeline (e.g. to fill a gap identified by timeline-list-issues). Revalidates the timeline.",
    inputSchema: {
      sourcePath: z.string().describe("Path to source video file"),
      sourceStartS: z.number().min(0),
      sourceEndS: z.number(),
      positionS: z.number().min(0),
      description: z.string(),
      reasoning: z.string().optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ sourcePath, sourceStartS, sourceEndS, positionS, description, reasoning }) => {
    try {
      const clip = timeline.insertClip(
        { sourcePath, sourceStartS, sourceEndS, positionS, description, reasoning },
        "manual",
      );
      return json({ clip, issues: timeline.listIssues() });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

// ---------- Timeline primitives (manual-path) ----------

server.registerTool(
  "timeline-reset",
  {
    description: "Clear the timeline — remove all clips, audio, issues, and thoughts.",
    inputSchema: {},
    annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: false },
  },
  async () => json({ version: timeline.reset().version }),
);

server.registerTool(
  "timeline-add-clip",
  {
    description:
      "Add a video clip to the timeline at a specific output-timeline position. Use this for manual composition; in the session flow, reason-plan-edit applies clips for you.",
    inputSchema: {
      sourceUri: z.string(),
      videoStartS: z.number().min(0),
      videoEndS: z.number(),
      positionS: z.number().min(0),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ sourceUri, videoStartS, videoEndS, positionS }) => {
    try {
      return json(timeline.addClip(sourceUri, videoStartS, videoEndS, positionS));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "timeline-set-audio",
  {
    description: "Set the audio track for the timeline (a range from a source audio file).",
    inputSchema: {
      sourceUri: z.string(),
      startS: z.number().min(0),
      durationS: z.number().positive(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ sourceUri, startS, durationS }) => json(timeline.setAudio(sourceUri, startS, durationS)),
);

// ---------- Rendering ----------

server.registerTool(
  "render-final",
  {
    description:
      "Render the current timeline to an MP4 via ffmpeg. Refuses if the timeline has error-severity issues (overlaps, out-of-bounds). Call timeline-list-issues first if unsure.",
    inputSchema: {
      outputPath: z.string().describe("Absolute path where the rendered MP4 should be written"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ outputPath }) => {
    const state = timeline.get();
    if (state.clips.length === 0) return err("Timeline has no clips. Apply a plan or add clips first.");
    if (!state.audio) return err("Timeline has no audio track. Call reason-plan-edit or timeline-set-audio first.");
    if (timeline.hasErrors()) {
      const errors = state.issues.filter((i) => i.severity === "error");
      return err(
        `Timeline has ${errors.length} error-severity issue(s); refuse to render. Call timeline-list-issues and resolve them (via timeline-update-clip / timeline-remove-clip) before retrying.`,
      );
    }
    return json(await renderFinal(state, outputPath));
  },
);

// ---------- Connect over stdio ----------

await bootstrap();
const transport = new StdioServerTransport();
await server.connect(transport);
