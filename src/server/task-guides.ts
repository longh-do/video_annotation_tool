/**
 * Task guides: what to keep in the recordings of one task, written for people. Each is a Markdown
 * file named after its task (`stack-cups.md` is task `stack-cups`) that starts with a header naming
 * the recordings it covers. In a pattern `*` matches any run of characters; patterns are separated
 * by commas or spaces:
 *
 *   ---
 *   recordings: kitchen-*, lab-2-*
 *   ---
 *
 *   # Stack the cups
 *
 * A recording's task is the first guide, by file name, that covers it. The tool shows that guide
 * beside the video and stamps its version on every save, but never interprets it.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { isSafeRecordingId, type TaskGuide } from './catalog.ts';

/**
 * The guides in `dir` (only `*.md` directly in it), by task id in file-name order, and what was
 * wrong with the files skipped or partly ignored.
 */
export async function readTaskGuides(
  dir: string,
): Promise<{ tasks: Map<string, TaskGuide>; warnings: string[] }> {
  const tasks = new Map<string, TaskGuide>();
  const warnings: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
  for (const name of names.sort()) {
    const id = name.slice(0, -'.md'.length);
    // Task ids go into URLs, so they follow the rule for recording ids.
    if (!isSafeRecordingId(id)) {
      warnings.push(`${name}: not a plain name; skipped it`);
      continue;
    }
    const path = resolve(dir, name);
    const parsed = parseTaskGuide(path, await readFile(path, 'utf8'));
    warnings.push(...parsed.warnings.map((warning) => `${name}: ${warning}`));
    if (parsed.guide) tasks.set(id, parsed.guide);
  }
  return { tasks, warnings };
}

/** The tasks whose guides cover a recording, in file-name order. */
export function tasksCovering(
  recordingId: string,
  tasks: ReadonlyMap<string, TaskGuide>,
): string[] {
  return [...tasks]
    .filter(([, guide]) => guide.recordings.some((pattern) => matches(pattern, recordingId)))
    .map(([id]) => id);
}

/** What annotators read: the guide without its header. */
export function guideMarkdown(text: string): string {
  return splitHeader(text)?.markdown ?? text;
}

/** A hash of the whole file, so a save records exactly which text the annotator worked from. */
export function guideVersion(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

/** The guide's first `# ` heading, if it has one. */
export function guideTitle(text: string): string | null {
  return /^# +(.*\S)/m.exec(guideMarkdown(text))?.[1] ?? null;
}

/** A guide from its file's text, or null when it covers nothing; with what was wrong. */
function parseTaskGuide(
  path: string,
  text: string,
): { guide: TaskGuide | null; warnings: string[] } {
  const parts = splitHeader(text);
  if (!parts) return { guide: null, warnings: ['no header naming its recordings; skipped it'] };
  const warnings: string[] = [];
  const recordings: string[] = [];
  for (const line of parts.header) {
    const field = /^([^:]*):(.*)$/.exec(line);
    const key = (field?.[1] ?? line).trim();
    const value = field?.[2] ?? '';
    if (key === 'recordings') recordings.push(...value.split(/[\s,]+/).filter(Boolean));
    else warnings.push(`unknown header key "${key}"; ignored it`);
  }
  if (recordings.length === 0) {
    return { guide: null, warnings: [...warnings, 'its header names no recordings; skipped it'] };
  }
  const title = guideTitle(text) ?? basename(path);
  return { guide: { path, title, recordings }, warnings };
}

/**
 * The header's lines, between the `---` that opens the file and the next, and the Markdown after
 * it without the blank lines in between; null without a header.
 */
function splitHeader(text: string): { header: string[]; markdown: string } | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return null;
  return {
    header: lines.slice(1, end).filter((line) => line.trim() !== ''),
    markdown: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\s*\n/, ''),
  };
}

/** Whether a recording id fits a pattern in which `*` matches any run of characters. */
function matches(pattern: string, id: string): boolean {
  const literals = pattern.split('*').map((part) => part.replace(/[\\^$.|?+()[\]{}]/g, '\\$&'));
  return new RegExp(`^${literals.join('.*')}$`).test(id);
}
