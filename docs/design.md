# Design

The job: hired annotators mark the **KEEP** intervals `[start, stop)` of untrimmed robot-demonstration recordings (a head camera and two gripper cameras, about 30 fps with a variable frame rate) and save one JSON file per recording. It is graded on speed, clear boundaries, easy recovery from mistakes and how quickly people learn it; with 100 annotators, data annotated per hour is what matters.

## The interaction: mark while watching, then check the cuts

1. **Mark at speed.** The video plays at 2× by default (any speed from 0.25× to 4× in the speed list, sticky). **S** (Start) means "keep from here", **D** (Stop) "cut from here". They *set* a state: S while already keeping does nothing, so a double press or a missed press never inverts the rest of the recording (the "mutually exclusive, exhaustive" coding model of Noldus Observer XT). Hold **F** to skim obvious downtime at 6×.
2. **Check the cuts.** A mark made during playback is stored where the key was pressed and *needs a check*: reaction time puts it late, and at 2× the delay doubles in frames (a key press in a fast stream lands ~0.38 s late, about 22 frames at 2×). Nothing is shifted silently. **Enter** visits each such mark: the video stops on it, `,` `.` move it a frame (⇧ for ten, the keys of Final Cut Pro's precision editor and Avid's trim mode), or the timeline zoomed in lets it be dragged frame by frame; **Enter** accepts it and goes on. Marks made while paused are exact and skip the pass.
3. **Submit and move on.** **⌘↵** saves and opens the next recording, prefetched while this one was being annotated (about 60 ms in the end-to-end tests). It asks first, in one bar, if marks still need checking (Enter goes to them, ⌘↵ again submits anyway) or if the last interval never stops (a forgotten D). The bar ignores keys for half a second, so a double ⌘↵ can't answer it unread.

Why this split rather than Start/Stop buttons at 1×:

| | Start/Stop buttons | Mark while watching + check |
|---|---|---|
| Watching | 1×, pause to click | 2×, never paused |
| Per boundary | ~1.3 s to point and click, eyes leave the video | ~0.3 s key press, eyes stay on the video |
| Precision | scrubbing back and forth | one guided look (~2–5 s) |
| 72 s folding clip | ~100 s | ~50 s |
| 42 min session, ~320 boundaries | ~50–60 min | ~32–48 min |

The time estimates come from published key-press and pointing costs and are to be measured: the tool logs what is needed (below). Two choices follow from the evidence: 2× is the default, and faster speeds are the annotator's call (referees' correct decisions fell from 89% to 82% to 75% at 1×, 2× and 3×; marks made that fast need checking all the more), and give stops extra care (people detect presence far better than absence, so "the task has ended" is the harder call; the score report keeps start and stop errors apart).

The key set stays small (large shortcut sets are what made older annotation tools slow to learn), and **⌘K** lists every command with its keys. Keys are fastest (a key press ~0.3 s against ~1.3 s to point and click; ATLAS measured 11.0 s per action with keys against 19.7 s in ELAN), but every action also has a button, a menu entry or a gesture on the timeline, so the tool works with the mouse alone.

## The screen

The head camera is shown large, the gripper cameras beside it; a click on a gripper camera shows it large instead (judging contact is often easier there). Which camera is large is only a matter of layout: no video element moves or reloads, the large camera plays along (the small ones jump to the matching frame when the video stops, so only one extra video is decoded), and the head camera always counts the frames that marks are saved on.

Below the video, a transport row (state, Start and Stop, time, previous boundary, play, next boundary, length, speed, sound, zoom) sits on one timeline for the whole recording, in the style of video editors such as Screen Studio: a time ruler on top, kept intervals as yellow clips with their length, cuts dark and hatched. Pinch, ⌘-scroll or ⌘+ ⌘− zoom it (the page itself never zooms), a sideways swipe pans it, and it follows the playhead a page at a time. Hovering shows the time and a thumbnail; a click jumps there, and a click on an interval selects it (the others are dimmed, here and in the list). The pointer turns into ↔ near a boundary, which can then be dragged, frame by frame; a badge on top of each boundary deletes it on a click (marks that need a check have a "?" badge). A right-click offers only what matters here: merge an interval with its neighbour, delete it, or keep a cut stretch. Only one thing is drawn per video frame, the playhead, so the timeline stays at 60 fps on the 42-minute session with 320 boundaries.

## The timeline model

A recording's annotation is an ordered list of **boundaries**, each `{frame, state: keep | cut, origin, checked}`; everything before the first is cut, and position `frameCount` is END, just after the last frame. Every edit is a pure function returning a new timeline (or the same object when nothing changed, so undo never records an empty step):

- S and D set a state from a frame on; a boundary whose state equals the one before it is a *through* boundary, drawn dashed and dropped from the output. Keeping it makes later edits local: deleting the boundary that made it redundant brings it back into effect.
- Moves (nudge, drag) are clamped between the neighbours, so the order never changes. Choosing the frame a mark that needs checking already sits on confirms it.
- The right-click menu sets a whole range to keep or cut (delete an interval, merge two, keep a stretch), removing the boundaries inside it, so it leaves nothing behind that changes nothing.
- Undo is unlimited, over immutable snapshots; a drag or a held nudge is one step.

Export maps frames to the reference camera's source timestamps: `start_ns` is the first kept frame, `end_ns` the first frame not kept, or the last frame + 1 ns at the end of the video. Nanoseconds are `BigInt` and decimal strings throughout; a Biome lint rule rejects any `Number(...)` of a nanosecond value, and one audited function converts a duration to seconds for display. `src/core` is pure TypeScript with no DOM or Node types (its own `tsconfig` enforces it), so every rule is unit- and property-tested with fast-check.

## Frame accuracy

"Which frame is on screen" comes from one place, `FrameClock`, built on `requestVideoFrameCallback`: each presented frame's media time is mapped through the frames CSV ("last presentation time ≤ t"), never through `currentTime`, which trails the picture during playback. Seeks aim slightly inside a frame (its presentation time + min(1 ms, half the gap to the next)), because Chrome truncates seek times to whole microseconds and would show the previous frame for ~2% of frames; every seek is verified against the next frame callback and retried once. One seek is in flight at a time and the newest request wins, so five quick → presses move exactly five frames. On pause, the player snaps to the frame actually on screen.

Measured with barcoded test clips: 200 of 200 marks made while paused save exactly the frame shown. During 2× playback a mark saves the last frame the browser reported presenting, which trails the picture by 0–3 frames, never ahead; no browser API reports a frame earlier than that, which is the other reason marks made while playing need a check. Firefox and Safari present frames ahead of their callbacks during playback, so marking is limited to Chrome and Edge.

## Saving and recovery

- Every change goes to an IndexedDB **journal** at once (strict durability; Chrome's default can lose the last writes in a crash) and to the server after 300 ms of quiet, never more than 2 s later. The save chip says "Saving…" as soon as a change waits.
- The server writes atomically (temp file, fsync, rename, directory fsync), keeps every revision, and refuses a save based on an old revision (412). A second tab on the same recording therefore stops with a conflict instead of overwriting.
- After a crash the journal is reopened if it builds on what the server has — including when the save that was in flight landed but the page died before hearing so — and otherwise the server's version wins and the annotator is told.
- Each recording's annotation (editor, undo history, saver) lives as long as the page, so going back to a recording keeps its undo history; the toast after "no useful task" can undo it. Keys stay off from an outcome until the next recording is on screen, so nothing typed in between lands on the wrong one.

```mermaid
flowchart LR
  downloads[(downloads:<br>videos, frames CSVs,<br>manifests)] -->|pnpm ingest| catalog[(derived/<br>catalog + thumbnails)]
  catalog --> server[local server]
  server -->|videos with byte ranges,<br>frames, task guides| ui[browser:<br>player · check pass · queue]
  ui -->|every change| journal[(IndexedDB journal)]
  ui -->|PUT with revision| server
  ui -->|events| server
  server --> annotations[(annotations/<br>contract + sidecar + history)]
  server --> telemetry[(telemetry/<br>events.jsonl)]
  annotations --> score[pnpm score]
  telemetry --> score
  gold[(gold/)] --> score
```

## Measurement

The page logs one event stream (opened, media ready, play/pause and speed, every kind of edit, save outcomes, a heartbeat every 15 s, and a summary per submitted task). Edit events are derived from the editor's actions in one place rather than from each control. The check pass is timed per boundary: from landing on a mark that needs checking to the Enter that leaves it, however the mark was moved meanwhile. Active time counts only while the recording is on screen and the page visible, and stops 30 s after the last input unless the video plays. `pnpm score` turns this, a gold folder and the annotations into the report described in the README. Speed and accuracy are reported side by side, never as one score.

## What the tool does not do, on purpose

- **No automatic detection or suggested boundaries**: ruled out by the company, and suggestions invite over-trust. The tool knows only keep and cut.
- **No task rules in code.** What counts as a task is the task's guide: a Markdown file per task, kept with the recordings (a `tasks/` folder beside them), chosen for each recording by a header listing the recordings it covers, shown in the Task tab and stamped (by its hash) on every save; the tool never interprets it. How to use the tool is a separate, general Guide tab. Nothing about a particular dataset ships in the tool or this repository, since whatever the tool shows, every annotator sees; see the [template](task-guide-template.md).
- **No sensor signal lanes** (the annotators work from the video; signal plots cost time per action), **no reaction-time compensation** (live marks are checked visibly instead), **no per-interval outcome labels** (an easy extension if wanted).
- **Not built yet:** leasing, review queues and dashboards for many annotators ([scaling](scaling.md)); a break prompt and "annotated up to" progress on long sessions; a player for multi-part videos (the model and export already handle parts).

## Decisions made while building

- Boundaries on the timeline are moved with the pointer. They were planned as ARIA sliders, but a slider that keyboard users cannot operate is worse than none; from the keyboard, boundaries move with `,` `.`.
- Fewer keys than planned: speed is a list instead of keys 1–4, and the back-2-s, move-nearest-boundary-here, flip and play-around keys are gone; merging, deleting and keeping a stretch moved to the timeline's right-click menu.
- Marks made while playing still need a check on ⌘↵, but only as a warning: the annotator can submit anyway.
- The check pass first had a filmstrip: 13 still frames from 1.5 s before a mark to 0.5 s after, one every 1/6 s, a click putting the mark on that frame (after Final Cut Pro's precision editor). It reserved a band of the screen that was empty most of the time, so it was taken out; `,` `.` and dragging on the zoomed-in timeline do the job. It is kept on the git branch `archive/filmstrip`.
- The server's byte-range support is checked from the browser (the path the video takes) instead of at server start.
- The timeline is drawn only when the annotation or the view changes; the playhead is a separate element that moves with every frame. A first version redrew a canvas every frame and made the video drop about a fifth of its frames at 2× on the long recording; `pnpm perf` fails if drops come back.
