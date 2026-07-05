import { basename, join, resolve } from "node:path";
import {
  formatTranscriptSegments,
  normalizeTranscript,
  type TranscriptSegment,
} from "./chorus-logic.js";

export type Result<T, E = ExtractorError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface ExtractorError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends ExtractorError>(error: E): Result<never, E> {
  return { ok: false, error };
}

export interface VideoMetadata {
  videoId: string;
  videoUrl: string;
  title: string;
  channel: string;
  channelId?: string;
  publishedAt?: string;
  description?: string;
  thumbnails?: Record<string, unknown>;
  source: "youtube-data-api" | "yt-dlp-json";
}

export interface TranscriptAvailable {
  status: "available";
  source: "yt-dlp-json3" | "yt-dlp-webvtt";
  language: string;
  isAutomatic: boolean;
  filePath: string;
  text: string;
  segments: TranscriptSegment[];
  warnings: string[];
}

export interface TranscriptUnavailable {
  status: "disabled" | "not-found";
  warnings: string[];
}

export interface TranscriptErrored {
  status: "error";
  error: string;
  warnings: string[];
}

export type TranscriptResult = TranscriptAvailable | TranscriptUnavailable | TranscriptErrored;

export interface CommentReply {
  id?: string;
  author?: string;
  authorChannelId?: string;
  date?: string;
  updatedAt?: string;
  like_count: number;
  comment: string;
}

export interface Comment {
  index: number;
  id?: string;
  author?: string;
  authorChannelId?: string;
  date?: string;
  updatedAt?: string;
  like_count: number;
  comment: string;
  reply_count: number;
  replies: CommentReply[];
}

export interface CommentsPage {
  comments: Comment[];
  nextPageToken?: string;
  resultCount: number;
}

export type CommentStopReason = "budget" | "pages-exhausted" | "error";
export type CommentBudgetKind = "comments" | "words";

export interface CommentBudgetState {
  accepted: Comment[];
  acceptedWordCount: number;
  stopReason?: CommentStopReason;
  budgetKind?: CommentBudgetKind;
  nextPageToken?: string;
}

export interface CaptureManifestInput {
  capturedAt: string;
  video: VideoMetadata;
  outputDir: string;
  files: Record<string, string>;
  transcript?: TranscriptResult;
  comments?: CommentBudgetState;
  ytDlpVersion?: string;
  warnings?: string[];
}

export interface YtDlpInvocation {
  command: "yt-dlp";
  args: string[];
  phase: CaptionPhase;
  languages: string[];
  outputTemplate: string;
}

export type CaptionPhase = "manual" | "automatic";
export type CaptionFormat = "json3" | "vtt";
export type CaptionSource = "manual" | "automatic";

export interface YtDlpTranscriptPlanOptions {
  videoUrl: string;
  outputDir: string;
  preferredLanguages?: string[];
  widenedLanguages?: string[];
  formats?: CaptionFormat[];
}

export interface CaptionCandidate {
  path: string;
  language: string;
  format: CaptionFormat;
  source: CaptionSource;
}

export interface CaptionSelectionOptions {
  preferredLanguages?: string[];
  widenedLanguages?: string[];
  formats?: CaptionFormat[];
}

export const DEFAULT_PREFERRED_CAPTION_LANGUAGES = ["en", "en-US", "en-GB"] as const;
export const DEFAULT_WIDENED_CAPTION_LANGUAGES = ["en.*", "en"] as const;
export const DEFAULT_CAPTION_FORMATS = ["json3", "vtt"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function langMatchesPattern(language: string, pattern: string): boolean {
  if (pattern.endsWith(".*")) {
    const base = pattern.slice(0, -2).toLowerCase();
    return language.toLowerCase() === base || language.toLowerCase().startsWith(`${base}-`);
  }
  return language.toLowerCase() === pattern.toLowerCase();
}

function languageRank(language: string, preferredLanguages: string[], widenedLanguages: string[]): number {
  const preferredIndex = preferredLanguages.findIndex((candidate) => langMatchesPattern(language, candidate));
  if (preferredIndex >= 0) return preferredIndex;

  const widenedIndex = widenedLanguages.findIndex((candidate) => langMatchesPattern(language, candidate));
  if (widenedIndex >= 0) return preferredLanguages.length + widenedIndex;

  return preferredLanguages.length + widenedLanguages.length + 100;
}

function captionFormatRank(format: CaptionFormat, formats: CaptionFormat[]): number {
  const index = formats.indexOf(format);
  return index >= 0 ? index : formats.length + 100;
}

function outputTemplate(outputDir: string): string {
  return join(outputDir, "%(id)s.%(language)s.%(ext)s");
}

export function buildYtDlpTranscriptInvocation(options: {
  videoUrl: string;
  outputDir: string;
  phase: CaptionPhase;
  languages: string[];
  formats?: CaptionFormat[];
}): YtDlpInvocation {
  const formats = options.formats ?? [...DEFAULT_CAPTION_FORMATS];
  const template = outputTemplate(options.outputDir);
  const args = [
    "--no-playlist",
    "--skip-download",
    options.phase === "manual" ? "--write-subs" : "--write-auto-subs",
    "--sub-langs",
    options.languages.join(","),
    "--sub-format",
    formats.join("/"),
    "--output",
    template,
    options.videoUrl,
  ];

  return {
    command: "yt-dlp",
    args,
    phase: options.phase,
    languages: options.languages,
    outputTemplate: template,
  };
}

export function buildYtDlpTranscriptPlan(options: YtDlpTranscriptPlanOptions): YtDlpInvocation[] {
  const preferredLanguages = options.preferredLanguages ?? [...DEFAULT_PREFERRED_CAPTION_LANGUAGES];
  const widenedLanguages = options.widenedLanguages ?? [...DEFAULT_WIDENED_CAPTION_LANGUAGES];
  const formats = options.formats ?? [...DEFAULT_CAPTION_FORMATS];

  return [
    buildYtDlpTranscriptInvocation({
      videoUrl: options.videoUrl,
      outputDir: options.outputDir,
      phase: "manual",
      languages: preferredLanguages,
      formats,
    }),
    buildYtDlpTranscriptInvocation({
      videoUrl: options.videoUrl,
      outputDir: options.outputDir,
      phase: "automatic",
      languages: preferredLanguages,
      formats,
    }),
    buildYtDlpTranscriptInvocation({
      videoUrl: options.videoUrl,
      outputDir: options.outputDir,
      phase: "manual",
      languages: widenedLanguages,
      formats,
    }),
    buildYtDlpTranscriptInvocation({
      videoUrl: options.videoUrl,
      outputDir: options.outputDir,
      phase: "automatic",
      languages: widenedLanguages,
      formats,
    }),
  ];
}

export function captionCandidateFromPath(path: string, source: CaptionSource): CaptionCandidate | undefined {
  const name = basename(path);
  const match = name.match(/\.([^.]+)\.(json3|vtt)$/i);
  if (!match?.[1] || !match[2]) return undefined;

  return {
    path,
    language: match[1],
    format: match[2].toLowerCase() as CaptionFormat,
    source,
  };
}

export function selectCaptionFile(
  candidates: CaptionCandidate[],
  options: CaptionSelectionOptions = {}
): CaptionCandidate | undefined {
  const preferredLanguages = options.preferredLanguages ?? [...DEFAULT_PREFERRED_CAPTION_LANGUAGES];
  const widenedLanguages = options.widenedLanguages ?? [...DEFAULT_WIDENED_CAPTION_LANGUAGES];
  const formats = options.formats ?? [...DEFAULT_CAPTION_FORMATS];

  const ranked = candidates
    .filter((candidate) => formats.includes(candidate.format))
    .map((candidate) => ({
      candidate,
      language: languageRank(candidate.language, preferredLanguages, widenedLanguages),
      source: candidate.source === "manual" ? 0 : 1,
      format: captionFormatRank(candidate.format, formats),
    }))
    .sort(
      (a, b) =>
        (a.language - b.language) ||
        (a.source - b.source) ||
        (a.format - b.format) ||
        a.candidate.path.localeCompare(b.candidate.path)
    );

  return ranked[0]?.candidate;
}

export function parseJson3Transcript(
  raw: string,
  candidate: CaptionCandidate
): Result<TranscriptAvailable> {
  const normalized = normalizeTranscript(raw);
  if (normalized.sourceFormat !== "youtube-timedtext-json") {
    return err({
      code: "invalid-json3-transcript",
      message: "Expected YouTube timedtext JSON3 with an events array.",
    });
  }

  return ok({
    status: "available",
    source: "yt-dlp-json3",
    language: candidate.language,
    isAutomatic: candidate.source === "automatic",
    filePath: candidate.path,
    text: normalized.text,
    segments: normalized.segments,
    warnings: normalized.warnings,
  });
}

function parseVttTimestamp(value: string): number | undefined {
  const parts = value.trim().replace(',', '.').split(":");
  if (parts.length < 2 || parts.length > 3) return undefined;

  const secondsPart = parts.at(-1);
  const minutesPart = parts.at(-2);
  const hoursPart = parts.length === 3 ? parts[0] : "0";
  if (!secondsPart || !minutesPart || hoursPart === undefined) return undefined;

  const seconds = Number(secondsPart);
  const minutes = Number(minutesPart);
  const hours = Number(hoursPart);
  if (![seconds, minutes, hours].every(Number.isFinite)) return undefined;
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

function stripVttCueText(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

export function parseWebVttTranscript(
  raw: string,
  candidate: CaptionCandidate
): Result<TranscriptAvailable> {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const segments: TranscriptSegment[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line || line === "WEBVTT" || line.startsWith("NOTE")) {
      index += 1;
      continue;
    }

    const timingLine = line.includes("-->") ? line : lines[index + 1]?.trim() ?? "";
    const consumedCueId = timingLine !== line;
    const timingMatch = timingLine.match(/([^\s]+)\s+-->\s+([^\s]+)/);
    if (!timingMatch?.[1] || !timingMatch[2]) {
      index += 1;
      continue;
    }

    const textLines: string[] = [];
    index += consumedCueId ? 2 : 1;
    while (index < lines.length && (lines[index]?.trim() ?? "") !== "") {
      textLines.push(lines[index] ?? "");
      index += 1;
    }

    const text = stripVttCueText(textLines.join(" "));
    if (!text) continue;

    const startMs = parseVttTimestamp(timingMatch[1]);
    const endMs = parseVttTimestamp(timingMatch[2]);
    segments.push({
      index: segments.length + 1,
      startMs,
      durationMs: startMs !== undefined && endMs !== undefined ? Math.max(0, endMs - startMs) : undefined,
      text,
    });
  }

  if (segments.length === 0) {
    return err({
      code: "invalid-webvtt-transcript",
      message: "No WebVTT cues with text were found.",
    });
  }

  return ok({
    status: "available",
    source: "yt-dlp-webvtt",
    language: candidate.language,
    isAutomatic: candidate.source === "automatic",
    filePath: candidate.path,
    text: formatTranscriptSegments(segments),
    segments,
    warnings: [],
  });
}

export function parseCaptionTranscript(raw: string, candidate: CaptionCandidate): Result<TranscriptAvailable> {
  return candidate.format === "json3"
    ? parseJson3Transcript(raw, candidate)
    : parseWebVttTranscript(raw, candidate);
}

export interface CommentBudgetOptions {
  maxComments: number;
  maxWords: number;
  currentComments?: Comment[];
  currentWordCount?: number;
  nextPageToken?: string;
}

export function applyCommentBudget(pageComments: Comment[], options: CommentBudgetOptions): CommentBudgetState {
  const accepted = [...(options.currentComments ?? [])];
  let acceptedWordCount = options.currentWordCount ?? accepted.reduce((sum, comment) => sum + wordCount(comment.comment), 0);

  for (const comment of pageComments) {
    if (accepted.length >= options.maxComments) {
      return { accepted, acceptedWordCount, stopReason: "budget", budgetKind: "comments" };
    }

    const words = wordCount(comment.comment);
    if (acceptedWordCount + words > options.maxWords) {
      return { accepted, acceptedWordCount, stopReason: "budget", budgetKind: "words" };
    }

    accepted.push(comment);
    acceptedWordCount += words;
  }

  if (accepted.length >= options.maxComments) {
    return { accepted, acceptedWordCount, stopReason: "budget", budgetKind: "comments" };
  }

  if (!options.nextPageToken) {
    return { accepted, acceptedWordCount, stopReason: "pages-exhausted" };
  }

  return { accepted, acceptedWordCount, nextPageToken: options.nextPageToken };
}

export function shouldContinueCommentsPagination(state: CommentBudgetState): state is CommentBudgetState & { nextPageToken: string } {
  return Boolean(state.nextPageToken && !state.stopReason);
}

export interface RetryInput {
  status?: number;
  reason?: string;
  networkError?: boolean;
  attempt: number;
  maxAttempts: number;
}

export interface RetryDecision {
  retry: boolean;
  retryable: boolean;
  reason: string;
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 410]);
const TRANSIENT_API_REASONS = new Set(["backendError", "internalError", "rateLimitExceeded", "userRateLimitExceeded"]);
const PERMANENT_API_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "keyInvalid", "forbidden", "videoNotFound"]);

export function classifyRetry(input: RetryInput): RetryDecision {
  const attemptsRemain = input.attempt < input.maxAttempts;
  if (input.networkError) {
    return { retry: attemptsRemain, retryable: true, reason: "network-error" };
  }

  if (input.reason && PERMANENT_API_REASONS.has(input.reason)) {
    return { retry: false, retryable: false, reason: `permanent-api-reason:${input.reason}` };
  }

  if (input.reason && TRANSIENT_API_REASONS.has(input.reason)) {
    return { retry: attemptsRemain, retryable: true, reason: `transient-api-reason:${input.reason}` };
  }

  if (input.status !== undefined) {
    if (TRANSIENT_HTTP_STATUSES.has(input.status)) {
      return { retry: attemptsRemain, retryable: true, reason: `transient-http-status:${input.status}` };
    }
    if (PERMANENT_HTTP_STATUSES.has(input.status)) {
      return { retry: false, retryable: false, reason: `permanent-http-status:${input.status}` };
    }
  }

  return { retry: false, retryable: false, reason: "not-classified-transient" };
}

export interface EnvFileCandidateOptions {
  cwd: string;
  homeDir: string;
  envFile?: string;
  configDir?: string;
}

function resolveUserPath(cwd: string, homeDir: string, path: string): string {
  return path === "~" || path.startsWith("~/")
    ? join(homeDir, path.slice(2))
    : resolve(cwd, path);
}

export function envFileCandidates(options: EnvFileCandidateOptions): string[] {
  return unique(
    [
      options.envFile ? resolveUserPath(options.cwd, options.homeDir, options.envFile) : undefined,
      options.configDir ? join(resolveUserPath(options.cwd, options.homeDir, options.configDir), ".env") : undefined,
      resolve(options.cwd, ".env"),
      join(options.homeDir, ".config", "pi-youtube-chorus", ".env"),
      join(options.homeDir, ".config", "yt-mcp", ".env"),
    ].filter((value): value is string => Boolean(value))
  );
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match?.[1]) continue;

    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]] = value;
  }

  return values;
}

export function apiKeyFromEnv(env: Record<string, string | undefined>): string | undefined {
  const value = env.YOUTUBE_API_KEY;
  return value && value.trim().length > 0 ? value : undefined;
}

export function parseYoutubeDataApiVideoMetadata(raw: unknown, videoUrl: string): Result<VideoMetadata> {
  if (!isRecord(raw)) {
    return err({ code: "invalid-metadata-response", message: "Metadata response is not an object." });
  }

  const items = arrayOrEmpty(raw.items);
  const first = items.find(isRecord);
  if (!first) {
    return err({ code: "video-not-found", message: "YouTube Data API returned no video items.", retryable: false });
  }

  const snippet = isRecord(first.snippet) ? first.snippet : undefined;
  const videoId = stringOrUndefined(first.id);
  const title = stringOrUndefined(snippet?.title);
  const channel = stringOrUndefined(snippet?.channelTitle);
  if (!videoId || !title || !channel) {
    return err({
      code: "invalid-metadata-response",
      message: "Metadata response is missing id, snippet.title, or snippet.channelTitle.",
    });
  }

  return ok({
    videoId,
    videoUrl,
    title,
    channel,
    channelId: stringOrUndefined(snippet?.channelId),
    publishedAt: stringOrUndefined(snippet?.publishedAt),
    description: stringOrUndefined(snippet?.description),
    thumbnails: isRecord(snippet?.thumbnails) ? snippet.thumbnails : undefined,
    source: "youtube-data-api",
  });
}

export function parseYtDlpJsonMetadata(raw: unknown, videoUrl: string): Result<VideoMetadata> {
  if (!isRecord(raw)) {
    return err({ code: "invalid-ytdlp-json", message: "yt-dlp -J output is not an object." });
  }

  const videoId = stringOrUndefined(raw.id);
  const title = stringOrUndefined(raw.title);
  const channel = stringOrUndefined(raw.channel) ?? stringOrUndefined(raw.uploader);
  if (!videoId || !title || !channel) {
    return err({ code: "invalid-ytdlp-json", message: "yt-dlp -J output is missing id, title, or channel/uploader." });
  }

  const uploadDate = stringOrUndefined(raw.upload_date);
  const timestamp = numberOrUndefined(raw.release_timestamp) ?? numberOrUndefined(raw.timestamp);
  const publishedAt = uploadDate?.match(/^\d{8}$/)
    ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
    : timestamp !== undefined
      ? new Date(timestamp * 1000).toISOString()
      : undefined;

  return ok({
    videoId,
    videoUrl,
    title,
    channel,
    channelId: stringOrUndefined(raw.channel_id),
    publishedAt,
    description: stringOrUndefined(raw.description),
    thumbnails: Array.isArray(raw.thumbnails) ? { thumbnails: raw.thumbnails } : undefined,
    source: "yt-dlp-json",
  });
}

function apiCommentText(snippet: Record<string, unknown>): string {
  return normalizeWhitespace(stringOrUndefined(snippet.textOriginal) ?? stringOrUndefined(snippet.textDisplay) ?? "");
}

function apiAuthorChannelId(snippet: Record<string, unknown>): string | undefined {
  const authorChannelId = snippet.authorChannelId;
  if (isRecord(authorChannelId)) return stringOrUndefined(authorChannelId.value);
  return undefined;
}

function parseApiReply(item: Record<string, unknown>): CommentReply | undefined {
  const snippet = isRecord(item.snippet) ? item.snippet : undefined;
  if (!snippet) return undefined;
  const text = apiCommentText(snippet);
  if (!text) return undefined;
  return {
    id: stringOrUndefined(item.id),
    author: stringOrUndefined(snippet.authorDisplayName),
    authorChannelId: apiAuthorChannelId(snippet),
    date: stringOrUndefined(snippet.publishedAt),
    updatedAt: stringOrUndefined(snippet.updatedAt),
    like_count: numberOrUndefined(snippet.likeCount) ?? 0,
    comment: text,
  };
}

export function parseYoutubeDataApiCommentsPage(raw: unknown, startIndex = 1): Result<CommentsPage> {
  if (!isRecord(raw)) {
    return err({ code: "invalid-comments-response", message: "Comments response is not an object." });
  }

  const comments: Comment[] = [];
  for (const item of arrayOrEmpty(raw.items).filter(isRecord)) {
    const snippet = isRecord(item.snippet) ? item.snippet : undefined;
    const topLevelComment = isRecord(snippet?.topLevelComment) ? snippet.topLevelComment : undefined;
    const topSnippet = isRecord(topLevelComment?.snippet) ? topLevelComment.snippet : undefined;
    if (!topSnippet) continue;

    const text = apiCommentText(topSnippet);
    if (!text) continue;

    const replyItems = isRecord(item.replies) ? arrayOrEmpty(item.replies.comments).filter(isRecord) : [];
    const replies = replyItems.map(parseApiReply).filter((reply): reply is CommentReply => reply !== undefined);

    comments.push({
      index: startIndex + comments.length,
      id: stringOrUndefined(item.id) ?? stringOrUndefined(topLevelComment?.id),
      author: stringOrUndefined(topSnippet.authorDisplayName),
      authorChannelId: apiAuthorChannelId(topSnippet),
      date: stringOrUndefined(topSnippet.publishedAt),
      updatedAt: stringOrUndefined(topSnippet.updatedAt),
      like_count: numberOrUndefined(topSnippet.likeCount) ?? 0,
      comment: text,
      reply_count: numberOrUndefined(snippet?.totalReplyCount) ?? replies.length,
      replies,
    });
  }

  return ok({
    comments,
    nextPageToken: stringOrUndefined(raw.nextPageToken),
    resultCount: numberOrUndefined(isRecord(raw.pageInfo) ? raw.pageInfo.resultsPerPage : undefined) ?? comments.length,
  });
}

export function formatCommentsJson(comments: Comment[]): string {
  return JSON.stringify({ comments }, null, 2) + "\n";
}

export function formatCommentsJsonl(comments: Comment[]): string {
  return comments.map((comment) => JSON.stringify(comment)).join("\n") + (comments.length ? "\n" : "");
}

export function formatCommentsMarkdown(comments: Comment[]): string {
  const lines = ["# YouTube Comments", "", `Captured comments: ${comments.length}`];
  for (const comment of comments) {
    lines.push(
      "",
      `## Comment ${comment.index}`,
      "",
      `- Author: ${comment.author ?? "unknown"}`,
      `- Date: ${comment.date ?? "unknown"}`,
      `- Likes: ${comment.like_count}`,
      `- Replies: ${comment.reply_count}`,
      "",
      comment.comment
    );

    if (comment.replies.length > 0) {
      lines.push("", "Replies:");
      comment.replies.forEach((reply, index) => {
        lines.push(`${index + 1}. ${reply.author ? `${reply.author}: ` : ""}${reply.comment}`);
      });
    }
  }
  return lines.join("\n");
}

export function formatBundleMarkdown(input: {
  video: VideoMetadata;
  transcript?: TranscriptResult;
  comments?: Comment[];
}): string {
  const lines = [
    `# ${input.video.title}`,
    "",
    `- Video ID: ${input.video.videoId}`,
    `- URL: ${input.video.videoUrl}`,
    `- Channel: ${input.video.channel}`,
    `- Published: ${input.video.publishedAt ?? "unknown"}`,
    "",
    "## Transcript",
    "",
  ];

  if (input.transcript?.status === "available") {
    lines.push(input.transcript.text);
  } else {
    lines.push(`Transcript ${input.transcript?.status ?? "not requested"}.`);
  }

  lines.push("", "## Comments", "");
  if (input.comments) {
    lines.push(formatCommentsMarkdown(input.comments));
  } else {
    lines.push("Comments not requested.");
  }

  return lines.join("\n");
}

export function buildCaptureManifest(input: CaptureManifestInput): Record<string, unknown> {
  const transcript = input.transcript;
  const comments = input.comments;
  const warnings = unique([
    ...(input.warnings ?? []),
    ...(transcript?.warnings ?? []),
    ...(transcript?.status === "error" ? [transcript.error] : []),
  ]);

  return {
    captured_at: input.capturedAt,
    video_url: input.video.videoUrl,
    video_id: input.video.videoId,
    title: input.video.title,
    channel: input.video.channel,
    extractor: "native",
    extractor_contract: "v1",
    ...(input.ytDlpVersion ? { yt_dlp_version: input.ytDlpVersion } : {}),
    stats: {
      transcript_status: transcript?.status ?? "not-requested",
      transcript_source: transcript?.status === "available" ? transcript.source : undefined,
      transcript_language: transcript?.status === "available" ? transcript.language : undefined,
      transcript_is_automatic: transcript?.status === "available" ? transcript.isAutomatic : undefined,
      transcript_word_count: transcript?.status === "available" ? wordCount(transcript.text) : 0,
      transcript_segment_count: transcript?.status === "available" ? transcript.segments.length : 0,
      comment_count: comments?.accepted.length ?? 0,
      comment_word_count: comments?.acceptedWordCount ?? 0,
      comment_stop_reason: comments?.stopReason,
      comment_budget_kind: comments?.budgetKind,
      warnings,
    },
    files: input.files,
    output_dir: input.outputDir,
  };
}
