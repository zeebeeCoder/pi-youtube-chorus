import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  analyzeComments,
  buildRankedCommentsJsonl,
  buildRankedCommentsMarkdown,
  defaultOutputDir,
  extractVideoId,
  formatCommentSignals,
  formatContextPack,
  normalizeTranscript,
  parseCommentsJson,
  transcriptSegmentsToJsonl,
  type CommentContextOptions,
  type CommentsFormat,
  type CommentSort,
  type ContextPackInput,
} from "./chorus-logic.js";
import {
  apiKeyFromEnv,
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
  selectCaptionFile,
  shouldContinueCommentsPagination,
  type CaptionCandidate,
  type Comment,
  type CommentBudgetState,
  type TranscriptResult,
  type VideoMetadata,
} from "./extractor-logic.js";

interface CaptureManifest {
  captured_at?: string;
  video_url?: string;
  video_id?: string;
  title?: string;
  channel?: string;
  stats?: Record<string, unknown>;
  files?: Record<string, string>;
  derived?: {
    generated_at?: string;
    files?: Record<string, string>;
    warnings?: string[];
    [key: string]: unknown;
  };
  artifact_layout?: string;
  raw_dir?: string;
  [key: string]: unknown;
}

const CaptureParams = Type.Object({
  videoUrl: Type.String({ description: "YouTube URL or bare video id to capture." }),
  outputDir: Type.Optional(
    Type.String({
      description:
        "Optional output directory. Relative paths resolve from the Pi cwd. Defaults to .pi/youtube-chorus/<timestamp>-<videoId>.",
    })
  ),
  maxComments: Type.Optional(
    Type.Integer({ default: 5000, minimum: 0, description: "Maximum top-level comments." })
  ),
  maxWords: Type.Optional(
    Type.Integer({ default: 80000, minimum: 0, description: "Maximum total comment words." })
  ),
  envFile: Type.Optional(Type.String({ description: "Optional .env file to read YOUTUBE_API_KEY from." })),
  configDir: Type.Optional(
    Type.String({ description: "Optional config directory containing a .env file with YOUTUBE_API_KEY." })
  ),
  postProcess: Type.Optional(
    Type.Boolean({
      default: true,
      description:
        "Generate normalized transcript text, transcript JSONL segments, scored comment JSONL, and lexical comment clusters after capture.",
    })
  ),
  artifactLayout: Type.Optional(
    StringEnum(["canonical", "legacy"] as const, {
      default: "canonical",
      description:
        "canonical keeps model-facing JSONL artifacts at the capture root and moves extractor-only raw files under raw/. legacy leaves all native extractor files at the root."
    })
  ),
});

const ContextParams = Type.Object({
  captureDir: Type.String({ description: "Directory returned by youtube_chorus_capture." }),
  commentsFormat: Type.Optional(
    StringEnum(["ranked-markdown", "ranked-jsonl", "markdown", "jsonl", "json"] as const, {
      description: "Comment artifact or generated ranked representation to load into context.",
      default: "ranked-markdown",
    })
  ),
  commentsSort: Type.Optional(
    StringEnum(["balanced", "engagement", "recency", "source"] as const, {
      description:
        "Ordering for ranked comment context. balanced combines recency, engagement, and comment depth while demoting likely spam.",
      default: "balanced",
    })
  ),
  maxCommentsInContext: Type.Optional(
    Type.Integer({
      default: 100,
      minimum: 0,
      description: "Maximum comments to include when generating ranked comment context.",
    })
  ),
  includeReplies: Type.Optional(
    Type.Boolean({ default: true, description: "Include comment replies in generated ranked comment context." })
  ),
  includeLikelySpam: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Include comments flagged as likely promotional/spam in generated ranked comment context.",
    })
  ),
  transcriptMaxChars: Type.Optional(
    Type.Integer({
      default: 20000,
      minimum: 0,
      description: "Maximum transcript characters to emit into model context.",
    })
  ),
  commentsMaxChars: Type.Optional(
    Type.Integer({
      default: 20000,
      minimum: 0,
      description: "Maximum comment characters to emit into model context.",
    })
  ),
  includeSynthesisGuidance: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Include default transcript+comment synthesis guidance in the context pack.",
    })
  ),
  synthesisInstructions: Type.Optional(
    Type.String({ description: "Optional custom synthesis instructions appended to the context pack." })
  ),
  transcriptInstructions: Type.Optional(
    Type.String({ description: "Optional custom instructions for how to use the transcript layer." })
  ),
  commentsInstructions: Type.Optional(
    Type.String({ description: "Optional custom instructions for how to use the comments layer." })
  ),
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    await access(path);
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readJsonIfExists<T = Record<string, unknown>>(path: string): Promise<T | undefined> {
  const text = await readTextIfExists(path);
  if (!text) return undefined;
  return JSON.parse(text) as T;
}

function artifactPath(captureDir: string, manifest: CaptureManifest | undefined, key: string, file: string) {
  const manifestPath = manifest?.files?.[key];
  if (typeof manifestPath === "string") {
    return isAbsolute(manifestPath) ? manifestPath : resolve(captureDir, manifestPath);
  }
  return join(captureDir, file);
}

async function nearbyCaptureDirs(cwd: string): Promise<string[]> {
  const base = join(cwd, ".pi", "youtube-chorus");
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(base, entry.name))
      .slice(-10);
  } catch {
    return [];
  }
}

function commentOptions(params: {
  commentsFormat?: CommentsFormat;
  commentsSort?: CommentSort;
  maxCommentsInContext?: number;
  includeReplies?: boolean;
  includeLikelySpam?: boolean;
}): CommentContextOptions {
  return {
    format: params.commentsFormat ?? "ranked-markdown",
    sort: params.commentsSort ?? "balanced",
    maxComments: params.maxCommentsInContext ?? 100,
    includeReplies: params.includeReplies ?? true,
    includeLikelySpam: params.includeLikelySpam ?? false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonString(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

function youtubeDataApiUrl(endpoint: "videos" | "commentThreads", params: Record<string, string | number | undefined>) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function youtubeApiErrorReason(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const errors = Array.isArray(body.error.errors) ? body.error.errors : [];
  const first = errors.find(isRecord);
  return typeof first?.reason === "string"
    ? first.reason
    : typeof body.error.status === "string"
      ? body.error.status
      : undefined;
}

function abortErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Operation aborted."));
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(resolvePromise, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new Error("Operation aborted."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function fetchJsonWithRetry(url: string, signal?: AbortSignal, maxAttempts = 3, timeoutMs = 30_000): Promise<unknown> {
  let lastMessage = "request failed";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error("Operation aborted.");

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (error) {
      if (signal?.aborted) throw new Error("Operation aborted.");

      const decision = classifyRetry({ networkError: true, attempt, maxAttempts });
      lastMessage = timedOut ? `YouTube API request timed out after ${timeoutMs}ms` : abortErrorMessage(error);
      if (!decision.retry) throw new Error(lastMessage);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      await wait(250 * attempt, signal);
      continue;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (response.ok) return body;

    const reason = youtubeApiErrorReason(body);
    const decision = classifyRetry({ status: response.status, reason, attempt, maxAttempts });
    lastMessage = `YouTube API HTTP ${response.status}${reason ? ` (${reason})` : ""}`;
    if (!decision.retry) {
      throw new Error(`${lastMessage}; ${decision.reason}`);
    }

    await wait(250 * attempt, signal);
  }

  throw new Error(lastMessage);
}

async function loadYouTubeApiKey(cwd: string, params: { envFile?: string; configDir?: string }) {
  const processKey = apiKeyFromEnv(process.env);
  if (processKey) return { apiKey: processKey, source: "process.env", candidates: [] as string[] };

  const candidates = envFileCandidates({ cwd, homeDir: homedir(), envFile: params.envFile, configDir: params.configDir });
  for (const candidate of candidates) {
    const text = await readTextIfExists(candidate);
    if (!text) continue;
    const apiKey = apiKeyFromEnv(parseEnvFile(text));
    if (apiKey) return { apiKey, source: candidate, candidates };
  }

  return { apiKey: undefined, source: undefined, candidates };
}

async function fetchVideoMetadata(videoId: string, videoUrl: string, apiKey: string, signal?: AbortSignal): Promise<VideoMetadata> {
  const url = youtubeDataApiUrl("videos", {
    part: "snippet",
    id: videoId,
    key: apiKey,
  });
  const body = await fetchJsonWithRetry(url, signal);
  const parsed = parseYoutubeDataApiVideoMetadata(body, videoUrl);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

async function fetchComments(
  videoId: string,
  apiKey: string,
  options: { maxComments: number; maxWords: number; signal?: AbortSignal }
): Promise<{ state: CommentBudgetState; warnings: string[] }> {
  const warnings: string[] = [];
  if (options.maxComments <= 0) {
    return { state: { accepted: [], acceptedWordCount: 0, stopReason: "budget", budgetKind: "comments" }, warnings };
  }
  if (options.maxWords <= 0) {
    return { state: { accepted: [], acceptedWordCount: 0, stopReason: "budget", budgetKind: "words" }, warnings };
  }

  let state: CommentBudgetState = { accepted: [], acceptedWordCount: 0 };
  let pageToken: string | undefined;

  while (!state.stopReason) {
    const remaining = Math.max(0, options.maxComments - state.accepted.length);
    const url = youtubeDataApiUrl("commentThreads", {
      part: "snippet,replies",
      videoId,
      key: apiKey,
      maxResults: Math.min(100, Math.max(1, remaining)),
      textFormat: "plainText",
      order: "relevance",
      pageToken,
    });

    try {
      const body = await fetchJsonWithRetry(url, options.signal);
      const parsed = parseYoutubeDataApiCommentsPage(body, state.accepted.length + 1);
      if (!parsed.ok) throw new Error(parsed.error.message);
      state = applyCommentBudget(parsed.value.comments, {
        maxComments: options.maxComments,
        maxWords: options.maxWords,
        currentComments: state.accepted,
        currentWordCount: state.acceptedWordCount,
        nextPageToken: parsed.value.nextPageToken,
      });
      pageToken = shouldContinueCommentsPagination(state) ? state.nextPageToken : undefined;
      if (!pageToken && !state.stopReason) {
        state = { ...state, stopReason: "pages-exhausted" };
      }
    } catch (error) {
      const message = `comment capture stopped early: ${abortErrorMessage(error)}`;
      warnings.push(message);
      return { state: { ...state, stopReason: "error" }, warnings };
    }
  }

  return { state, warnings };
}

async function preflightYtDlp(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await pi.exec("yt-dlp", ["--version"], { signal, timeout: 30_000, cwd });
  if (result.code !== 0) {
    throw new Error(
      [
        "yt-dlp is required for native transcript capture but the preflight failed.",
        "Install it with: brew install yt-dlp",
        result.stderr || result.stdout,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return result.stdout.split(/\r?\n/).find(Boolean) ?? "unknown";
}

async function listCaptionCandidates(outputDir: string, source: "manual" | "automatic", before: Set<string>) {
  const entries = await readdir(outputDir);
  return entries
    .filter((entry) => !before.has(entry))
    .map((entry) => captionCandidateFromPath(join(outputDir, entry), source))
    .filter((candidate): candidate is CaptionCandidate => candidate !== undefined);
}

async function captureTranscriptWithYtDlp(
  pi: ExtensionAPI,
  videoUrl: string,
  outputDir: string,
  cwd: string,
  signal?: AbortSignal
): Promise<{ transcript: TranscriptResult; rawTranscript?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const candidates: CaptionCandidate[] = [];
  const badPaths = new Set<string>();

  for (const step of buildYtDlpTranscriptPlan({ videoUrl, outputDir })) {
    const before = new Set(await readdir(outputDir));
    const result = await pi.exec(step.command, step.args, { signal, timeout: 5 * 60_000, cwd });
    if (result.code !== 0) {
      warnings.push(`yt-dlp ${step.phase} subtitle pass failed: ${result.stderr || result.stdout}`);
      continue;
    }

    candidates.push(...(await listCaptionCandidates(outputDir, step.phase, before)));

    while (true) {
      const selected = selectCaptionFile(candidates.filter((candidate) => !badPaths.has(candidate.path)));
      if (!selected) break;

      const raw = await readFile(selected.path, "utf8");
      const parsed = parseCaptionTranscript(raw, selected);
      if (parsed.ok) {
        return { transcript: parsed.value, rawTranscript: selected.format === "json3" ? raw : parsed.value.text, warnings };
      }

      warnings.push(`caption parse failed for ${selected.path}: ${parsed.error.message}`);
      badPaths.add(selected.path);
    }
  }

  return { transcript: { status: "not-found", warnings }, warnings };
}

async function writeNativeCaptureArtifacts(input: {
  captureDir: string;
  capturedAt: string;
  video: VideoMetadata;
  transcript: TranscriptResult;
  rawTranscript?: string;
  comments: CommentBudgetState;
  commentsWarnings: string[];
  ytDlpVersion: string;
}) {
  const files: Record<string, string> = {
    metadata: join(input.captureDir, "metadata.json"),
    comments_json: join(input.captureDir, "comments.json"),
    comments_jsonl: join(input.captureDir, "comments.jsonl"),
    comments_markdown: join(input.captureDir, "comments.md"),
    bundle: join(input.captureDir, "bundle.md"),
  };

  await writeFile(files.metadata, jsonString(input.video), "utf8");

  if (input.transcript.status === "available") {
    files.transcript_json = join(input.captureDir, "transcript.json");
    files.transcript_text = join(input.captureDir, "transcript.txt");
    files.transcript_source = input.transcript.filePath;
    await writeFile(
      files.transcript_json,
      jsonString({
        status: input.transcript.status,
        source: input.transcript.source,
        language: input.transcript.language,
        is_automatic: input.transcript.isAutomatic,
        file_path: input.transcript.filePath,
        segments: input.transcript.segments,
        warnings: input.transcript.warnings,
      }),
      "utf8"
    );
    await writeFile(files.transcript_text, input.rawTranscript ?? input.transcript.text, "utf8");
  }

  await writeFile(files.comments_json, formatCommentsJson(input.comments.accepted), "utf8");
  await writeFile(files.comments_jsonl, formatCommentsJsonl(input.comments.accepted), "utf8");
  await writeFile(files.comments_markdown, formatCommentsMarkdown(input.comments.accepted), "utf8");
  await writeFile(
    files.bundle,
    formatBundleMarkdown({
      video: input.video,
      transcript: input.transcript,
      comments: input.comments.accepted,
    }),
    "utf8"
  );

  const manifest = buildCaptureManifest({
    capturedAt: input.capturedAt,
    video: input.video,
    outputDir: input.captureDir,
    files,
    transcript: input.transcript,
    comments: input.comments,
    ytDlpVersion: input.ytDlpVersion,
    warnings: input.commentsWarnings,
  }) as CaptureManifest;
  await writeFile(join(input.captureDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

async function moveRawArtifactsToRawDir(captureDir: string, manifest: CaptureManifest) {
  const rawDir = join(captureDir, "raw");
  await mkdir(rawDir, { recursive: true });

  const modelFacingKeys = new Set([
    "metadata",
    "transcript_normalized",
    "transcript_segments_jsonl",
    "comments_scored_jsonl",
    "comments_clusters_json",
  ]);
  const files = { ...(manifest.files ?? {}) };
  const moved: Record<string, string> = {};

  for (const [key, value] of Object.entries(files)) {
    if (modelFacingKeys.has(key) || typeof value !== "string") continue;
    const currentPath = isAbsolute(value) ? value : resolve(captureDir, value);
    if (!(await pathExists(currentPath))) continue;
    if (currentPath.startsWith(`${rawDir}/`)) continue;

    const nextPath = join(rawDir, basename(currentPath));
    await rename(currentPath, nextPath);
    files[key] = nextPath;
    moved[key] = nextPath;
  }

  const existingDerivedFiles = manifest.derived?.files ?? {};
  const derived = manifest.derived
    ? {
        ...manifest.derived,
        files: Object.fromEntries(
          Object.keys(existingDerivedFiles).map((key) => [key, files[key] ?? existingDerivedFiles[key]])
        ),
      }
    : undefined;

  manifest.files = files;
  manifest.derived = derived;
  manifest.artifact_layout = "canonical";
  manifest.raw_dir = rawDir;
  await writeFile(join(captureDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { rawDir, moved };
}

async function materializeDerivedArtifacts(captureDir: string, manifest: CaptureManifest) {
  const files = { ...(manifest.files ?? {}) };
  const stats: Record<string, unknown> = {};
  const warnings: string[] = [];
  const derivedFiles: Record<string, string> = {};

  const transcriptPath = artifactPath(captureDir, manifest, "transcript_text", "transcript.txt");
  const rawTranscript = await readTextIfExists(transcriptPath);
  if (rawTranscript) {
    try {
      const normalized = normalizeTranscript(rawTranscript);
      const normalizedPath = join(captureDir, "transcript.normalized.txt");
      const segmentsPath = join(captureDir, "transcript.segments.jsonl");
      await writeFile(normalizedPath, normalized.text, "utf8");
      await writeFile(segmentsPath, transcriptSegmentsToJsonl(normalized.segments), "utf8");
      files.transcript_normalized = normalizedPath;
      files.transcript_segments_jsonl = segmentsPath;
      derivedFiles.transcript_normalized = normalizedPath;
      derivedFiles.transcript_segments_jsonl = segmentsPath;
      stats.transcript_source_format = normalized.sourceFormat;
      stats.normalized_transcript_word_count = normalized.text.match(/\S+/g)?.length ?? 0;
      stats.transcript_segment_count = normalized.segments.length;
      warnings.push(...normalized.warnings);
    } catch (error) {
      warnings.push(`transcript post-processing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const commentsJsonPath = artifactPath(captureDir, manifest, "comments_json", "comments.json");
  const rawComments = await readTextIfExists(commentsJsonPath);
  if (rawComments) {
    try {
      const records = parseCommentsJson(rawComments);
      const capturedAt = typeof manifest.captured_at === "string" ? new Date(manifest.captured_at) : new Date();
      const analysis = analyzeComments(records, capturedAt);
      const scoredPath = join(captureDir, "comments.scored.jsonl");
      const clustersPath = join(captureDir, "comments.clusters.json");
      const options: CommentContextOptions = {
        format: "ranked-jsonl",
        sort: "balanced",
        maxComments: analysis.comments.length,
        includeReplies: true,
        includeLikelySpam: true,
      };
      await writeFile(scoredPath, buildRankedCommentsJsonl(analysis.comments, options) + "\n", "utf8");
      await writeFile(clustersPath, JSON.stringify({ generated_at: analysis.generatedAt, clusters: analysis.clusters }, null, 2), "utf8");
      files.comments_scored_jsonl = scoredPath;
      files.comments_clusters_json = clustersPath;
      derivedFiles.comments_scored_jsonl = scoredPath;
      derivedFiles.comments_clusters_json = clustersPath;
      stats.comment_count = analysis.totalCount;
      stats.likely_spam_comment_count = analysis.likelySpamCount;
      stats.comment_cluster_count = analysis.clusters.length;
    } catch (error) {
      warnings.push(`comment post-processing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  manifest.files = files;
  manifest.stats = { ...(manifest.stats ?? {}), ...stats };
  manifest.derived = {
    ...(manifest.derived ?? {}),
    generated_at: new Date().toISOString(),
    files: derivedFiles,
    warnings,
  };

  await writeFile(join(captureDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return { files: derivedFiles, stats, warnings };
}

async function loadTranscriptForContext(captureDir: string, manifest: CaptureManifest | undefined) {
  const normalizedPath = artifactPath(captureDir, manifest, "transcript_normalized", "transcript.normalized.txt");
  const normalized = await readTextIfExists(normalizedPath);
  if (normalized !== undefined) return { text: normalized, path: normalizedPath, sourceFormat: "normalized" };

  const transcriptPath = artifactPath(captureDir, manifest, "transcript_text", "transcript.txt");
  const raw = await readTextIfExists(transcriptPath);
  if (raw === undefined) return { text: undefined, path: undefined, sourceFormat: undefined };

  const transcript = normalizeTranscript(raw);
  return { text: transcript.text, path: transcriptPath, sourceFormat: transcript.sourceFormat };
}

async function loadCommentsForContext(
  captureDir: string,
  manifest: CaptureManifest | undefined,
  options: CommentContextOptions
) {
  const commentsJsonPath = artifactPath(captureDir, manifest, "comments_json", "comments.json");
  const rawCommentsJson = await readTextIfExists(commentsJsonPath);
  let commentSignals: string | undefined;

  if (rawCommentsJson) {
    const capturedAt = typeof manifest?.captured_at === "string" ? new Date(manifest.captured_at) : new Date();
    const analysis = analyzeComments(parseCommentsJson(rawCommentsJson), capturedAt);
    commentSignals = formatCommentSignals(analysis, options);

    if (options.format === "ranked-jsonl") {
      return {
        text: buildRankedCommentsJsonl(analysis.comments, options),
        path: commentsJsonPath,
        commentSignals,
        analysis,
      };
    }

    if (options.format === "ranked-markdown") {
      return {
        text: buildRankedCommentsMarkdown(analysis.comments, options),
        path: commentsJsonPath,
        commentSignals,
        analysis,
      };
    }
  }

  const commentKey =
    options.format === "json"
      ? "comments_json"
      : options.format === "jsonl"
        ? "comments_jsonl"
        : "comments_markdown";
  const commentFile = options.format === "json" ? "comments.json" : options.format === "jsonl" ? "comments.jsonl" : "comments.md";
  const commentsPath = artifactPath(captureDir, manifest, commentKey, commentFile);
  const comments = await readTextIfExists(commentsPath);

  return { text: comments, path: comments ? commentsPath : undefined, commentSignals, analysis: undefined };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "youtube_chorus_capture",
    label: "YouTube Chorus Capture",
    description:
      "Capture YouTube metadata, transcript, and comments as raw files using native YouTube Data API calls plus yt-dlp subtitles, then derive normalized transcript text, transcript JSONL segments, scored comment JSONL, and lexical comment clusters. Returns artifact paths; does not summarize.",
    promptSnippet: "Capture YouTube transcript and comments as raw reusable context files.",
    promptGuidelines: [
      "Use youtube_chorus_capture when a user asks to analyze a YouTube video including audience comments.",
      "After youtube_chorus_capture, call youtube_chorus_context before synthesizing transcript and comments.",
    ],
    parameters: CaptureParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled." }], details: { cancelled: true } };
      }

      const videoId = extractVideoId(params.videoUrl);
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const captureDir = resolve(ctx.cwd, params.outputDir ?? defaultOutputDir(ctx.cwd, params.videoUrl));
      const maxComments = params.maxComments ?? 5000;
      const maxWords = params.maxWords ?? 80000;
      await mkdir(captureDir, { recursive: true });

      onUpdate?.({
        content: [{ type: "text", text: `Capturing transcript and comments natively for ${videoId}...` }],
        details: { outputDir: captureDir, extractor: "native" },
      });

      const ytDlpVersion = await preflightYtDlp(pi, ctx.cwd, signal);
      const apiKey = await loadYouTubeApiKey(ctx.cwd, { envFile: params.envFile, configDir: params.configDir });
      if (!apiKey.apiKey) {
        throw new Error(
          [
            "YOUTUBE_API_KEY is required for native YouTube metadata/comments capture.",
            "Set it in the Pi process environment or in one of the supported .env files.",
            apiKey.candidates.length ? `Checked: ${apiKey.candidates.join(", ")}` : undefined,
          ]
            .filter(Boolean)
            .join("\n")
        );
      }

      // Local abort controller: if any one capture branch rejects (bad API
      // key, video not found, yt-dlp preflight), abort the surviving branches
      // so we don't leak yt-dlp subprocesses and YouTube API quota for a
      // capture that has already failed. Forwards the incoming signal too.
      const captureController = new AbortController();
      const onIncomingAbort = () => captureController.abort();
      if (signal) {
        if (signal.aborted) captureController.abort();
        else signal.addEventListener("abort", onIncomingAbort, { once: true });
      }
      const captureSignal = captureController.signal;
      const abortOnError = <T>(p: Promise<T>): Promise<T> =>
        p.catch((error) => {
          captureController.abort();
          throw error;
        });

      let metadata: VideoMetadata;
      let transcriptCapture: Awaited<ReturnType<typeof captureTranscriptWithYtDlp>>;
      let commentsCapture: Awaited<ReturnType<typeof fetchComments>>;
      try {
        ([metadata, transcriptCapture, commentsCapture] = await Promise.all([
          abortOnError(fetchVideoMetadata(videoId, videoUrl, apiKey.apiKey, captureSignal)),
          abortOnError(captureTranscriptWithYtDlp(pi, videoUrl, captureDir, ctx.cwd, captureSignal)),
          abortOnError(fetchComments(videoId, apiKey.apiKey, { maxComments, maxWords, signal: captureSignal })),
        ]));
      } finally {
        if (signal) signal.removeEventListener("abort", onIncomingAbort);
      }

      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled." }], details: { cancelled: true } };
      }

      const manifest = await writeNativeCaptureArtifacts({
        captureDir,
        capturedAt: new Date().toISOString(),
        video: metadata,
        transcript: transcriptCapture.transcript,
        rawTranscript: transcriptCapture.rawTranscript,
        comments: commentsCapture.state,
        commentsWarnings: [...transcriptCapture.warnings, ...commentsCapture.warnings],
        ytDlpVersion,
      });
      const manifestPath = join(captureDir, "manifest.json");

      let derived: Awaited<ReturnType<typeof materializeDerivedArtifacts>> | undefined;
      let canonicalLayout: Awaited<ReturnType<typeof moveRawArtifactsToRawDir>> | undefined;
      if (params.postProcess !== false) {
        onUpdate?.({
          content: [{ type: "text", text: "Post-processing transcript and comments into model-ready JSONL artifacts..." }],
          details: { captureDir },
        });
        derived = await materializeDerivedArtifacts(captureDir, manifest);

        if ((params.artifactLayout ?? "canonical") === "canonical") {
          onUpdate?.({
            content: [{ type: "text", text: "Arranging canonical JSONL artifacts and moving raw extractor files under raw/..." }],
            details: { captureDir },
          });
          canonicalLayout = await moveRawArtifactsToRawDir(captureDir, manifest);
        }
      }

      const layoutWarning = params.postProcess === false && (params.artifactLayout ?? "canonical") === "canonical"
        ? "artifactLayout=canonical requires postProcess=true; leaving raw native extractor layout intact."
        : undefined;
      const stats = manifest.stats ?? {};
      const derivedFiles = derived?.files ?? manifest.derived?.files ?? {};

      return {
        content: [
          {
            type: "text",
            text: [
              `Captured YouTube source data for ${manifest.title ?? videoId}.`,
              `Directory: ${captureDir}`,
              `Extractor: native (yt-dlp ${ytDlpVersion})`,
              `Transcript words: ${stats.normalized_transcript_word_count ?? stats.transcript_word_count ?? "unknown"}`,
              `Transcript segments JSONL: ${derivedFiles.transcript_segments_jsonl ?? manifest.files?.transcript_segments_jsonl ?? "not generated"}`,
              `Comments: ${stats.comment_count ?? "unknown"}`,
              `Comment clusters: ${stats.comment_cluster_count ?? "unknown"}`,
              `Scored comments JSONL: ${derivedFiles.comments_scored_jsonl ?? manifest.files?.comments_scored_jsonl ?? "not generated"}`,
              `Artifact layout: ${manifest.artifact_layout ?? "legacy"}${canonicalLayout ? ` (raw files in ${canonicalLayout.rawDir})` : ""}`,
              ...(layoutWarning ? [`Warning: ${layoutWarning}`] : []),
              "Next: call youtube_chorus_context with this captureDir to load model-ready transcript + ranked comments.",
            ].join("\n"),
          },
        ],
        details: {
          captureDir,
          manifestPath,
          manifest,
          derived,
          canonicalLayout,
          layoutWarning,
          invocation: { command: "yt-dlp", outputDir: captureDir, extractor: "native" },
          environment: {
            apiKeySource: apiKey.source === "process.env" ? "process.env" : apiKey.source ? "env-file" : "missing",
            envFileProvided: Boolean(params.envFile),
            configDirProvided: Boolean(params.configDir),
            note: "pi-youtube-chorus reads YOUTUBE_API_KEY without printing key material; yt-dlp is invoked directly for transcript subtitles.",
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "youtube_chorus_context",
    label: "YouTube Chorus Context",
    description:
      "Load a previous YouTube Chorus capture directory and return a bounded model-ready context pack containing metadata, normalized transcript, comment signals, and ranked comments. Supports custom synthesis instructions.",
    promptSnippet: "Load captured YouTube transcript and comments into bounded model context.",
    promptGuidelines: [
      "Use youtube_chorus_context after youtube_chorus_capture to bring transcript and comments into the model context.",
      "When youtube_chorus_context reports truncation, reason from the visible data and mention that full artifacts are available by path.",
    ],
    parameters: ContextParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled." }], details: { cancelled: true } };
      }

      const captureDir = resolve(ctx.cwd, params.captureDir);
      const manifestPath = join(captureDir, "manifest.json");
      const manifest = await readJsonIfExists<CaptureManifest>(manifestPath);
      if (!manifest) {
        const suggestions = await nearbyCaptureDirs(ctx.cwd);
        throw new Error(
          [
            `No manifest.json found at: ${manifestPath}`,
            "youtube_chorus_context needs the exact captureDir returned by youtube_chorus_capture.",
            suggestions.length ? `Recent capture dirs:\n${suggestions.map((dir) => `- ${dir}`).join("\n")}` : undefined,
          ]
            .filter(Boolean)
            .join("\n")
        );
      }

      const transcript = await loadTranscriptForContext(captureDir, manifest);
      const options = commentOptions({
        commentsFormat: params.commentsFormat as CommentsFormat | undefined,
        commentsSort: params.commentsSort as CommentSort | undefined,
        maxCommentsInContext: params.maxCommentsInContext,
        includeReplies: params.includeReplies,
        includeLikelySpam: params.includeLikelySpam,
      });
      const comments = await loadCommentsForContext(captureDir, manifest, options);

      const input: ContextPackInput = {
        title: manifest.title,
        videoId: manifest.video_id,
        url: manifest.video_url,
        channel: manifest.channel,
        capturedAt: manifest.captured_at,
        captureDir,
        transcript: transcript.text,
        comments: comments.text,
        transcriptPath: transcript.path,
        commentsPath: comments.path,
        transcriptMaxChars: params.transcriptMaxChars ?? 20000,
        commentsMaxChars: params.commentsMaxChars ?? 20000,
        includeSynthesisGuidance: params.includeSynthesisGuidance ?? true,
        synthesisInstructions: params.synthesisInstructions,
        transcriptInstructions: params.transcriptInstructions,
        commentsInstructions: params.commentsInstructions,
        commentSignals: comments.commentSignals,
      };

      const pack = formatContextPack(input);

      return {
        content: [{ type: "text", text: pack.text }],
        details: {
          ...pack.details,
          manifestPath,
          manifest,
          commentsOptions: options,
          commentsAnalysis: comments.analysis
            ? {
                totalCount: comments.analysis.totalCount,
                likelySpamCount: comments.analysis.likelySpamCount,
                clusterCount: comments.analysis.clusters.length,
                clusters: comments.analysis.clusters,
              }
            : undefined,
        },
      };
    },
  });

  pi.registerCommand("yt-chorus", {
    description: "Capture a YouTube video transcript and comments, then ask the agent to synthesize them.",
    handler: async (args, ctx) => {
      const url = args?.trim() || (ctx.hasUI ? await ctx.ui.input("YouTube URL:") : undefined);
      if (!url) return;

      pi.sendUserMessage(
        [
          `Capture this YouTube video with youtube_chorus_capture: ${url}`,
          "Then load it with youtube_chorus_context using ranked comments, normalized transcript, and the default synthesis guidance.",
          "Synthesize a unified perspective from the speaker transcript and audience comments.",
          "Focus on claims, evidence, consensus, dissent, notable user insights, blind spots, and follow-up questions.",
        ].join("\n")
      );
    },
  });
}
