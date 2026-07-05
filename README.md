# pi-youtube-chorus

Minimal Pi extension for treating YouTube videos as source data: transcript + comments + metadata, captured to files and exposed back to the model as bounded context.

## Why this exists

Existing Pi YouTube packages mostly cover transcripts, summaries, search, frames, or broad video understanding. The missing piece is audience signal: YouTube comments often contain corrections, dissent, use cases, links, and user language that materially changes the interpretation of a video.

`pi-youtube-chorus` keeps inference out of the extraction layer. It captures raw artifacts first, then lets the active Pi model synthesize from explicit data.

## Design principles

- **Minimal footprint**: native Pi extension, no daemon, no Python wrapper.
- **Lean extraction stack**: transcript subtitles come from the `yt-dlp` binary; metadata/comments come from YouTube Data API v3.
- **Data first**: transcript and comments are stored as files before any synthesis.
- **Context safe**: model-facing output is bounded and points to full artifacts when truncated.
- **Separation of concerns**: extension retrieves data; skill/prompt guides synthesis.

## Tools

### `youtube_chorus_capture`

Uses native fetch calls plus `yt-dlp` subtitles and writes the raw capture first:

- `metadata.json`
- `transcript.json`
- `transcript.txt`
- `comments.json`
- `comments.jsonl`
- `comments.md`
- `bundle.md`
- `manifest.json`

Then, by default, it post-processes those raw files into model-ready canonical artifacts:

- `transcript.segments.jsonl` — canonical transcript segments with timestamps
- `comments.scored.jsonl` — canonical comments with rank, source index, likes, replies, spam flags, and recency/engagement/balanced scores
- `comments.clusters.json` — lightweight lexical comment clusters for recurring audience themes
- `transcript.normalized.txt` — readable transcript view, including YouTube timedtext JSON normalization

With the default `artifactLayout: "canonical"`, extractor-only raw files are moved under `raw/`, while model-facing sources stay at the capture root. Canonical layout requires `postProcess: true`; if post-processing is disabled, the extension leaves the raw native extractor layout intact and reports a warning.

Parameters:

- `videoUrl` — YouTube URL or bare video id
- `maxComments` — default `5000`
- `maxWords` — default `80000`
- `outputDir` — optional; defaults to `.pi/youtube-chorus/<timestamp>-<videoId>`
- `envFile`, `configDir` — optional `.env` locations for `YOUTUBE_API_KEY`
- `postProcess` — default `true`; creates normalized transcript/comment signal artifacts
- `artifactLayout` — `canonical` or `legacy`; default `canonical`

Requirements:

```bash
brew install yt-dlp
export YOUTUBE_API_KEY=...
```

The API key is used for `videos.list` metadata (1 quota unit) and `commentThreads.list` pagination (about 1 unit per 100 comments, so a 5000-comment capture is roughly 51 units total). `yt-dlp` is used directly for subtitles and its version is recorded in `manifest.json`.

Environment/API key behavior:

- `pi-youtube-chorus` reads `YOUTUBE_API_KEY` from `process.env` first.
- If needed, it checks `.env` candidates in this order: explicit `envFile`, `configDir/.env`, `cwd/.env`, `~/.config/pi-youtube-chorus/.env`, then legacy `~/.config/yt-mcp/.env`.
- It never prints key material in tool output or details.
- Pi model/provider API keys are not used during capture; synthesis is performed by the active Pi model after context is loaded.

### `youtube_chorus_context`

Reads a capture directory and returns one bounded Markdown context pack:

- metadata
- default synthesis guidance
- normalized transcript
- comment signals and lexical clusters
- comments in `ranked-markdown`, `ranked-jsonl`, `markdown`, `jsonl`, or `json` form
- truncation details and artifact paths

Useful parameters:

- `commentsFormat` — default `ranked-markdown`
- `commentsSort` — `balanced`, `engagement`, `recency`, or `source`; default `balanced`
- `maxCommentsInContext` — default `100`
- `includeReplies` — default `true`
- `includeLikelySpam` — default `false`
- `synthesisInstructions` — custom overall synthesis instructions
- `transcriptInstructions` — custom transcript-layer instructions
- `commentsInstructions` — custom audience/comment-layer instructions
- `includeSynthesisGuidance` — default `true`

## Slash command

```text
/yt-chorus <youtube-url>
```

Queues a prompt that asks the agent to capture, load, and synthesize the video from transcript + comments.

## Install locally while developing

```bash
cd ~/code/opti/pi-youtube-chorus
npm install
pi -e .
```

Or add it to Pi settings later:

```bash
pi install ~/code/opti/pi-youtube-chorus
```

## Test

```bash
npm test
npm run typecheck
```

## Synthesis stance

The extension does not decide what the video means. It prepares raw and derived artifacts, injects bounded context, and includes default synthesis guidance. You can override or append task-specific instructions with `synthesisInstructions`, `transcriptInstructions`, and `commentsInstructions` when calling `youtube_chorus_context`.
