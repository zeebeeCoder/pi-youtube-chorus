import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import registerYoutubeChorus from "./index.js";

type ToolLike = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ details?: Record<string, unknown> }>;
};

type MockPi = {
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
};

describe("youtube chorus extension", () => {
  let tools: Map<string, ToolLike>;
  let commands: Map<string, unknown>;
  let mockPi: MockPi;
  let tempDir: string | undefined;

  beforeEach(() => {
    tools = new Map();
    commands = new Map();
    mockPi = {
      registerTool: vi.fn((tool: ToolLike) => tools.set(tool.name, tool)),
      registerCommand: vi.fn((name: string, command: unknown) => commands.set(name, command)),
      on: vi.fn(),
      exec: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    registerYoutubeChorus(mockPi as unknown as ExtensionAPI);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("registers capture/context tools and slash command", () => {
    expect(tools.has("youtube_chorus_capture")).toBe(true);
    expect(tools.has("youtube_chorus_context")).toBe(true);
    expect(commands.has("yt-chorus")).toBe(true);
  });

  it("fails loudly when context is pointed at the wrong capture directory", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yt-chorus-test-"));
    const tool = tools.get("youtube_chorus_context")!;

    await expect(
      tool.execute(
        "tool-call-id",
        { captureDir: "missing-capture" },
        undefined,
        undefined,
        { cwd: tempDir }
      )
    ).rejects.toThrow(/No manifest\.json found/);
  });

  it("captures into canonical layout and keeps derived manifest paths valid", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yt-chorus-test-"));
    vi.stubEnv("YOUTUBE_API_KEY", "test-key");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("/videos")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [
                {
                  id: "dQw4w9WgXcQ",
                  snippet: {
                    title: "Demo",
                    channelTitle: "Demo Channel",
                    channelId: "channel-1",
                    publishedAt: "2026-07-04T00:00:00Z",
                  },
                },
              ],
            }),
          } as Response;
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: "thread-1",
                snippet: {
                  totalReplyCount: 0,
                  topLevelComment: {
                    id: "comment-1",
                    snippet: {
                      authorDisplayName: "@demo",
                      textOriginal: "Useful investing comment",
                      publishedAt: "2026-07-04T00:00:00Z",
                      likeCount: 2,
                    },
                  },
                },
              },
            ],
          }),
        } as Response;
      })
    );

    mockPi.exec.mockImplementation(async (command: string, args: string[], options: { cwd?: string }) => {
      expect(command).toBe("yt-dlp");
      expect(options.cwd).toBe(tempDir);
      if (args[0] === "--version") {
        return { code: 0, stdout: "2026.07.04\n", stderr: "", killed: false };
      }

      const outputTemplate = args[args.indexOf("--output") + 1];
      const outputDir = outputTemplate.replace("/%(id)s.%(language)s.%(ext)s", "");
      await mkdir(outputDir, { recursive: true });
      if (args.includes("--write-subs")) {
        await writeFile(
          join(outputDir, "dQw4w9WgXcQ.en.json3"),
          JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello" }] }] }),
          "utf8"
        );
      }

      return { code: 0, stdout: "", stderr: "", killed: false };
    });

    const tool = tools.get("youtube_chorus_capture")!;
    const result = await tool.execute(
      "tool-call-id",
      { videoUrl: "https://youtu.be/dQw4w9WgXcQ", outputDir: "capture", maxComments: 1, maxWords: 1000 },
      undefined,
      undefined,
      { cwd: tempDir }
    );

    const captureDir = (result.details as { captureDir: string }).captureDir;
    const manifest = JSON.parse(await readFile(join(captureDir, "manifest.json"), "utf8"));

    expect(manifest.extractor).toBe("native");
    expect(manifest.yt_dlp_version).toBe("2026.07.04");
    expect(manifest.artifact_layout).toBe("canonical");
    await expect(access(join(captureDir, "transcript.normalized.txt"))).resolves.toBeUndefined();
    await expect(access(join(captureDir, "transcript.segments.jsonl"))).resolves.toBeUndefined();
    await expect(access(join(captureDir, "comments.scored.jsonl"))).resolves.toBeUndefined();
    await expect(access(join(captureDir, "raw", "transcript.txt"))).resolves.toBeUndefined();
    await expect(access(join(captureDir, "raw", "dQw4w9WgXcQ.en.json3"))).resolves.toBeUndefined();
    await expect(access(join(captureDir, "dQw4w9WgXcQ.en.json3"))).rejects.toThrow();
    await expect(access(manifest.derived.files.transcript_normalized)).resolves.toBeUndefined();
    expect(manifest.derived.files.transcript_normalized).toBe(join(captureDir, "transcript.normalized.txt"));
  });

  it("aborts surviving capture branches when one rejects (no sibling leak)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yt-chorus-test-"));
    vi.stubEnv("YOUTUBE_API_KEY", "test-key");

    let transcriptSignalAborted = false;
    let transcriptPassesInvoked = 0;
    // Gate: lets the metadata branch wait until the yt-dlp survivor has
    // actually reached pi.exec, so the abort is observed by a registered
    // listener rather than racing the readdir before it.
    let releaseMetadata!: () => void;
    const transcriptExecStarted = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        // Metadata branch fails: video not found. It waits for the yt-dlp
        // branch to start first, then rejects and aborts the survivor.
        if (href.includes("/videos")) {
          await transcriptExecStarted;
          return { ok: false, status: 404, json: async () => ({ error: { message: "Video not found" } }) } as Response;
        }
        // Comments branch resolves quickly with no items.
        return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
      })
    );

    mockPi.exec.mockImplementation(async (command: string, args: string[], options: { cwd?: string; signal?: AbortSignal }) => {
      expect(command).toBe("yt-dlp");
      if (args[0] === "--version") {
        return { code: 0, stdout: "2026.07.04\n", stderr: "", killed: false };
      }

      // Transcript pass: emulate a long yt-dlp run that gets cancelled by the
      // shared capture signal when the metadata branch rejects.
      transcriptPassesInvoked += 1;
      releaseMetadata();
      const sig = options.signal;
      return new Promise((_resolve, reject) => {
        if (sig?.aborted) {
          transcriptSignalAborted = true;
          reject(new Error("Operation aborted."));
          return;
        }
        sig?.addEventListener(
          "abort",
          () => {
            transcriptSignalAborted = true;
            reject(new Error("Operation aborted."));
          },
          { once: true }
        );
      });
    });

    const tool = tools.get("youtube_chorus_capture")!;
    await expect(
      tool.execute(
        "tool-call-id",
        { videoUrl: "https://youtu.be/dQw4w9WgXcQ", outputDir: "capture-fail", maxComments: 1, maxWords: 1000 },
        undefined,
        undefined,
        { cwd: tempDir }
      )
    ).rejects.toThrow(/404|Video not found|HTTP/);

    // The yt-dlp survivor must have been aborted, not left to run for 5 min.
    expect(transcriptPassesInvoked).toBeGreaterThan(0);
    expect(transcriptSignalAborted).toBe(true);
  });
});
