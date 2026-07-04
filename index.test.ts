import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import registerYoutubeChorus from "./index.js";

describe("youtube chorus extension", () => {
  let tools: Map<string, any>;
  let commands: Map<string, any>;
  let mockPi: any;
  let tempDir: string | undefined;

  beforeEach(() => {
    tools = new Map();
    commands = new Map();
    mockPi = {
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
      on: vi.fn(),
      exec: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    registerYoutubeChorus(mockPi);
  });

  afterEach(async () => {
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
    const tool = tools.get("youtube_chorus_context");

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
    mockPi.exec.mockImplementation(async (_command: string, args: string[], options: any) => {
      expect(options.cwd).toBe(tempDir);
      const outputDir = args[args.indexOf("--output-dir") + 1];
      await mkdir(outputDir, { recursive: true });

      const files = {
        metadata: join(outputDir, "metadata.json"),
        transcript_json: join(outputDir, "transcript.json"),
        transcript_text: join(outputDir, "transcript.txt"),
        comments_json: join(outputDir, "comments.json"),
        comments_jsonl: join(outputDir, "comments.jsonl"),
        comments_markdown: join(outputDir, "comments.md"),
        bundle: join(outputDir, "bundle.md"),
      };

      await writeFile(files.metadata, JSON.stringify({ title: "Demo" }), "utf8");
      await writeFile(files.transcript_json, "{}", "utf8");
      await writeFile(
        files.transcript_text,
        JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello" }] }] }),
        "utf8"
      );
      await writeFile(
        files.comments_json,
        JSON.stringify({
          comments: [
            { index: 1, comment: "Useful investing comment", user_name: "@demo", date: "2026-07-04T00:00:00Z", like_count: 2, replies: [] },
          ],
        }),
        "utf8"
      );
      await writeFile(files.comments_jsonl, "{}\n", "utf8");
      await writeFile(files.comments_markdown, "# Comments", "utf8");
      await writeFile(files.bundle, "# Bundle", "utf8");
      await writeFile(
        join(outputDir, "manifest.json"),
        JSON.stringify({
          captured_at: "2026-07-04T00:00:00Z",
          video_url: "https://youtu.be/dQw4w9WgXcQ",
          video_id: "dQw4w9WgXcQ",
          title: "Demo",
          channel: "Demo Channel",
          stats: {},
          files,
        }),
        "utf8"
      );

      return { code: 0, stdout: `done\n${basename(outputDir)}\n`, stderr: "", killed: false };
    });

    const tool = tools.get("youtube_chorus_capture");
    const result = await tool.execute(
      "tool-call-id",
      { videoUrl: "https://youtu.be/dQw4w9WgXcQ", outputDir: "capture", maxComments: 1, maxWords: 1000 },
      undefined,
      undefined,
      { cwd: tempDir }
    );

    const captureDir = result.details.captureDir;
    const manifest = JSON.parse(await readFile(join(captureDir, "manifest.json"), "utf8"));

    expect(manifest.artifact_layout).toBe("canonical");
    await expect(access(join(captureDir, "transcript.normalized.txt"))).resolves.toBeUndefined();
    await expect(access(join(captureDir, "transcript.segments.jsonl"))).resolves.toBeUndefined();
    await expect(access(join(captureDir, "comments.scored.jsonl"))).resolves.toBeUndefined();
    await expect(access(join(captureDir, "raw", "transcript.txt"))).resolves.toBeUndefined();
    await expect(access(manifest.derived.files.transcript_normalized)).resolves.toBeUndefined();
    expect(manifest.derived.files.transcript_normalized).toBe(join(captureDir, "transcript.normalized.txt"));
  });
});
