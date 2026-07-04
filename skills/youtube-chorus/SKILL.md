---
name: youtube-chorus
description: Synthesize a YouTube video from both transcript and audience comments using pi-youtube-chorus tools. Use when the user wants a unified perspective on a YouTube video, especially including what viewers/users are saying.
---

# YouTube Chorus

Use this skill to turn a YouTube video into a grounded synthesis from two sources:

1. **Speaker layer** — transcript, claims, structure, evidence, framing.
2. **Audience layer** — comments, corrections, dissent, user pain, examples, links, sentiment.

## Workflow

1. Call `youtube_chorus_capture` with the video URL.
   - Use smaller limits first if the user wants a quick pass: `maxComments: 200`, `maxWords: 20000`.
   - Use larger limits for research-grade synthesis.
2. Call `youtube_chorus_context` with the returned `captureDir`.
   - Default comment context is `ranked-markdown` sorted by `balanced` signals.
   - Use `commentsSort: "engagement"` for most-liked/replied comments, `"recency"` for newest reactions, or `"source"` to preserve capture order.
   - Pass `synthesisInstructions`, `transcriptInstructions`, or `commentsInstructions` when the user wants a specific analysis lens.
3. Synthesize from the context pack. Do not imply unseen comments if the context pack was truncated or ranked/sampled.
4. If the visible context is insufficient, ask for a larger context chunk or inspect the artifact paths.

## Output frame

Prefer this structure:

```markdown
# Unified YouTube Perspective

## Core thesis
What the video argues or demonstrates.

## Evidence and specifics
Concrete facts, names, numbers, tools, claims, examples.

## Audience chorus
What comments add: agreement, dissent, corrections, lived experience, links/resources.

## Tensions and blind spots
Where transcript and comments disagree, where evidence is weak, where assumptions appear.

## Practical takeaways
Actionable implications for the user.

## Follow-up questions
Research questions worth pursuing next.
```

## Guardrails

- Treat comments as signal, not truth.
- Separate speaker claims from commenter claims.
- Preserve links, names, product/tool references, numbers, and dates.
- Mention if comment or transcript data is truncated, ranked, or sampled.
- Treat comment clusters and scores as heuristic signals, not ground truth.
- Avoid generic summary when the comments materially change the interpretation.
