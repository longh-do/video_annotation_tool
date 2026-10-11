import { type ReactNode, useRef } from 'react';
import type { Status } from '../../core/annotation.ts';
import type { TaskInfo } from '../../core/api-types.ts';
import { clock } from '../format.ts';
import { type Command, keysOf } from '../keymap.ts';
import type { SaveStatus } from '../saver.ts';
import { ChevronIcon, RedoIcon, UndoIcon } from './icons.tsx';
import { SaveChip } from './SaveChip.tsx';
import type { ToastMessage } from './Toast.tsx';

const STATUS: Record<Status, string> = {
  not_reviewed: 'Not submitted',
  complete: 'Submitted',
  needs_review: 'Needs review',
};

interface TopBarProps {
  /** Where the recording is in the queue. */
  readonly queueBar: ReactNode;
  readonly task: TaskInfo | null;
  readonly recordingId: string;
  readonly durationS: number;
  readonly status: Status;
  readonly saveStatus: SaveStatus;
  readonly editable: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onRun: (command: Command) => void;
  readonly onCommandMenu: () => void;
  /** The arrow beside Submit: the other outcomes, in a menu under it. */
  readonly onOutcomes: (button: HTMLElement) => void;
  readonly onToast: (message: ToastMessage) => void;
}

/**
 * What to do first, then where things stand: the task, the length, the status, the recording id
 * (only to quote, e.g. in a report) and the save state; then the command menu, undo, redo and the
 * outcomes.
 */
export function TopBar(props: TopBarProps) {
  const { task, recordingId, status, editable, onRun, onToast } = props;
  const outcomes = useRef<HTMLButtonElement>(null);
  return (
    <header className="topbar">
      {props.queueBar}
      <span
        className={`task-name${task ? '' : ' task-none'}`}
        title="The task to annotate: the Task tab says what to keep"
      >
        {task ? task.title : 'No task guide'}
      </span>
      <span className="recording-length" title="Length of the recording">
        {clock(props.durationS).replace(/\.\d$/, '')}
      </span>
      <span className={`status-pill status-${status}`}>{STATUS[status]}</span>
      <button
        type="button"
        className="recording-id"
        title="Recording ID: click to copy it, e.g. to report a problem"
        onClick={() =>
          navigator.clipboard.writeText(recordingId).then(
            () => onToast({ text: `Copied the recording ID ${recordingId}` }),
            () => onToast({ text: `Couldn't copy the recording ID: ${recordingId}` }),
          )
        }
      >
        {recordingId}
      </button>
      <SaveChip status={props.saveStatus} />
      <div className="topbar-actions">
        <button
          type="button"
          className="icon-button command-button"
          title={`Show command menu… ${keysOf('commandMenu').split(' or ')[0]}`}
          aria-label="Command menu"
          onClick={props.onCommandMenu}
        >
          ⌘
        </button>
        <button
          type="button"
          className="icon-button"
          title={`Undo (${keysOf('undo')})`}
          aria-label="Undo"
          disabled={!editable || !props.canUndo}
          onClick={() => onRun('undo')}
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          title={`Redo (${keysOf('redo')})`}
          aria-label="Redo"
          disabled={!editable || !props.canRedo}
          onClick={() => onRun('redo')}
        >
          <RedoIcon />
        </button>
        <span className="submit-group">
          <button
            type="button"
            className="primary"
            title={`Submit and open the next recording (${keysOf('submit')})`}
            disabled={!editable}
            onClick={() => onRun('submit')}
          >
            Submit
          </button>
          <button
            ref={outcomes}
            type="button"
            className="primary submit-more"
            title="Other outcomes"
            aria-label="Other outcomes"
            aria-haspopup="menu"
            disabled={!editable}
            onClick={() => {
              if (outcomes.current) props.onOutcomes(outcomes.current);
            }}
          >
            <ChevronIcon />
          </button>
        </span>
      </div>
    </header>
  );
}
