import { describe, expect, it } from "vitest";
import {
  analyzeComments,
  buildCaptureInvocation,
  buildRankedCommentsJsonl,
  captureDirectoryCandidates,
  clusterComments,
  defaultOutputDir,
  extractVideoId,
  formatCommentSignals,
  formatContextPack,
  formatTimestamp,
  normalizeTranscript,
  parseCommentsJson,
  scoreComments,
  sortScoredComments,
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
  it("formats timestamps for minute and hour-long transcript positions", () => {
    expect(formatTimestamp(undefined)).toBe("00:00");
    expect(formatTimestamp(61_000)).toBe("01:01");
    expect(formatTimestamp(3_661_000)).toBe("1:01:01");
  });

  it("turns YouTube timedtext JSON into readable timestamped text and segments", () => {
    const normalized = normalizeTranscript(timedText);
    expect(normalized.sourceFormat).toBe("youtube-timedtext-json");
    expect(normalized.segments).toHaveLength(2);
    expect(normalized.text).toContain("[00:00] Hello world");
    expect(normalized.text).toContain("[01:01]");
  });
});

describe("comment analysis", () => {
  it("parses comment arrays and extractor comment envelopes", () => {
    expect(parseCommentsJson(JSON.stringify([{ index: 1, comment: "array shape" }]))).toEqual([
      { index: 1, comment: "array shape" },
    ]);
    expect(parseCommentsJson(JSON.stringify({ comments: [{ index: 2, comment: "envelope shape" }] }))).toEqual([
      { index: 2, comment: "envelope shape" },
    ]);
    expect(parseCommentsJson(JSON.stringify({ unexpected: [] }))).toEqual([]);
  });

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

  it("clusters repeated lexical themes while excluding likely spam", () => {
    const scored = scoreComments(
      [
        { index: 1, comment: "coffee future cost inflation years", date: "2026-07-01T00:00:00Z", like_count: 2, replies: [] },
        { index: 2, comment: "coffee cost rises with inflation years", date: "2026-07-01T00:00:00Z", like_count: 1, replies: [] },
        { index: 3, comment: "index funds retirement investing plan", date: "2026-07-01T00:00:00Z", like_count: 4, replies: [] },
        { index: 4, comment: "retirement investing plan with index funds", date: "2026-07-01T00:00:00Z", like_count: 3, replies: [] },
        { index: 5, comment: "contact me on telegram for guaranteed ROI", date: "2026-07-01T00:00:00Z", like_count: 100, replies: [] },
      ],
      new Date("2026-07-04T00:00:00Z")
    );

    const clusters = clusterComments(scored);

    expect(clusters).toHaveLength(2);
    expect(clusters.some((cluster) => cluster.topTerms.includes("coffee"))).toBe(true);
    expect(clusters.some((cluster) => cluster.topTerms.includes("index"))).toBe(true);
    expect(clusters.flatMap((cluster) => cluster.representativeSourceIndices)).not.toContain(5);
  });

  it("sorts scored comments by source, recency, engagement, and balanced modes", () => {
    const scored = scoreComments(
      [
        { index: 1, comment: "older engaged comment with enough words to carry some depth", date: "2026-07-01T00:00:00Z", like_count: 10, replies: [] },
        { index: 2, comment: "newest", date: "2026-07-03T00:00:00Z", like_count: 0, replies: [] },
        { index: 3, comment: "middle but highly replied", date: "2026-07-02T00:00:00Z", like_count: 1, replies: ["a", "b", "c"] },
      ],
      new Date("2026-07-04T00:00:00Z")
    );

    expect(sortScoredComments(scored, "source").map((comment) => comment.sourceIndex)).toEqual([1, 2, 3]);
    expect(sortScoredComments(scored, "recency").map((comment) => comment.sourceIndex)).toEqual([2, 3, 1]);
    expect(sortScoredComments(scored, "engagement")[0].sourceIndex).toBe(1);
    expect(sortScoredComments(scored, "balanced")[0].sourceIndex).toBe(1);
  });

  it("formats comment signals with selection, spam, and cluster summaries", () => {
    const analysis = analyzeComments(
      [
        { index: 1, comment: "coffee future cost inflation years", date: "2026-07-01T00:00:00Z", like_count: 2, replies: [] },
        { index: 2, comment: "coffee cost rises with inflation years", date: "2026-07-01T00:00:00Z", like_count: 1, replies: [] },
        { index: 3, comment: "contact me on telegram for guaranteed ROI", date: "2026-07-01T00:00:00Z", like_count: 100, replies: [] },
      ],
      new Date("2026-07-04T00:00:00Z")
    );

    const signals = formatCommentSignals(analysis, {
      format: "ranked-markdown",
      sort: "balanced",
      maxComments: 2,
      includeReplies: true,
      includeLikelySpam: false,
    });

    expect(signals).toContain("Total comments captured: 3");
    expect(signals).toContain("Likely spam/promotional comments: 1");
    expect(signals).toContain("Context selection: 2 comments");
    expect(signals).toContain("coffee");
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
    const tiny = truncateText("abcdef", 4, "Transcript");
    expect(tiny.truncated).toBe(true);
    expect(tiny.text).toBe("abcd");
    expect(tiny.emittedChars).toBe(4);

    const compact = truncateText("a".repeat(100), 40, "Transcript");
    expect(compact.truncated).toBe(true);
    expect(compact.text).toContain("Transcript truncated");
    expect(compact.text.length).toBeLessThanOrEqual(40);
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

  it("renders explicit omission notices for zero context budgets", () => {
    const pack = formatContextPack({
      title: "Demo",
      captureDir: "/tmp/capture",
      transcript: "speaker text",
      comments: "comment text",
      transcriptPath: "/tmp/capture/transcript.segments.jsonl",
      commentsPath: "/tmp/capture/comments.scored.jsonl",
      transcriptMaxChars: 0,
      commentsMaxChars: 0,
    });

    expect(pack.text).toContain("[Transcript omitted: zero character budget. Full data: /tmp/capture/transcript.segments.jsonl.]");
    expect(pack.text).toContain("[Comments omitted: zero character budget. Full data: /tmp/capture/comments.scored.jsonl.]");
  });
});
