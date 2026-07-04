import { describe, expect, it } from "vitest";
import {
  analyzeComments,
  buildCaptureInvocation,
  buildRankedCommentsJsonl,
  captureDirectoryCandidates,
  defaultOutputDir,
  extractVideoId,
  formatContextPack,
  normalizeTranscript,
  parseCaptureDirectory,
  truncateText,
} from "./chorus-logic.js";

describe("extractVideoId", () => {
  it("extracts standard, short, shorts, and bare ids", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12")).toBe(
      "dQw4w9WgXcQ"
    );
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("rejects non-youtube input", () => {
    expect(() => extractVideoId("https://example.com/video")).toThrow(/Could not extract/);
  });
});

describe("capture invocation", () => {
  it("defaults to yt-capture on PATH", () => {
    const invocation = buildCaptureInvocation({
      videoUrl: "https://youtu.be/dQw4w9WgXcQ",
      cwd: "/tmp/project",
      maxComments: 10,
      maxWords: 500,
      now: new Date("2026-07-04T00:00:00Z"),
    });

    expect(invocation.command).toBe("yt-capture");
    expect(invocation.args).toContain("--output-dir");
    expect(invocation.args).toContain("--max-comments");
    expect(invocation.args).toContain("10");
    expect(invocation.outputDir).toContain(".pi/youtube-chorus/2026-07-04T00-00-00-000Z-dQw4w9WgXcQ");
  });

  it("uses uv project mode when ytMcpDir is supplied", () => {
    const invocation = buildCaptureInvocation({
      videoUrl: "dQw4w9WgXcQ",
      cwd: "/tmp/project",
      outputDir: "captures/demo",
      ytMcpDir: "/repo/yt-mcp",
    });

    expect(invocation.command).toBe("uv");
    expect(invocation.args.slice(0, 4)).toEqual(["run", "--project", "/repo/yt-mcp", "yt-capture"]);
    expect(invocation.outputDir).toBe("/tmp/project/captures/demo");
  });

  it("builds deterministic default output directories", () => {
    expect(
      defaultOutputDir(
        "/tmp/project",
        "https://youtube.com/watch?v=dQw4w9WgXcQ",
        new Date("2026-07-04T12:34:56Z")
      )
    ).toBe("/tmp/project/.pi/youtube-chorus/2026-07-04T12-34-56-000Z-dQw4w9WgXcQ");
  });
});

describe("capture output parsing", () => {
  it("uses the final non-empty stdout line as the capture directory", () => {
    expect(parseCaptureDirectory("table output\n/tmp/yt-capture-abc\n")).toBe("/tmp/yt-capture-abc");
  });

  it("extracts labelled and basename capture directory candidates", () => {
    expect(captureDirectoryCandidates("Capture directory: .pi/youtube-chorus/2026-demo\n")).toEqual([
      ".pi/youtube-chorus/2026-demo",
    ]);
    expect(captureDirectoryCandidates("done\n09-28-45-126Z-EhbC2066PiY\n")).toEqual([
      "09-28-45-126Z-EhbC2066PiY",
    ]);
  });
});

const timedText = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
    { tStartMs: 1000, dDurationMs: 100, segs: [{ utf8: "\n" }] },
    { tStartMs: 61000, dDurationMs: 1000, segs: [{ utf8: "Next" }, { utf8: " minute", isSpeakerChange: 1 }] },
  ],
});

describe("transcript normalization", () => {
  it("turns YouTube timedtext JSON into readable timestamped text and segments", () => {
    const normalized = normalizeTranscript(timedText);
    expect(normalized.sourceFormat).toBe("youtube-timedtext-json");
    expect(normalized.segments).toHaveLength(2);
    expect(normalized.text).toContain("[00:00] Hello world");
    expect(normalized.text).toContain("[01:01]");
  });
});

describe("comment analysis", () => {
  it("scores, ranks, and flags likely spam without losing raw fields", () => {
    const comments = [
      { index: 1, comment: "Useful disagreement about inflation and real returns", date: "2026-07-04T00:00:00Z", like_count: 5, replies: [] },
      { index: 2, comment: "Contact me on Telegram for guaranteed ROI", date: "2026-07-03T00:00:00Z", like_count: 50, replies: [] },
      { index: 3, comment: "Recent practical question", date: "2026-07-05T00:00:00Z", like_count: 1, replies: ["same"] },
    ];

    const analysis = analyzeComments(comments, new Date("2026-07-05T00:00:00Z"));
    expect(analysis.totalCount).toBe(3);
    expect(analysis.likelySpamCount).toBe(1);

    const jsonl = buildRankedCommentsJsonl(analysis.comments, {
      format: "ranked-jsonl",
      sort: "balanced",
      maxComments: 10,
      includeReplies: false,
      includeLikelySpam: false,
    });
    expect(jsonl).toContain('"source_index":1');
    expect(jsonl).not.toContain('"source_index":2');
  });

  it("does not hard-code spam flags for one video's named entities", () => {
    const comments = [
      { index: 1, comment: "The Clardven API was mentioned in another source", date: "2026-07-04T00:00:00Z", like_count: 0, replies: [] },
      { index: 2, comment: "The Manifestation Code by Alexander Pierce is a book I read", date: "2026-07-04T00:00:00Z", like_count: 0, replies: [] },
      { index: 3, comment: "Father Obah was named in the thread", date: "2026-07-04T00:00:00Z", like_count: 0, replies: [] },
    ];

    const analysis = analyzeComments(comments, new Date("2026-07-05T00:00:00Z"));
    expect(analysis.likelySpamCount).toBe(0);
  });
});

describe("context formatting", () => {
  it("truncates long sections without exceeding the requested budget", () => {
    const truncated = truncateText("abcdef", 4, "Transcript");
    expect(truncated.truncated).toBe(true);
    expect(truncated.text.length).toBeLessThanOrEqual(4);
    expect(truncated.emittedChars).toBe(4);
  });

  it("treats zero character budget as no emitted text", () => {
    const truncated = truncateText("abcdef", 0, "Transcript");
    expect(truncated.truncated).toBe(true);
    expect(truncated.text).toBe("");
    expect(truncated.emittedChars).toBe(0);
  });

  it("formats transcript and comments as one context pack", () => {
    const pack = formatContextPack({
      title: "Demo",
      videoId: "dQw4w9WgXcQ",
      url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
      channel: "Demo Channel",
      capturedAt: "2026-07-04T00:00:00Z",
      captureDir: "/tmp/capture",
      transcript: "speaker text",
      comments: "comment text",
      transcriptPath: "/tmp/capture/transcript.txt",
      commentsPath: "/tmp/capture/comments.md",
      transcriptMaxChars: 100,
      commentsMaxChars: 100,
    });

    expect(pack.text).toContain("# YouTube Chorus Context Pack");
    expect(pack.text).toContain("speaker text");
    expect(pack.text).toContain("comment text");
    expect(pack.details.transcriptTruncated).toBe(false);
  });
});
