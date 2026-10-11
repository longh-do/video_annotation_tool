# Running it with 100 annotators

The prototype is one annotator on one machine. This is how the same tool would run a team of 100, and what would change in the code. The numbers are planning assumptions, to be replaced by what a pilot measures.

## What to optimise

The headline number is **quality-adjusted throughput**: accepted media-minutes per paid hour. Speed alone is the active real-time factor (active time ÷ recording length, from the tool's telemetry, where playback counts as activity); accuracy is boundary error in frames against gold, with missed and merged intervals reported apart from jitter. Accuracy is a floor and speed the objective above it: never one blended score, never targets ratcheted up each week (the documented way annotation shops end up gaming their metrics), and too-fast tasks or low watch coverage are flagged rather than rewarded.

Every tool change is an experiment: a within-annotator pilot (12–18 people, counterbalanced order: Start/Stop buttons at 1×, set-keys at 1.5×, set-keys at 2×), then a two-week live A/B with 5% gold, reporting the pair (Δspeed, Δaccuracy).

## Capacity

Accepted media-hours per day ≈ annotators × on-task hours × (1 − QA share) ÷ active real-time factor.

| | Start/Stop at 1× | This tool |
|---|---|---|
| Active real-time factor (assumed) | 1.2 | 0.7 |
| 100 annotators, 6.5 h on task, 20% QA | ≈ 430 media-hours/day | ≈ 740 media-hours/day |

The 0.7 roughly fits short recordings with few boundaries. On boundary-dense sessions the seconds per checked boundary decide the factor: at an estimated 5–8 s per check the 42-minute session comes to about 1.1–1.5 ([design](design.md)), so the pilot measures that first.

## Workflow

`QUEUED → LEASED → SUBMITTED (complete | needs_review) → ACCEPTED or REWORK`

- A lease gives one recording to one annotator; an expired lease never discards a draft (drafts are already saved with revisions, and the journal covers the browser side).
- `needs_review` never blocks the queue: a collection problem goes back to the collection team, an unclear boundary to a reviewer.
- Long recordings stay with one owner, resumed where they left off, so conventions stay consistent: the 42-minute session goes to one annotator, in two blocks (see Shifts). A recording over 20–30 minutes is split across annotators only when it is needed sooner than one person can finish it, into ~10-minute chunks cut inside idle gaps with 30–60 s of overlap.

## Quality

| Tier | Share | Purpose |
|---|---|---|
| Automatic checks | 100% | contract invariants, marks left unchecked, keep running to the end |
| Hidden gold | ~5% (20–30% in a new annotator's first shifts) | accuracy per annotator, never announced per task |
| Blind double annotation | ~10% | agreement, and gold candidates |
| Review | first 20–30 tasks of each annotator, then 10–15% chosen by risk | feedback, rework |
| Adjudication, reviewer audits with planted errors | as needed | keeps reviewers honest |

Steady-state QA costs about 20% of capacity. Pass/fail thresholds are per-task QA settings, not tool code: for guidelines anchored on visible contact and release, start around ≤ 10 frames for starts and ≤ 15 for stops, then calibrate each task's gates at the 80th–90th percentile of trained annotators on double-annotated pilot clips.

## People

- **Onboarding (~1.5–2 h):** keys from the first minute, with the Guide tab and the command menu (⌘K) to look them up; about eight ten-minute drills on gold clips with feedback, to a 90% criterion; a joint discussion of the first 6–12 recordings against the task's guideline; then covert gold, full review of the first 20–30 tasks and a weekly calibration with a guideline changelog. Accuracy on the first five tasks predicts long-run accuracy well, so that is where coaching pays.
- **Shifts:** 30–45-minute marking blocks, a break of at least 10 minutes every ~90 minutes, a warm-up gold clip per block, shifts of at most 8 hours; the 42-minute session runs as two blocks for the same annotator, with the break at a head-turn gap. Drift is tracked by time in block (signed bias, keep fraction, missed short intervals), never by speed alone.
- **Teams:** pods of about 12 annotators with a reviewer-lead; hourly pay with a quality-gated bonus.

## Architecture

| Prototype | Production |
|---|---|
| media served from the local disk with byte ranges | object storage behind a CDN, with byte ranges |
| `annotations/` files with a revision history and If-Match | Postgres with append-only annotation revisions, same API |
| the queue is every recording in the catalog | an assignment service with leases, and gold and overlap injected server-side |
| `pnpm ingest` | ingest workers: validation, the same checks, thumbnails, PTS-preserving proxies if seeks are slow on annotator laptops |
| `telemetry/events.jsonl` | an event pipeline into a warehouse for the KPIs above |
| — | a review mode of the same screen: Accept, Fix & accept, Return |

The prototype keeps a full copy of every autosave in `annotations/.history/<recording_id>/` (about 63 KB each at 320 boundaries; a long session saves hundreds) and lists that folder on every save and load. That is fine for one annotator; in production, revisions are rows found by index, and the drafts between outcomes are pruned or stored as differences.

The browser side would not change much: it already saves through a revisioned API, journals unsaved work, prefetches the next recording and logs the events the KPIs need. The annotator id, today the server's `--annotator` flag, would come from sign-in.
