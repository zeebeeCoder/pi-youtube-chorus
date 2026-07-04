import { join, resolve } from "node:path";

export interface CaptureInvocationOptions {
  videoUrl: string;
  cwd: string;
  outputDir?: string;
  maxComments?: number;
  maxWords?: number;
  ytMcpDir?: string;
  envFile?: string;
  configDir?: string;
  skipTranscript?: boolean;
  skipComments?: boolean;
  now?: Date;
}

export interface CommandInvocation {
  command: string;
  args: string[];
  outputDir: string;
  videoId: string;
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  originalChars: number;
  emittedChars: number;
}

export interface TranscriptSegment {
  index: number;
  startMs?: number;
  durationMs?: number;
  text: string;
  speakerChange?: boolean;
}

export interface NormalizedTranscript {
  text: string;
  segments: TranscriptSegment[];
  sourceFormat: "plain-text" | "youtube-timedtext-json";
  warnings: string[];
}

export interface RawCommentRecord {
  index?: number;
  comment?: string;
  text?: string;
  content?: string;
  user_name?: string;
  author?: string;
  date?: string;
  like_count?: number;
  likes?: number;
  replies?: unknown[];
}

export interface ScoredComment {
  sourceIndex: number;
  author?: string;
  date?: string;
  dateMs?: number;
  text: string;
  likeCount: number;
  replyCount: number;
  wordCount: number;
  replies: unknown[];
  recencyScore: number;
  engagementScore: number;
  balancedScore: number;
  spamLikely: boolean;
  spamReasons: string[];
  replySpamCount: number;
}

export interface CommentCluster {
  id: string;
  label: string;
  commentCount: number;
  topTerms: string[];
  representativeSourceIndices: number[];
  representativeQuotes: string[];
  score: number;
}

export interface CommentAnalysis {
  comments: ScoredComment[];
  clusters: CommentCluster[];
  totalCount: number;
  likelySpamCount: number;
  generatedAt: string;
}

export type CommentsFormat = "markdown" | "jsonl" | "json" | "ranked-markdown" | "ranked-jsonl";
export type CommentSort = "source" | "recency" | "engagement" | "balanced";

export interface CommentContextOptions {
  format: CommentsFormat;
  sort: CommentSort;
  maxComments: number;
  includeReplies: boolean;
  includeLikelySpam: boolean;
}

export const DEFAULT_SYNTHESIS_PROMPT = [
  "Synthesize a unified perspective from the speaker transcript and audience comments.",
  "Separate speaker claims from commenter claims.",
  "Focus on claims, evidence, consensus, dissent, notable user insights, blind spots, and follow-up questions.",
  "Treat comments as signal, not truth, and mention truncation or sampling limits.",
].join(" ");

export const DEFAULT_TRANSCRIPT_INSTRUCTIONS =
  "Use the transcript as the speaker layer: thesis, structure, evidence, examples, named entities, numbers, and caveats.";

export const DEFAULT_COMMENTS_INSTRUCTIONS =
  "Use comments as the audience layer: agreement, dissent, corrections, lived experience, repeated questions, spam/noise, and practical objections.";

export function extractVideoId(input: string): string {
  const clean = input.replace(/\\([?&=])/g, "$1");

  if (/^[0-9A-Za-z_-]{11}$/.test(clean)) return clean;

  const patterns = [
    /[?&]v=([0-9A-Za-z_-]{11})/,
    /youtu\.be\/([0-9A-Za-z_-]{11})/,
    /youtube\.com\/(?:embed|shorts|live)\/([0-9A-Za-z_-]{11})/,
    /youtube\.com\/watch\/([0-9A-Za-z_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match?.[1]) return match[1];
  }

  throw new Error(`Could not extract YouTube video id from: ${input}`);
}

export function safeTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function defaultOutputDir(cwd: string, videoUrl: string, now: Date = new Date()): string {
  const videoId = extractVideoId(videoUrl);
  return join(cwd, ".pi", "youtube-chorus", `${safeTimestamp(now)}-${videoId}`);
}

export function buildCaptureInvocation(options: CaptureInvocationOptions): CommandInvocation {
  const videoId = extractVideoId(options.videoUrl);
  const outputDir = resolve(
    options.cwd,
    options.outputDir ?? defaultOutputDir(options.cwd, options.videoUrl, options.now)
  );

  const captureArgs = [options.videoUrl, "--output-dir", outputDir];

  if (options.maxComments !== undefined) captureArgs.push("--max-comments", String(options.maxComments));
  if (options.maxWords !== undefined) captureArgs.push("--max-words", String(options.maxWords));
  if (options.envFile) captureArgs.push("--env-file", options.envFile);
  if (options.configDir) captureArgs.push("--config-dir", options.configDir);
  if (options.skipTranscript) captureArgs.push("--no-transcript");
  if (options.skipComments) captureArgs.push("--no-comments");

  if (options.ytMcpDir) {
    return {
      command: "uv",
      args: ["run", "--project", options.ytMcpDir, "yt-capture", ...captureArgs],
      outputDir,
      videoId,
    };
  }

  return {
    command: "yt-capture",
    args: captureArgs,
    outputDir,
    videoId,
  };
}

export function captureDirectoryCandidates(stdout: string): string[] {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const candidates: string[] = [];

  for (const line of [...lines].reverse()) {
    const labelled = line.match(/(?:capture\s+directory|directory|output\s+dir|output)\s*[:=]\s*(.+)$/i)?.[1];
    const barePath = labelled ?? line;
    const pathMatch = barePath.match(/((?:\.|~|\/)?[^\s]*youtube-chorus[^\s]*|(?:\.|\/)[^\s]+|[0-9T:-]+Z-[0-9A-Za-z_-]{11})/);
    if (pathMatch?.[1]) candidates.push(pathMatch[1].replace(/^['"]|['"]$/g, ""));
  }

  return [...new Set(candidates)];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatTimestamp(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "00:00";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours <= 0) return `${mm}:${ss}`;
  return `${hours}:${mm}:${ss}`;
}

export function formatTranscriptSegments(segments: TranscriptSegment[], bucketMs = 60_000): string {
  if (segments.length === 0) return "";

  const buckets: Array<{ startMs?: number; texts: string[] }> = [];
  let current: { startMs?: number; texts: string[] } | undefined;

  for (const segment of segments) {
    const segmentStart = segment.startMs ?? current?.startMs ?? 0;
    const shouldStartBucket =
      !current ||
      (segment.startMs !== undefined && current.startMs !== undefined && segment.startMs - current.startMs >= bucketMs);

    if (shouldStartBucket) {
      current = { startMs: segmentStart, texts: [] };
      buckets.push(current);
    }

    if (!current) continue;
    const text = segment.speakerChange && !segment.text.startsWith(">>") ? `>> ${segment.text}` : segment.text;
    current.texts.push(text);
  }

  return buckets
    .map((bucket) => `[${formatTimestamp(bucket.startMs)}] ${normalizeWhitespace(bucket.texts.join(" "))}`)
    .join("\n\n");
}

export function normalizeTranscript(raw: string): NormalizedTranscript {
  const warnings: string[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return { text: "", segments: [], sourceFormat: "plain-text", warnings };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.events)) {
      const segments: TranscriptSegment[] = [];
      for (const event of parsed.events) {
        if (!isRecord(event) || !Array.isArray(event.segs)) continue;
        const text = normalizeWhitespace(
          event.segs
            .filter(isRecord)
            .map((seg) => (typeof seg.utf8 === "string" ? seg.utf8 : ""))
            .join("")
            .replace(/\n/g, " ")
        );
        if (!text) continue;

        segments.push({
          index: segments.length + 1,
          startMs: numberOrUndefined(event.tStartMs),
          durationMs: numberOrUndefined(event.dDurationMs),
          text,
          speakerChange: event.segs.filter(isRecord).some((seg) => Boolean(seg.isSpeakerChange)),
        });
      }

      return {
        text: formatTranscriptSegments(segments),
        segments,
        sourceFormat: "youtube-timedtext-json",
        warnings,
      };
    }
  } catch {
    // Plain text transcript. Leave it alone except for outer whitespace.
  }

  return {
    text: trimmed,
    segments: [{ index: 1, text: trimmed }],
    sourceFormat: "plain-text",
    warnings,
  };
}

export function transcriptSegmentsToJsonl(segments: TranscriptSegment[]): string {
  return segments.map((segment) => JSON.stringify(segment)).join("\n") + (segments.length ? "\n" : "");
}

export function truncateText(text: string, maxChars: number, label: string): TruncatedText {
  if (maxChars <= 0) {
    return {
      text: "",
      truncated: text.length > 0,
      originalChars: text.length,
      emittedChars: 0,
    };
  }

  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
      originalChars: text.length,
      emittedChars: text.length,
    };
  }

  const notice = `\n\n[${label} truncated: showing ${maxChars} of ${text.length} characters. Use artifact paths or a smaller chunk request for full data.]`;
  const emitted = (text.slice(0, Math.max(0, maxChars - notice.length)) + notice).slice(0, maxChars);

  return {
    text: emitted,
    truncated: true,
    originalChars: text.length,
    emittedChars: emitted.length,
  };
}

function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

function commentText(comment: RawCommentRecord): string {
  return comment.comment ?? comment.text ?? comment.content ?? "";
}

function commentAuthor(comment: RawCommentRecord): string | undefined {
  return comment.user_name ?? comment.author;
}

function commentLikes(comment: RawCommentRecord): number {
  const value = comment.like_count ?? comment.likes ?? 0;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function detectLikelySpam(text: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/\b(?:whats\s*app|telegram|tlgrm|dm me|contact me)\b/i, "contact-channel"],
    [/spiritual counselor|bring back (?:your )?ex/i, "relationship-spell"],
    [/\b(?:guaranteed|risk-free)\b.*\b(?:profit|returns?|roi)\b/i, "return-guarantee"],
    [/\$\d+[\dkm,.]*\s*(?:roi|profit|return)|(?:over|made)\s+\$\d+[\dkm,.]*\s+in\s+(?:weeks?|months?)/i, "implausible-returns"],
  ];

  return checks.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason);
}

function replyText(reply: unknown): string {
  if (typeof reply === "string") return reply;
  if (!isRecord(reply)) return "";
  return typeof reply.comment === "string"
    ? reply.comment
    : typeof reply.text === "string"
      ? reply.text
      : typeof reply.content === "string"
        ? reply.content
        : "";
}

export function parseCommentsJson(raw: string): RawCommentRecord[] {
  const parsed = JSON.parse(raw) as unknown;
  const comments = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.comments)
      ? parsed.comments
      : [];

  return comments.filter(isRecord) as RawCommentRecord[];
}

export function scoreComments(records: RawCommentRecord[], now: Date = new Date()): ScoredComment[] {
  const withDates = records.map((record, i) => {
    const text = normalizeWhitespace(commentText(record));
    const dateMs = record.date ? Date.parse(record.date) : Number.NaN;
    const replies = Array.isArray(record.replies) ? record.replies : [];
    const spamReasons = detectLikelySpam(text);
    const replySpamCount = replies.filter((reply) => detectLikelySpam(replyText(reply)).length > 0).length;
    return {
      sourceIndex: record.index ?? i + 1,
      author: commentAuthor(record),
      date: record.date,
      dateMs: Number.isFinite(dateMs) ? dateMs : undefined,
      text,
      likeCount: commentLikes(record),
      replyCount: replies.length,
      wordCount: wordCount(text),
      replies,
      recencyScore: 0,
      engagementScore: 0,
      balancedScore: 0,
      spamLikely: spamReasons.length > 0,
      spamReasons,
      replySpamCount,
    } satisfies ScoredComment;
  });

  const validDates = withDates.map((comment) => comment.dateMs).filter((value): value is number => value !== undefined);
  const newest = validDates.length ? Math.max(...validDates) : now.getTime();
  const oldest = validDates.length ? Math.min(...validDates) : newest;
  const dateRange = Math.max(1, newest - oldest);

  const maxEngagement = Math.max(
    1,
    ...withDates.map((comment) => Math.log1p(comment.likeCount) + 0.6 * Math.log1p(comment.replyCount))
  );

  return withDates.map((comment) => {
    const rawEngagement = Math.log1p(comment.likeCount) + 0.6 * Math.log1p(comment.replyCount);
    const recencyScore = comment.dateMs === undefined ? 0 : (comment.dateMs - oldest) / dateRange;
    const engagementScore = rawEngagement / maxEngagement;
    const depthScore = Math.min(1, comment.wordCount / 80);
    const spamPenalty = comment.spamLikely ? 0.55 : 0;
    const balancedScore = Math.max(0, 0.45 * engagementScore + 0.25 * recencyScore + 0.2 * depthScore - spamPenalty);
    return { ...comment, recencyScore, engagementScore, balancedScore };
  });
}

export function sortScoredComments(comments: ScoredComment[], sort: CommentSort): ScoredComment[] {
  const sorted = [...comments];
  sorted.sort((a, b) => {
    if (sort === "source") return a.sourceIndex - b.sourceIndex;
    if (sort === "recency") return (b.recencyScore - a.recencyScore) || (a.sourceIndex - b.sourceIndex);
    if (sort === "engagement") return (b.engagementScore - a.engagementScore) || (a.sourceIndex - b.sourceIndex);
    return (b.balancedScore - a.balancedScore) || (a.sourceIndex - b.sourceIndex);
  });
  return sorted;
}

const STOP_WORDS = new Set([
  "about", "after", "again", "against", "all", "also", "and", "any", "are", "because", "been", "before",
  "being", "but", "can", "cant", "could", "did", "does", "doing", "dont", "down", "each", "even", "from",
  "get", "got", "had", "has", "have", "having", "here", "how", "into", "its", "just", "like", "more",
  "most", "much", "need", "not", "now", "off", "only", "our", "out", "over", "people", "really", "same",
  "say", "see", "she", "should", "some", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "thing", "this", "those", "through", "time", "too", "use", "very", "was", "way", "what", "when",
  "where", "which", "who", "why", "will", "with", "would", "you", "your", "youre", "money", "video",
]);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])
    .map((token) => token.replace(/^'+|'+$/g, ""))
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function tokenSet(text: string): Set<string> {
  return new Set(tokens(text));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function topTermsFor(comments: ScoredComment[], maxTerms = 4): string[] {
  const counts = new Map<string, number>();
  for (const comment of comments) {
    for (const token of tokens(comment.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([term]) => term);
}

export function clusterComments(comments: ScoredComment[], maxClusters = 8): CommentCluster[] {
  const candidates = sortScoredComments(
    comments.filter((comment) => !comment.spamLikely && tokenSet(comment.text).size >= 3),
    "balanced"
  );
  const sets = new Map<number, Set<string>>(candidates.map((comment) => [comment.sourceIndex, tokenSet(comment.text)]));
  const assigned = new Set<number>();
  const clusters: CommentCluster[] = [];

  for (const seed of candidates) {
    if (assigned.has(seed.sourceIndex) || clusters.length >= maxClusters) continue;
    const seedTokens = sets.get(seed.sourceIndex) ?? new Set<string>();
    const members = [seed];
    assigned.add(seed.sourceIndex);

    for (const candidate of candidates) {
      if (assigned.has(candidate.sourceIndex)) continue;
      const similarity = jaccard(seedTokens, sets.get(candidate.sourceIndex) ?? new Set<string>());
      if (similarity >= 0.14) {
        members.push(candidate);
        assigned.add(candidate.sourceIndex);
      }
    }

    if (members.length < 2) continue;
    const terms = topTermsFor(members, 4);
    clusters.push({
      id: `cluster-${clusters.length + 1}`,
      label: terms.slice(0, 3).join(" / ") || "comment cluster",
      commentCount: members.length,
      topTerms: terms,
      representativeSourceIndices: members.slice(0, 5).map((comment) => comment.sourceIndex),
      representativeQuotes: members.slice(0, 3).map((comment) => comment.text.slice(0, 220)),
      score: members.reduce((sum, comment) => sum + comment.balancedScore, 0) / members.length,
    });
  }

  return clusters.sort((a, b) => (b.commentCount - a.commentCount) || (b.score - a.score));
}

export function analyzeComments(records: RawCommentRecord[], now: Date = new Date()): CommentAnalysis {
  const comments = scoreComments(records, now);
  return {
    comments,
    clusters: clusterComments(comments),
    totalCount: comments.length,
    likelySpamCount: comments.filter((comment) => comment.spamLikely).length,
    generatedAt: now.toISOString(),
  };
}

function selectedComments(comments: ScoredComment[], options: CommentContextOptions): ScoredComment[] {
  const filtered = options.includeLikelySpam ? comments : comments.filter((comment) => !comment.spamLikely);
  const sorted = sortScoredComments(filtered, options.sort);
  return options.maxComments <= 0 ? [] : sorted.slice(0, options.maxComments);
}

function canonicalComment(comment: ScoredComment, rank: number, includeReplies: boolean): Record<string, unknown> {
  return {
    rank,
    source_index: comment.sourceIndex,
    author: comment.author,
    date: comment.date,
    like_count: comment.likeCount,
    reply_count: comment.replyCount,
    word_count: comment.wordCount,
    scores: {
      recency: Number(comment.recencyScore.toFixed(3)),
      engagement: Number(comment.engagementScore.toFixed(3)),
      balanced: Number(comment.balancedScore.toFixed(3)),
    },
    spam_likely: comment.spamLikely,
    spam_reasons: comment.spamReasons,
    reply_spam_count: comment.replySpamCount,
    comment: comment.text,
    ...(includeReplies ? { replies: comment.replies } : {}),
  };
}

export function buildRankedCommentsJsonl(comments: ScoredComment[], options: CommentContextOptions): string {
  return selectedComments(comments, options)
    .map((comment, index) => JSON.stringify(canonicalComment(comment, index + 1, options.includeReplies)))
    .join("\n");
}

export function buildRankedCommentsMarkdown(comments: ScoredComment[], options: CommentContextOptions): string {
  const selected = selectedComments(comments, options);
  const lines = [
    "# Ranked YouTube Comments",
    "",
    `Selection: ${selected.length} comments, sort=${options.sort}, includeReplies=${options.includeReplies}, includeLikelySpam=${options.includeLikelySpam}`,
  ];

  selected.forEach((comment, index) => {
    lines.push(
      "",
      `## Ranked Comment ${index + 1} (source #${comment.sourceIndex})`,
      "",
      `- Author: ${comment.author ?? "unknown"}`,
      `- Date: ${comment.date ?? "unknown"}`,
      `- Likes: ${comment.likeCount}`,
      `- Replies: ${comment.replyCount}`,
      `- Scores: recency=${comment.recencyScore.toFixed(3)}, engagement=${comment.engagementScore.toFixed(3)}, balanced=${comment.balancedScore.toFixed(3)}`,
      `- Spam likely: ${comment.spamLikely ? `yes (${comment.spamReasons.join(", ")})` : "no"}`,
      "",
      comment.text
    );

    if (options.includeReplies && comment.replies.length > 0) {
      lines.push("", "Replies:");
      comment.replies.forEach((reply, replyIndex) => lines.push(`${replyIndex + 1}. ${replyText(reply) || JSON.stringify(reply)}`));
    }
  });

  return lines.join("\n");
}

export function formatCommentSignals(analysis: CommentAnalysis, options: CommentContextOptions): string {
  const selected = selectedComments(analysis.comments, options);
  const lines = [
    `- Total comments captured: ${analysis.totalCount}`,
    `- Likely spam/promotional comments: ${analysis.likelySpamCount}`,
    `- Context selection: ${selected.length} comments, sort=${options.sort}, includeReplies=${options.includeReplies}, includeLikelySpam=${options.includeLikelySpam}`,
  ];

  if (analysis.clusters.length > 0) {
    lines.push("- Lightweight lexical clusters:");
    for (const cluster of analysis.clusters.slice(0, 8)) {
      lines.push(
        `  - ${cluster.label}: ${cluster.commentCount} comments; representatives=${cluster.representativeSourceIndices.join(", ")}; terms=${cluster.topTerms.join(", ")}`
      );
    }
  }

  return lines.join("\n");
}

export interface ContextPackInput {
  title?: string;
  videoId?: string;
  url?: string;
  channel?: string;
  capturedAt?: string;
  captureDir: string;
  transcript?: string;
  comments?: string;
  transcriptPath?: string;
  commentsPath?: string;
  transcriptMaxChars: number;
  commentsMaxChars: number;
  includeSynthesisGuidance?: boolean;
  synthesisInstructions?: string;
  transcriptInstructions?: string;
  commentsInstructions?: string;
  commentSignals?: string;
}

export function formatContextPack(input: ContextPackInput): { text: string; details: Record<string, unknown> } {
  const transcript = input.transcript
    ? truncateText(input.transcript, input.transcriptMaxChars, "Transcript")
    : undefined;
  const comments = input.comments
    ? truncateText(input.comments, input.commentsMaxChars, "Comments")
    : undefined;

  const guidanceLines = input.includeSynthesisGuidance === false
    ? []
    : [
        "## Synthesis guidance",
        "",
        `- Default: ${DEFAULT_SYNTHESIS_PROMPT}`,
        `- Transcript: ${input.transcriptInstructions ?? DEFAULT_TRANSCRIPT_INSTRUCTIONS}`,
        `- Comments: ${input.commentsInstructions ?? DEFAULT_COMMENTS_INSTRUCTIONS}`,
        ...(input.synthesisInstructions ? [`- User/custom: ${input.synthesisInstructions}`] : []),
        "",
      ];

  const signalLines = input.commentSignals
    ? ["## Comment signals", "", input.commentSignals, ""]
    : [];

  const lines = [
    "# YouTube Chorus Context Pack",
    "",
    "## Metadata",
    "",
    `- Title: ${input.title ?? "unknown"}`,
    `- Video ID: ${input.videoId ?? "unknown"}`,
    `- URL: ${input.url ?? "unknown"}`,
    `- Channel: ${input.channel ?? "unknown"}`,
    `- Captured at: ${input.capturedAt ?? "unknown"}`,
    `- Capture directory: ${input.captureDir}`,
    "",
    ...guidanceLines,
    ...signalLines,
    "## Transcript",
    "",
    input.transcriptPath ? `Source: ${input.transcriptPath}` : "Source: not available",
    "",
    transcript?.text ?? "Transcript not available or not requested.",
    "",
    "## Comments",
    "",
    input.commentsPath ? `Source: ${input.commentsPath}` : "Source: not available",
    "",
    comments?.text ?? "Comments not available or not requested.",
  ];

  return {
    text: lines.join("\n"),
    details: {
      captureDir: input.captureDir,
      transcriptPath: input.transcriptPath,
      commentsPath: input.commentsPath,
      transcriptTruncated: transcript?.truncated ?? false,
      commentsTruncated: comments?.truncated ?? false,
      transcriptOriginalChars: transcript?.originalChars ?? 0,
      commentsOriginalChars: comments?.originalChars ?? 0,
      transcriptEmittedChars: transcript?.emittedChars ?? 0,
      commentsEmittedChars: comments?.emittedChars ?? 0,
      includeSynthesisGuidance: input.includeSynthesisGuidance !== false,
    },
  };
}
