import { boundariesToCheck } from '../../core/check.ts';
import { stateAt, type Timeline } from '../../core/timeline.ts';
import type { EditorAction } from '../editor.ts';
import { keysOf, matches } from '../keymap.ts';
import { type BarAction, ConfirmBar } from './ConfirmBar.tsx';

/** The annotator's decision about a recording: the outcome to save, and what to say after. */
export interface Decision {
  readonly action: EditorAction;
  readonly text: string;
  /** The toast offers Undo (else Back): only when undo restores what the outcome removed. */
  readonly undo: boolean;
}

/** A second ⌘↵ this soon after the first is not an answer to the question it raised. */
const ARM_MS = 500;

const plainEnter = (event: KeyboardEvent) =>
  event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey;
const submitKey = (event: KeyboardEvent) =>
  matches({ code: 'Enter', mod: true }, event) ||
  matches({ code: 'NumpadEnter', mod: true }, event);

/** Submitting the annotation as it is. */
export function submitDecision(recordingId: string): Decision {
  return { action: { type: 'submit' }, text: `Submitted ${recordingId}.`, undo: false };
}

/** The last frame is kept: the last interval never got its stop. */
export function keepsToEnd(timeline: Timeline): boolean {
  return stateAt(timeline, timeline.frameCount - 1) === 'keep';
}

interface OutcomeQuestionProps {
  /** Submit despite marks to check or a keep to the end, or "no useful task". */
  readonly question: 'submit' | 'no-task';
  readonly timeline: Timeline;
  readonly recordingId: string;
  readonly onDecision: (decision: Decision) => void;
  /** "Check them": the first mark that needs checking. */
  readonly onCheck: (frame: number) => void;
  readonly onCancel: () => void;
}

/** The question an outcome asks first, with its answers. */
export function OutcomeQuestion(props: OutcomeQuestionProps) {
  const { timeline, recordingId, onDecision, onCancel } = props;
  if (props.question === 'no-task') {
    return (
      <ConfirmBar
        title="No useful task?"
        details={['This cuts the whole recording and submits it.']}
        actions={[
          {
            label: 'Cut all and submit',
            keyLabel: keysOf('accept'),
            matches: plainEnter,
            run: () =>
              onDecision({
                action: { type: 'no-task' },
                text: `${recordingId}: no useful task.`,
                // The toast can undo it, if there was something to cut.
                undo: timeline.boundaries.length > 0,
              }),
          },
        ]}
        onCancel={onCancel}
      />
    );
  }

  const unchecked = boundariesToCheck(timeline);
  const toEnd = keepsToEnd(timeline);
  const actions: BarAction[] = [
    ...(unchecked.length > 0
      ? [
          {
            label: 'Check them',
            keyLabel: keysOf('accept'),
            matches: plainEnter,
            run: () => props.onCheck(timeline.boundaries[unchecked[0]!]!.frame),
          },
        ]
      : []),
    {
      label: 'Submit anyway',
      keyLabel: keysOf('submit'),
      matches: submitKey,
      run: () => onDecision(submitDecision(recordingId)),
    },
    // The recording may simply end before the task does.
    ...(toEnd
      ? [
          {
            label: 'Needs review: unfinished task',
            keyLabel: keysOf('needsReview'),
            matches: (event: KeyboardEvent) => matches({ key: 'q' }, event),
            run: () =>
              onDecision({
                action: {
                  type: 'needs-review',
                  reason: 'unfinished_task',
                  notes: 'Unfinished task',
                },
                text: `Sent ${recordingId} to review.`,
                undo: false,
              }),
          },
        ]
      : []),
  ];
  return (
    <ConfirmBar
      title="Submit anyway?"
      details={submitReasons(unchecked.length, toEnd)}
      actions={actions}
      armMs={ARM_MS}
      onCancel={onCancel}
    />
  );
}

/** What ⌘↵ asks about before submitting, in plain words. */
function submitReasons(unchecked: number, toEnd: boolean): string[] {
  const reasons: string[] = [];
  if (unchecked > 0) {
    const marks = unchecked === 1 ? '1 mark still needs' : `${unchecked} marks still need`;
    reasons.push(`${marks} checking. Marks made while the video plays can be a few frames late.`);
  }
  if (toEnd) {
    reasons.push(
      `The last interval has no stop, so it keeps everything to the end of the video. If the task ended earlier, go back and press Stop (${keysOf('cut')}) where it ends.`,
    );
  }
  return reasons;
}
