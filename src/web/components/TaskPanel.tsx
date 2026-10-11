import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { GuideResponse, TaskInfo } from '../../core/api-types.ts';
import { ApiError, fetchGuide, saveGuide } from '../api.ts';
import { chordLabel } from '../keymap.ts';
import { Markdown } from '../markdown.tsx';

interface TaskPanelProps {
  readonly task: TaskInfo | null;
  /**
   * The guide as it is now, once read and after each edit: a recording loaded earlier can name an
   * older title or version.
   */
  readonly onGuide: (task: TaskInfo) => void;
}

/**
 * The guide of this recording's task, shown as its writer wrote it: what to keep, and how to tell
 * where it starts and stops. The tool never interprets it. Anyone can edit it here; the edit is
 * the task's guide from then on, for every recording it covers.
 */
export function TaskPanel({ task, onGuide }: TaskPanelProps) {
  const id = task?.id ?? null;
  const [guide, setGuide] = useState<GuideResponse | null>(null);
  const [error, setError] = useState(false);
  /** The text being edited; null while reading. */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null;

  const show = useEffectEvent((now: GuideResponse) => {
    setGuide(now);
    onGuide(now.info);
  });
  useEffect(() => {
    if (id) fetchGuide(id).then(show, () => setError(true));
  }, [id]);
  useEffect(() => {
    if (editing) text.current?.focus();
  }, [editing]);

  if (!task) {
    return (
      <p className="empty">
        No task guide covers this recording. Ask your lead what to keep before you start.
      </p>
    );
  }
  if (error) return <p className="empty">The task guide couldn't be loaded.</p>;
  if (guide === null) return <p className="empty">Loading the task guide…</p>;

  const stopEditing = () => {
    setDraft(null);
    setProblem(null);
  };
  const save = async () => {
    if (draft === null || saving) return;
    // Unchanged text keeps its version: nothing to save.
    if (draft === guide.markdown) return stopEditing();
    setSaving(true);
    setProblem(null);
    try {
      const saved = await saveGuide(task.id, guide.info.version, draft);
      setGuide(saved);
      onGuide(saved.info);
      stopEditing();
    } catch (failure) {
      setProblem(
        failure instanceof ApiError && failure.status === 412
          ? 'Someone changed this guide since you opened it. Copy your text, then reload the page to see theirs.'
          : "The guide couldn't be saved. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <article className="guideline">
        <button
          type="button"
          className="guide-edit"
          title="Edit this task's guide: the change applies to every recording of the task"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setDraft(guide.markdown)}
        >
          Edit
        </button>
        <Markdown text={guide.markdown} />
      </article>
    );
  }
  return (
    <form
      className="guide-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="guide-hint">Markdown. The change applies to every recording of this task.</p>
      <textarea
        ref={text}
        aria-label="Task guide"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          }
        }}
      />
      {problem && (
        <p className="guide-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          disabled={saving}
          onMouseDown={(event) => event.preventDefault()}
          onClick={stopEditing}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="primary"
          disabled={saving}
          onMouseDown={(event) => event.preventDefault()}
        >
          {saving ? 'Saving…' : 'Save'} <kbd>{chordLabel({ code: 'Enter', mod: true })}</kbd>
        </button>
      </div>
    </form>
  );
}
