/**
 * Tests for session turnLock serialization and history management.
 * Mocks the Gemini Files API at the files.ts module boundary so nothing hits the network.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Must hoist above imports. Defines fake Gemini client whose behavior we
// control per-test via the exported mock fns.
vi.mock("../src/files.js", () => {
  const mockGenerate = vi.fn();
  const mockCachesCreate = vi.fn().mockResolvedValue({ name: "cache-test" });
  const mockCachesDelete = vi.fn().mockResolvedValue(undefined);
  const mockClient = {
    models: { generateContent: mockGenerate },
    caches: { create: mockCachesCreate, delete: mockCachesDelete },
    files: { get: vi.fn(), upload: vi.fn() },
  };
  return {
    client: () => mockClient,
    detectMimeType: () => "video/mp4",
    uploadAndWait: vi.fn().mockResolvedValue({
      name: "files/test",
      uri: "gs://test",
      mimeType: "video/mp4",
    }),
  };
});

import { beginSession, sendTurn, endSession } from "../src/session.js";
import { client } from "../src/files.js";

// Grab the same mock fn the session module sees.
const mockGen = (client() as any).models.generateContent;

async function freshSession() {
  await endSession();
  await beginSession({
    videoPath: "/tmp/fake-video.mp4",
    audioPath: "/tmp/fake-audio.mp3",
    userIntent: "test intent",
  });
}

describe("turnLock serialization", () => {
  beforeEach(() => {
    mockGen.mockReset();
  });

  it("serializes two concurrent sendTurn calls", async () => {
    const order: string[] = [];
    mockGen.mockImplementation(async (req: any) => {
      const msg = req.contents[req.contents.length - 1].parts[0].text;
      order.push(`start:${msg}`);
      await new Promise((r) => setTimeout(r, msg === "slow" ? 50 : 10));
      order.push(`end:${msg}`);
      return {
        candidates: [{ content: { parts: [{ text: `reply-${msg}` }] } }],
        usageMetadata: {},
      };
    });

    await freshSession();

    const [r1, r2] = await Promise.all([sendTurn("slow"), sendTurn("fast")]);

    expect(r1.text).toBe("reply-slow");
    expect(r2.text).toBe("reply-fast");
    // Second turn must not start until the first ends
    expect(order).toEqual(["start:slow", "end:slow", "start:fast", "end:fast"]);
  });

  it("history accumulates in call order across turns", async () => {
    mockGen.mockImplementation(async (req: any) => {
      const msg = req.contents[req.contents.length - 1].parts[0].text;
      return {
        candidates: [{ content: { parts: [{ text: `r-${msg}` }] } }],
        usageMetadata: {},
      };
    });

    await freshSession();
    await sendTurn("q1");
    await sendTurn("q2");

    // On the second call the contents should be [user-q1, model-r-q1, user-q2]
    const secondCallArgs = mockGen.mock.calls[1][0];
    const contents = secondCallArgs.contents;
    expect(contents).toHaveLength(3);
    expect(contents[0].role).toBe("user");
    expect(contents[0].parts[0].text).toBe("q1");
    expect(contents[1].role).toBe("model");
    expect(contents[1].parts[0].text).toBe("r-q1");
    expect(contents[2].role).toBe("user");
    expect(contents[2].parts[0].text).toBe("q2");
  });

  it("a failed turn does not break the lock chain", async () => {
    mockGen
      .mockRejectedValueOnce(new Error("api error"))
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: {},
      });

    await freshSession();
    await expect(sendTurn("failing")).rejects.toThrow("api error");
    const r = await sendTurn("good");
    expect(r.text).toBe("ok");
  });

  it("passes cachedContent config when session has a cache", async () => {
    mockGen.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: "x" }] } }],
      usageMetadata: {},
    });
    await freshSession();
    await sendTurn("hello");
    const callArgs = mockGen.mock.calls[0][0];
    expect(callArgs.config.cachedContent).toBe("cache-test");
  });

  it("passes responseJsonSchema when provided", async () => {
    mockGen.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: "{}" }] } }],
      usageMetadata: {},
    });
    await freshSession();
    const schema = { type: "object", properties: {} };
    await sendTurn("hello", { responseJsonSchema: schema });
    const callArgs = mockGen.mock.calls[0][0];
    expect(callArgs.config.responseMimeType).toBe("application/json");
    expect(callArgs.config.responseJsonSchema).toBe(schema);
  });

  it("separates thought-flagged parts from answer text", async () => {
    mockGen.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { text: "internal reasoning", thought: true },
              { text: "the answer" },
              { text: " continued", thought: false },
            ],
          },
        },
      ],
      usageMetadata: { thoughtsTokenCount: 5 },
    });
    await freshSession();
    const r = await sendTurn("hi");
    expect(r.text).toBe("the answer continued");
    expect(r.thoughts).toEqual(["internal reasoning"]);
    expect(r.usage.thoughtsTokens).toBe(5);
  });
});
