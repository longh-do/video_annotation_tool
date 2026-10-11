# video_annotation_tool

> Work in progress. This README describes the tool being built; sections marked _to come_ fill in as each part lands.

A browser tool for marking which parts of an untrimmed, multi-camera recording to **keep**.

Annotators watch at 2× and press **S** when the task starts ("keep from here") and **D** when downtime begins ("cut from here"). A short check pass then visits each rough mark so it can be put on the exact frame. Each recording produces one JSON file listing its kept intervals as source-clock nanoseconds, so the same cuts apply to every synchronized stream. Source files are never modified.

## Quickstart

Requirements: Node 24+, pnpm 10, and Google Chrome or Microsoft Edge for annotating. ffmpeg is optional (thumbnails and extra checks at ingest).

```bash
pnpm install
pnpm lint   # Biome + TypeScript
pnpm test   # unit and property tests
```

The ingest and app commands arrive with the server and player.

## Controls

_To come._

## Saved format

_To come._

## Measuring speed without losing accuracy

_To come._

## Planned layout

| Path | What will live there |
|---|---|
| `src/core/` | Pure TypeScript: frame maps, the keep/cut timeline, export, scoring. No DOM or Node APIs. |
| `src/server/` | Small Node server: media with byte ranges, annotation saves, telemetry. |
| `src/web/` | React UI: player, timeline, check pass, queue. |
| `scripts/` | Ingest and scoring command-line tools. |
| `tests/` | Unit, property and end-to-end tests (synthetic data only). |
| `docs/` | Design notes, an example annotation guideline, scaling plan. |
