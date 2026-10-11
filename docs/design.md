# Design

The job: hired annotators mark the **KEEP** intervals `[start, stop)` of untrimmed robot-demonstration recordings (a head camera and two gripper cameras, about 30 fps with a variable frame rate) and save one JSON file per recording. It is graded on speed, clear boundaries, easy recovery from mistakes and how quickly people learn it; with 100 annotators, data annotated per hour is what matters.

## The interaction: mark while watching, then check the cuts

1. **Mark at speed.** The video plays at 2× by default (any speed from 0.25× to 4× in the speed list, sticky). **S** (Start) means "keep from here", **D** (Stop) "cut from here". They *set* a state: S while already keeping does nothing, so a double press or a missed press never inverts the rest of the recording (the "mutually exclusive, exhaustive" coding model of Noldus Observer XT). Hold **F** (or the **6×** button) to skim obvious downtime at 6×.
2. **Check the cuts.** A mark made during playback is stored where the key was pressed and *needs a check*: reaction time puts it late, and at 2× the delay doubles in frames (in a fast image stream, key presses came ~0.38 s after the image: about 23 frames of video at 2×). Nothing is shifted silently. **Enter** visits each such mark: the video stops on it, `,` `.` move it a frame (⇧ for ten, Final Cut Pro's nudge keys), or the timeline zoomed in lets it be dragged frame by frame; **Enter** accepts it and goes on. Marks made while paused are exact and skip the pass.
3. **Submit and move on.** **⌘↵** saves and opens the next recording, prefetched while this one was being annotated (60–70 ms in the end-to-end tests, on small clips). It asks first if marks still need checking (Enter goes to them, ⌘↵ again submits anyway) or if the last interval never stops (a forgotten D), and with nothing kept it asks whether the recording has no useful task. The submit question ignores keys for half a second, so a double ⌘↵ can't answer it unread.

Why this split rather than Start/Stop buttons at 1× (every time below is an estimate, not a measurement):

| | Start/Stop buttons | Mark while watching + check |
|---|---|---|
| Watching | 1×, pause to click | 2×, never paused |
| Marking a boundary | ~1.3 s to point and click, eyes leave the video | ~0.3 s key press, eyes stay on the video |
| Putting it on the exact frame | scrubbing back and forth | the check pass: Enter, `,` `.` or a drag, Enter |
| 89 s folding recording, 2 boundaries | ~100–110 s | ~55–60 s |
| 42 min cable session, ~320 boundaries | ~75–90 min | ~50–65 min |

How the totals are made: watching is the length divided by the speed; the key press and the click are Keystroke-Level Model times; both columns get the same 5–8 s per boundary to reach the exact frame (in the check pass, a few keys or a drag and a look at each frame), which no one has timed yet. The ~320 boundaries assume each plug-in and each plug-out is an interval, about 160 of them judging by the head turns; no one has counted them. The gain is clear where watching dominates, as on the folding recordings. On the cable session it depends on the seconds per check: if boundaries may stay where the click put them, the buttons take about 50 min there (watching plus 320 clicks), and the tool's gain is exact boundaries, not time. The tool logs active time and the seconds per check (below), so a pilot can measure both.

2× is a starting default, not a measured optimum: it halves the watching, and the ActivityNet Captions annotation tool also defaulted to 2×. Speed can cost accuracy: in a small study (10 amateur referees judging offside), correct decisions fell from 89% at 1× to 82% at 2× and 75% at 3×, though only 1× against 3× was a significant difference. That is a reason to check live marks and to try 1.5× against 2× in the pilot ([scaling](scaling.md)), not proof that 2× is right; faster speeds are the annotator's call. Stops get extra care: people detect presence far better than absence (asked to press at images with a dog in a fast stream, people caught 94%; asked to press at images without one, 31%), so "the task has ended" is the harder call; the score report keeps start and stop errors apart.

The key set stays small, and **⌘K** lists every command with its keys. In ATLAS, a robot-demonstration tool with a small key set, an action took 11.0 s on average against 19.7 s in ELAN, which its authors put down to ELAN's large, hard-to-remember shortcut set (about three people per tool, both tools driven by keys). The case for keys over the mouse rests on the Keystroke-Level Model (~0.3 s per key press against ~1.3 s to point and click); no study was found that compares them for marking video. Every action also has a button, a menu entry or a gesture on the timeline, so the tool works with the mouse alone.

## The screen

The head camera is shown large, the gripper cameras beside it; a click on a gripper camera shows it large instead (judging contact is often easier there). Which camera is large is only a matter of layout: no video element moves or reloads, the large camera plays along (the small ones jump to the matching frame when the video stops, so only one extra video is decoded), and the head camera always counts the frames that marks are saved on.

Below the video, a transport row (state, Start and Stop, time, previous boundary, play, next boundary, length, speed, sound, zoom) sits on one timeline for the whole recording, in the style of video editors such as Screen Studio: a time ruler on top, kept intervals as yellow clips with their length, cuts dark and hatched. Pinch, ⌘-scroll or ⌘+ ⌘− zoom it (the page itself never zooms), a sideways swipe pans it, and it follows the playhead a page at a time. Hovering shows the time and a thumbnail; a click jumps there, and a click on an interval selects it (the others are dimmed, here and in the list). The pointer turns into ↔ near a boundary, which can then be dragged, frame by frame; a badge on top of each boundary deletes it on a click (marks that need a check have a "?" badge). A right-click offers only what matters here: merge an interval with its neighbour, delete it, or keep a cut stretch. Only one thing is drawn per video frame, the playhead, so the timeline stays at 60 fps on the 42-minute session with 320 boundaries placed on it (`pnpm perf`).

## The timeline model

A recording's annotation is an ordered list of **boundaries**, each `{frame, state: keep | cut, origin, checked}`; everything before the first is cut, and position `frameCount` is END, just after the last frame. Every edit is a pure function returning a new timeline (or the same object when nothing changed, so undo never records an empty step):

- S and D set a state from a frame on. A boundary whose state equals the one before it changes nothing, so it is dropped: left in place, it would quietly cut a later interval short (S and D on the same frame, then S earlier and D later). Undo brings back anything dropped.
- Moves (nudge, drag) are clamped between the neighbours, so the order never changes. A mark that is moved is where the annotator put it, so it is exact; a move that can't go anywhere changes nothing and confirms nothing. A drag that is cancelled or ends where it began leaves the annotation as it was, a submitted one included.
- The right-click menu sets a whole range to keep or cut (delete an interval, merge two, keep a stretch), removing the boundaries inside it, so it leaves nothing behind that changes nothing.
- Undo is unlimited, over immutable snapshots; a drag or a held nudge is one step.

Export maps frames to the reference camera's source timestamps: `start_ns` is the first kept frame, `end_ns` the first frame not kept, or the last frame + 1 ns at the end of the video. Nanoseconds are `BigInt` and decimal strings throughout. A Biome lint rule (`lint-rules/no-number-ns.grit`) flags `Number()`, `parseInt`, `parseFloat` and unary `+` applied to anything named like a timestamp (`…Ns`, `…_ns`, `ns`), and every such conversion inside `src/core`; a timestamp under another name outside the core gets past it. Two lines are exempt: one turns a duration into seconds for display, one parses the video times of the frames CSV. `src/core` is pure TypeScript with no DOM or Node types (its own `tsconfig` enforces it), so every rule is unit- and property-tested with fast-check.

## Frame accuracy

"Which frame is on screen" comes from one place, `FrameClock`, built on `requestVideoFrameCallback`: each presented frame's media time is mapped through the frames CSV ("last presentation time ≤ t"), never through `currentTime`, which trails the picture during playback. Seeks aim slightly inside a frame (its presentation time + min(1 ms, half the gap to the next)), because Chrome truncates seek times to whole microseconds and would show the previous frame for ~2% of frames; every seek is verified against the next frame callback and retried once. One seek is in flight at a time and the newest request wins, so five quick → presses move exactly five frames. On pause, the player snaps to the frame actually on screen.

Measured with barcoded test clips: 200 of 200 marks made while paused save exactly the frame shown. During 2× playback a mark saves the last frame the browser reported presenting; no browser API reports one sooner, which is the other reason marks made while playing need a check. In the test runs the saved frame was the one on screen for most presses, otherwise 1–3 frames behind it, never ahead; the end-to-end test allows up to 5 behind, as margin for a busy machine. Firefox and Safari present frames ahead of their callbacks during playback, so marking is limited to Chrome and Edge. With a gripper camera shown large, a mark is still the head camera's frame, but the large picture is only kept within 0.25 s × speed of it (after falling behind it may run up to 0.5 s × speed ahead), so a live mark judged on it can land that much early or late; on the test clips it stayed within 6 frames.

## Saving and recovery

- Every change goes to an IndexedDB **journal** at once (strict durability; Chrome's default can lose the last writes in a crash; a held key is written when it starts and when it is sent) and to the server after 300 ms of quiet, never more than 2 s later. The save chip says "Saving…" as soon as a change waits; if saving fails it says whether the server answered and whether the journal kept the change.
- The server writes atomically (temp file, fsync, rename, directory fsync except on Windows), keeps every revision, and refuses a save based on an old revision (412); the next load finishes a save that a crash cut short. Only one tab of a browser edits a recording (a Web Lock per recording; another tab opens it read-only), so only that tab uses its journal; a save from another browser or computer meets the 412 and stops with a conflict instead of overwriting. A save whose answer was lost is not a conflict: on a 412 the client first checks whether the server already holds exactly what it sent.
- After a crash the journal is reopened if it builds on what the server has — including when the save that was in flight landed but the page died before hearing so — and otherwise the server's version wins and the annotator is told.
- The current and the previous recording keep their annotation (editor, undo history, saver) in memory, and so does any recording with changes not saved yet: going back keeps its undo history, and the toast after "no useful task" can undo it. Older ones reopen from the server. Keys stay off from an outcome until the next recording is on screen, so nothing typed in between lands on the wrong one.

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
- **No task rules in code.** What counts as a task is the task's guide: a Markdown file per task in `tasks/`, chosen for each recording by a header listing the recordings it covers, shown in the Task tab and stamped (by its hash) on every save; the tool never interprets it. Guides are edited as files, never in the app, so annotators can't change the rules; an edit shows on the next page load, and every save after it carries the new version. How to use the tool is a separate, general Guide tab. The code and the Guide tab know nothing about any dataset, since whatever the tool shows, every annotator sees; the example recordings' guides are data in `tasks/`, shown only on the recordings they cover (the opt-in real-data tests also name them). See the [template](task-guide-template.md).
- **No sensor signal lanes** (the annotators work from the video; signal plots cost time per action), **no reaction-time compensation** (live marks are checked visibly instead), **no per-interval outcome labels** (an easy extension if wanted).
- **Not built yet:** leasing, review queues and dashboards for many annotators ([scaling](scaling.md)); a break prompt and "annotated up to" progress on long sessions; a player for multi-part videos (the model and export already handle parts).

## Decisions made while building

- Boundaries on the timeline are moved with the pointer. They were planned as ARIA sliders, but a slider that keyboard users cannot operate is worse than none; from the keyboard, boundaries move with `,` `.`.
- Fewer keys than planned: speed is a list instead of keys 1–4, and the back-2-s, move-nearest-boundary-here, flip and play-around keys are gone; merging, deleting and keeping a stretch moved to the timeline's right-click menu.
- Marks made while playing still need a check on ⌘↵, but only as a warning: the annotator can submit anyway.
- The check pass first had a filmstrip: 13 still frames from 1.5 s before a mark to 0.5 s after, one every 1/6 s, a click putting the mark on that frame (after Final Cut Pro's precision editor). It reserved a band of the screen that was empty most of the time, so it was taken out; `,` `.` and dragging on the zoomed-in timeline do the job. It is kept on the git branch `archive/filmstrip`.
- The tool serves the videos itself, with byte ranges, instead of through the `python3 -m http.server` that the recordings' README suggests: that server never answers range requests, so the browser can't seek (every seek snaps back to the start).
- The server's byte-range support is checked from the browser (the path the video takes) instead of at server start.
- The annotation templates of recordings 02 and 03 carry recording 01's id, so the id always comes from `manifest.json`; ingest warns about a template that names another recording.
- The timeline is drawn only when the annotation or the view changes; the playhead is a separate element that moves with every frame. A first version redrew a canvas every frame and made the video drop about a fifth of its frames at 2× on the long recording; `pnpm perf` fails if drops come back.

## Sources

- [Card, Moran & Newell 1980](https://doi.org/10.1145/358886.358895), the Keystroke-Level Model: a key press ~0.28 s; pointing 1.1 s plus a click 0.2 s.
- [Krishna et al. 2016](https://arxiv.org/abs/1602.04506): key presses in a fast image stream came 378 ms after the image (σ 92 ms); recall 0.94 when pressing for presence, 0.31 for absence.
- [Luis Del Campo & Morenas Martín 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7563065/): 10 amateur referees judging offside at 1×, 2× and 3×.
- [Krishna et al. 2017](https://arxiv.org/abs/1705.00754), ActivityNet Captions: videos shown at 2× by default.
- [ATLAS, 2026](https://arxiv.org/abs/2604.26637): 11.0 s per action against 19.7 s in ELAN; 18.5 s with signal plots.
- [The Observer XT 17 Reference Manual](https://cdn.noldus.com/download/landing/documentation-the-observer-xt/As5Lh73IR8baKIKd2NhXo5Tq6OapFp/MTc0NzM3MjM0OA%3D%3D) (Noldus, 2023): mutually exclusive and exhaustive behaviour groups.
- [Final Cut Pro keyboard shortcuts](https://support.apple.com/guide/final-cut-pro/keyboard-shortcuts-ver90ba5929/mac): Nudge Left and Right are `,` `.`, ten units with ⇧.
- [Dratsch et al. 2023](https://doi.org/10.1148/radiol.222176): automation bias, strongest in the least experienced readers.
- [requestVideoFrameCallback](https://wicg.github.io/video-rvfc/).
- [IndexedDB durability now defaults to relaxed](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed) (Chrome 121).
- [CPython issue 86809](https://github.com/python/cpython/issues/86809): `http.server` does not support range requests.
