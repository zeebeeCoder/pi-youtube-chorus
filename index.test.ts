import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
