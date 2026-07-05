import { describe, expect, it } from "vitest";
import {
  applyCommentBudget,
  buildCaptureManifest,
  buildYtDlpTranscriptPlan,
  captionCandidateFromPath,
  classifyRetry,
  envFileCandidates,
  formatBundleMarkdown,
  formatCommentsJson,
  formatCommentsJsonl,
  formatCommentsMarkdown,
  parseCaptionTranscript,
  parseEnvFile,
  parseYoutubeDataApiCommentsPage,
  parseYoutubeDataApiVideoMetadata,
  parseYtDlpJsonMetadata,
  selectCaptionFile,
  shouldContinueCommentsPagination,
  type CaptionCandidate,
  type Comment,
  type TranscriptResult,
  type VideoMetadata,
} from "./extractor-logic.js";

const json3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
    { tStartMs: 65_000, dDurationMs: 1200, segs: [{ utf8: "Next cue" }] },
  ],
});

function candidate(path: string, source: "manual" | "automatic"): CaptionCandidate {
  const parsed = captionCandidateFromPath(path, source);
  if (!parsed) throw new Error(`bad test candidate: ${path}`);
  return parsed;
}

const comment = (index: number, text: string): Comment => ({
  index,
  author: `user-${index}`,
  date: "2026-07-04T00:00:00Z",
  like_count: index,
  comment: text,
  reply_count: 0,
  replies: [],
});

describe("native extractor pure core", () => {
  it("builds a two-pass preferred-language transcript plan, then widened retry", () => {
    const plan = buildYtDlpTranscriptPlan({
      videoUrl: "https://youtu.be/dQw4w9WgXcQ",
      outputDir: "/tmp/capture",
    });

    expect(plan.map((step) => step.phase)).toEqual(["manual", "automatic", "manual", "automatic"]);
    expect(plan[0].args).toContain("--write-subs");
    expect(plan[1].args).toContain("--write-auto-subs");
    expect(plan[0].args).toContain("en,en-US,en-GB");
    expect(plan[2].args).toContain("en.*,en");
    expect(plan[0].args).toContain("json3/vtt");
    expect(plan[0].args).toContain("/tmp/capture/%(id)s.%(language)s.%(ext)s");
  });

  it("selects captions by preferred language group, then manual over auto, then json3 over vtt", () => {
    const selected = selectCaptionFile([
      candidate("/tmp/video.de.json3", "manual"),
      candidate("/tmp/video.en.vtt", "manual"),
      candidate("/tmp/video.en.json3", "automatic"),
      candidate("/tmp/video.en-GB.json3", "manual"),
    ]);

    expect(selected).toMatchObject({ path: "/tmp/video.en.vtt", language: "en", source: "manual" });

    const autoPreferredBeatsManualWidened = selectCaptionFile([
      candidate("/tmp/video.de.json3", "manual"),
      candidate("/tmp/video.en.json3", "automatic"),
    ], { widenedLanguages: ["de"] });

    expect(autoPreferredBeatsManualWidened).toMatchObject({ language: "en", source: "automatic" });
  });

  it("parses JSON3 and WebVTT captions into timestamped transcript results", () => {
    const jsonResult = parseCaptionTranscript(json3, candidate("/tmp/video.en.json3", "manual"));
    expect(jsonResult.ok).toBe(true);
    if (jsonResult.ok) {
      expect(jsonResult.value.source).toBe("yt-dlp-json3");
      expect(jsonResult.value.text).toContain("[00:00] Hello world");
      expect(jsonResult.value.segments).toHaveLength(2);
    }

    const vtt = [
      "WEBVTT",
      "",
      "cue-1",
      "00:00:01.000 --> 00:00:03.500",
      "<c>Hello &amp; welcome</c>",
      "",
      "00:01:02.000 --> 00:01:03.000",
      "Next minute",
      "",
    ].join("\n");
    const vttResult = parseCaptionTranscript(vtt, candidate("/tmp/video.en.vtt", "automatic"));
    expect(vttResult.ok).toBe(true);
    if (vttResult.ok) {
      expect(vttResult.value.source).toBe("yt-dlp-webvtt");
      expect(vttResult.value.isAutomatic).toBe(true);
      expect(vttResult.value.text).toContain("[00:01] Hello & welcome");
      expect(vttResult.value.text).toContain("[01:02] Next minute");
    }
  });

  it("applies comment and word budgets before continuing pagination", () => {
    const first = applyCommentBudget([comment(1, "one two"), comment(2, "three four")], {
      maxComments: 3,
      maxWords: 10,
      nextPageToken: "page-2",
    });
    expect(shouldContinueCommentsPagination(first)).toBe(true);
    expect(first.accepted).toHaveLength(2);

    const second = applyCommentBudget([comment(3, "five six"), comment(4, "seven eight")], {
      maxComments: 3,
      maxWords: 10,
      currentComments: first.accepted,
      currentWordCount: first.acceptedWordCount,
      nextPageToken: "page-3",
    });
    expect(second.stopReason).toBe("budget");
    expect(second.budgetKind).toBe("comments");
    expect(second.accepted.map((item) => item.index)).toEqual([1, 2, 3]);

    const wordLimited = applyCommentBudget([comment(1, "one two three"), comment(2, "four five")], {
      maxComments: 10,
      maxWords: 4,
      nextPageToken: "page-2",
    });
    expect(wordLimited.stopReason).toBe("budget");
    expect(wordLimited.budgetKind).toBe("words");
    expect(wordLimited.accepted.map((item) => item.index)).toEqual([1]);
  });

  it("classifies retryable and permanent YouTube API failures", () => {
    expect(classifyRetry({ status: 503, attempt: 1, maxAttempts: 3 })).toEqual({
      retry: true,
      retryable: true,
      reason: "transient-http-status:503",
    });
    expect(classifyRetry({ status: 404, attempt: 1, maxAttempts: 3 }).retry).toBe(false);
    expect(classifyRetry({ status: 403, reason: "quotaExceeded", attempt: 1, maxAttempts: 3 })).toEqual({
      retry: false,
      retryable: false,
      reason: "permanent-api-reason:quotaExceeded",
    });
    expect(classifyRetry({ reason: "rateLimitExceeded", attempt: 3, maxAttempts: 3 })).toEqual({
      retry: false,
      retryable: true,
      reason: "transient-api-reason:rateLimitExceeded",
    });
  });

  it("orders env-file candidates and parses dotenv without logging secrets", () => {
    expect(
      envFileCandidates({ cwd: "/repo", homeDir: "/home/me", envFile: "secrets/.env", configDir: "cfg" })
    ).toEqual([
      "/repo/secrets/.env",
      "/repo/cfg/.env",
      "/repo/.env",
      "/home/me/.config/pi-youtube-chorus/.env",
      "/home/me/.config/yt-mcp/.env",
    ]);

    expect(envFileCandidates({ cwd: "/repo", homeDir: "/home/me", envFile: "~/.keys/youtube.env" })[0]).toBe(
      "/home/me/.keys/youtube.env"
    );

    expect(parseEnvFile("# comment\nexport YOUTUBE_API_KEY='abc123'\nOTHER=value # local\n")).toEqual({
      YOUTUBE_API_KEY: "abc123",
      OTHER: "value",
    });
  });

  it("guards YouTube Data API metadata and comments response shapes", () => {
    const metadata = parseYoutubeDataApiVideoMetadata(
      {
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
      },
      "https://youtu.be/dQw4w9WgXcQ"
    );
    expect(metadata.ok).toBe(true);
    if (metadata.ok) expect(metadata.value).toMatchObject({ title: "Demo", source: "youtube-data-api" });

    const comments = parseYoutubeDataApiCommentsPage(
      {
        nextPageToken: "next",
        pageInfo: { resultsPerPage: 1 },
        items: [
          {
            id: "thread-1",
            snippet: {
              totalReplyCount: 1,
              topLevelComment: {
                id: "comment-1",
                snippet: {
                  authorDisplayName: "Alice",
                  authorChannelId: { value: "alice-channel" },
                  textOriginal: "Useful comment",
                  publishedAt: "2026-07-04T00:00:00Z",
                  likeCount: 2,
                },
              },
            },
            replies: {
              comments: [
                {
                  id: "reply-1",
                  snippet: {
                    authorDisplayName: "Bob",
                    textOriginal: "I agree",
                    publishedAt: "2026-07-04T01:00:00Z",
                    likeCount: 1,
                  },
                },
              ],
            },
          },
        ],
      },
      7
    );

    expect(comments.ok).toBe(true);
    if (comments.ok) {
      expect(comments.value.nextPageToken).toBe("next");
      expect(comments.value.comments[0]).toMatchObject({ index: 7, author: "Alice", reply_count: 1 });
      expect(comments.value.comments[0].replies[0]).toMatchObject({ author: "Bob", comment: "I agree" });
    }

    expect(parseYoutubeDataApiVideoMetadata({ items: [] }, "url")).toMatchObject({
      ok: false,
      error: { code: "video-not-found", retryable: false },
    });
  });

  it("guards yt-dlp -J metadata for keyless transcript-only mode", () => {
    const metadata = parseYtDlpJsonMetadata(
      { id: "dQw4w9WgXcQ", title: "Demo", uploader: "Demo Channel", upload_date: "20260704" },
      "https://youtu.be/dQw4w9WgXcQ"
    );

    expect(metadata.ok).toBe(true);
    if (metadata.ok) {
      expect(metadata.value.source).toBe("yt-dlp-json");
      expect(metadata.value.publishedAt).toBe("2026-07-04");
    }
  });

  it("formats v1-compatible writer outputs and native manifest metadata", () => {
    const video: VideoMetadata = {
      videoId: "dQw4w9WgXcQ",
      videoUrl: "https://youtu.be/dQw4w9WgXcQ",
      title: "Demo",
      channel: "Demo Channel",
      source: "youtube-data-api",
    };
    const transcript: TranscriptResult = {
      status: "available",
      source: "yt-dlp-json3",
      language: "en",
      isAutomatic: false,
      filePath: "/capture/transcript.txt",
      text: "[00:00] Hello world",
      segments: [{ index: 1, startMs: 0, durationMs: 1000, text: "Hello world" }],
      warnings: [],
    };
    const comments = [comment(1, "Useful comment")];

    expect(formatCommentsJson(comments)).toContain('"comments"');
    expect(formatCommentsJsonl(comments)).toContain('"index":1');
    expect(formatCommentsMarkdown(comments)).toContain("## Comment 1");
    expect(formatBundleMarkdown({ video, transcript, comments })).toContain("# Demo");

    const manifest = buildCaptureManifest({
      capturedAt: "2026-07-04T00:00:00Z",
      video,
      outputDir: "/capture",
      files: { metadata: "/capture/metadata.json", transcript_text: "/capture/transcript.txt" },
      transcript,
      comments: { accepted: comments, acceptedWordCount: 2, stopReason: "pages-exhausted" },
      ytDlpVersion: "2026.07.04",
    });

    expect(manifest).toMatchObject({
      captured_at: "2026-07-04T00:00:00Z",
      video_id: "dQw4w9WgXcQ",
      extractor: "native",
      yt_dlp_version: "2026.07.04",
      stats: {
        transcript_status: "available",
        transcript_segment_count: 1,
        comment_count: 1,
        comment_stop_reason: "pages-exhausted",
      },
    });
  });
});
