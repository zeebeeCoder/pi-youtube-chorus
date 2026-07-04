import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  analyzeComments,
  buildCaptureInvocation,
  buildRankedCommentsJsonl,
  buildRankedCommentsMarkdown,
  captureDirectoryCandidates,
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
  ytMcpDir: Type.Optional(
    Type.String({
      description:
        "Optional path to the yt-mcp repo. If omitted, pi-youtube-chorus expects yt-capture on PATH. Can also be set with YT_MCP_DIR.",
    })
  ),
  envFile: Type.Optional(Type.String({ description: "Optional .env file passed to yt-capture." })),
  configDir: Type.Optional(
    Type.String({ description: "Optional config directory passed to yt-capture." })
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
        "canonical keeps model-facing JSONL artifacts at the capture root and moves extractor-only raw files under raw/. legacy leaves all yt-capture files at the root.",
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

async function readJsonIfExists<T = Record<string, any>>(path: string): Promise<T | undefined> {
  const text = await readTextIfExists(path);
  if (!text) return undefined;
  return JSON.parse(text) as T;
}

function artifactPath(captureDir: string, manifest: Record<string, any> | undefined, key: string, file: string) {
  const manifestPath = manifest?.files?.[key];
  if (typeof manifestPath === "string") {
    return isAbsolute(manifestPath) ? manifestPath : resolve(captureDir, manifestPath);
  }
  return join(captureDir, file);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

async function findCaptureDirectory(cwd: string, expectedOutputDir: string, stdout: string): Promise<string> {
  const candidates = unique([
    expectedOutputDir,
    ...captureDirectoryCandidates(stdout).map((candidate) => resolve(cwd, candidate)),
  ]);

  for (const candidate of candidates) {
    if (await pathExists(join(candidate, "manifest.json"))) return candidate;
  }

  throw new Error(
    [
      "yt-capture completed but pi-youtube-chorus could not find manifest.json.",
      `Expected: ${expectedOutputDir}`,
      `Tried: ${candidates.join(", ")}`,
      "This usually means yt-capture changed its output contract or wrote outside the requested --output-dir.",
    ].join("\n")
  );
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

async function moveRawArtifactsToRawDir(captureDir: string, manifest: Record<string, any>) {
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

  const derived = manifest.derived && typeof manifest.derived === "object"
    ? {
        ...manifest.derived,
        files: Object.fromEntries(
          Object.keys(manifest.derived.files ?? {}).map((key) => [key, files[key] ?? manifest.derived.files[key]])
        ),
      }
    : manifest.derived;

  manifest.files = files;
  manifest.derived = derived;
  manifest.artifact_layout = "canonical";
  manifest.raw_dir = rawDir;
  await writeFile(join(captureDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { rawDir, moved };
}

async function materializeDerivedArtifacts(captureDir: string, manifest: Record<string, any>) {
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

async function loadTranscriptForContext(captureDir: string, manifest: Record<string, any> | undefined) {
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
  manifest: Record<string, any> | undefined,
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
      "Capture YouTube metadata, transcript, and comments as raw files using yt-capture, then derive normalized transcript text, transcript JSONL segments, scored comment JSONL, and lexical comment clusters. Returns artifact paths; does not summarize.",
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

      const ytMcpDirFromEnv = !params.ytMcpDir && Boolean(process.env.YT_MCP_DIR);
      const invocation = buildCaptureInvocation({
        videoUrl: params.videoUrl,
        cwd: ctx.cwd,
        outputDir: params.outputDir,
        maxComments: params.maxComments ?? 5000,
        maxWords: params.maxWords ?? 80000,
        ytMcpDir: params.ytMcpDir ?? process.env.YT_MCP_DIR,
        envFile: params.envFile,
        configDir: params.configDir,
      });

      onUpdate?.({
        content: [{ type: "text", text: `Capturing transcript and comments for ${invocation.videoId}...` }],
        details: { outputDir: invocation.outputDir },
      });

      const result = await pi.exec(invocation.command, invocation.args, { signal, timeout: 10 * 60_000, cwd: ctx.cwd });
      if (result.code !== 0) {
        throw new Error(
          `yt-capture failed. Ensure yt-capture is on PATH or set YT_MCP_DIR. ${result.stderr || result.stdout}`
        );
      }

      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled." }], details: { cancelled: true } };
      }

      const captureDir = await findCaptureDirectory(ctx.cwd, invocation.outputDir, result.stdout);
      const manifestPath = join(captureDir, "manifest.json");
      const manifest = await readJsonIfExists<Record<string, any>>(manifestPath);
      if (!manifest) throw new Error(`Capture manifest is missing or unreadable: ${manifestPath}`);

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

      const stats = manifest.stats ?? {};
      const derivedFiles = derived?.files ?? manifest.derived?.files ?? {};

      return {
        content: [
          {
            type: "text",
            text: [
              `Captured YouTube source data for ${manifest.title ?? invocation.videoId}.`,
              `Directory: ${captureDir}`,
              `Transcript words: ${stats.normalized_transcript_word_count ?? stats.transcript_word_count ?? "unknown"}`,
              `Transcript segments JSONL: ${derivedFiles.transcript_segments_jsonl ?? manifest.files?.transcript_segments_jsonl ?? "not generated"}`,
              `Comments: ${stats.comment_count ?? "unknown"}`,
              `Comment clusters: ${stats.comment_cluster_count ?? "unknown"}`,
              `Scored comments JSONL: ${derivedFiles.comments_scored_jsonl ?? manifest.files?.comments_scored_jsonl ?? "not generated"}`,
              `Artifact layout: ${manifest.artifact_layout ?? "legacy"}${canonicalLayout ? ` (raw files in ${canonicalLayout.rawDir})` : ""}`,
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
          invocation: { command: invocation.command, args: invocation.args, outputDir: invocation.outputDir },
          environment: {
            ytMcpDirSource: params.ytMcpDir ? "param" : ytMcpDirFromEnv ? "YT_MCP_DIR" : "PATH",
            envFileProvided: Boolean(params.envFile),
            configDirProvided: Boolean(params.configDir),
            note: "pi-youtube-chorus does not read or print API keys; yt-capture inherits the Pi process environment and receives --env-file/--config-dir when provided.",
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
      const manifest = await readJsonIfExists<Record<string, any>>(manifestPath);
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

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("yt-chorus", "YouTube Chorus");
  });
}
