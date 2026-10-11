import { useEffect, useState } from 'react';
import type { TaskInfo } from '../../core/api-types.ts';
import { fetchText } from '../api.ts';
import { Markdown } from '../markdown.tsx';

/**
 * The guide of this recording's task, shown as its writer wrote it: what to keep, and how to tell
 * where it starts and stops. The tool never interprets it.
 */
export function TaskPanel({ task }: { readonly task: TaskInfo | null }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (task)
      fetchText(`/api/tasks/${encodeURIComponent(task.id)}`).then(setText, () => setError(true));
  }, [task]);
  if (!task) {
    return (
      <p className="empty">
        No task guide covers this recording. Ask your lead what to keep before you start.
      </p>
    );
  }
  if (error) return <p className="empty">The task guide couldn't be loaded.</p>;
  if (text === null) return <p className="empty">Loading the task guide…</p>;
  return (
    <article className="guideline">
      <Markdown text={text} />
    </article>
  );
}
