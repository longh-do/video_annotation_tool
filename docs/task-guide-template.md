---
recordings: <pattern>, <pattern>
---

# [Task name, e.g. Stack the cups]

*To the writer (delete this paragraph):* save a copy as `[task-id].md` in the `tasks/` folder inside the recordings folder (or the folder you pass to `pnpm ingest --tasks`), then run `pnpm ingest` once so the new guide is matched to its recordings; later edits to the text show on the next page load. The task id is the file name: letters, digits, `-`, `_` and `.`. The header lists the recordings this task covers by id; in a pattern `*` matches any run of characters, and patterns are separated by commas or spaces. A recording gets the first guide, by file name, that covers it. The first `# ` heading is the guide's title. You write the guide before anyone has seen the recordings, so it has no timestamps, no links to moments and no recording ids. Replace everything in [brackets].

**Keep each [task] from [its start] to [its stop].** Cut everything else.

## Start

[The first frame of the task, anchored on an event anyone can see, e.g. the first frame in which a finger touches the item. Say which camera shows it best.]

## Stop

[The frame that ends the task, e.g. the first frame in which no finger touches the item after its final release.] The stop frame itself is not kept.

## Part of the task

- [What happens between start and stop and stays in, even if it looks like a break.]

## Not part of the task

- [What is cut although it looks related, e.g. picking up or putting down a tool.]

## When it's unclear

Mark your best guess, then press **Q**, choose the reason and say where in a short note. If the recording holds no useful task at all, press **N**.

- [A doubt likely in this task, and the reason to choose for it.]

## How this task is checked

A reviewer re-annotates a share of the recordings without seeing yours. A start within [n] frames and a stop within [n] frames of the reviewer's counts as agreement; the numbers are chosen for this task, from how sharp its start and stop are. A missing or extra interval matters more than a few frames.
