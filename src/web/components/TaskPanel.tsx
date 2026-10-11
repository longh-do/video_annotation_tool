import { useEffect, useEffectEvent, useState } from 'react';
import type { GuideResponse, TaskInfo } from '../../core/api-types.ts';
import { fetchGuide } from '../api.ts';
import { Markdown } from '../markdown.tsx';

interface TaskPanelProps {
  readonly task: TaskInfo | null;
  /**
   * The guide as it is now, once read: the guide's file may have been edited since the recording
   * was loaded, with a new title or version.
   */
  readonly onGuide: (task: TaskInfo) => void;
}

/**
 * The guide of this recording's task, shown as its writer wrote it: what to keep, and how to tell
 * where it starts and stops. The tool never interprets it, and annotators can't change it: the
 * guide is its file in tasks/, read again whenever a recording opens.
 */
export function TaskPanel({ task, onGuide }: TaskPanelProps) {
  const id = task?.id ?? null;
  const [guide, setGuide] = useState<GuideResponse | null>(null);
  const [error, setError] = useState(false);
  const show = useEffectEvent((now: GuideResponse) => {
    setGuide(now);
    onGuide(now.info);
  });
  useEffect(() => {
    if (id) fetchGuide(id).then(show, () => setError(true));
  }, [id]);
  if (!task) {
    return (
      <p className="empty">
        No task guide covers this recording. Ask your lead what to keep before you start.
      </p>
    );
  }
  if (error) return <p className="empty">The task guide couldn't be loaded.</p>;
  if (guide === null) return <p className="empty">Loading the task guide…</p>;
  return (
    <article className="guideline">
      <Markdown text={guide.markdown} />
    </article>
  );
}
