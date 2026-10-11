import type { SaveStatus } from '../saver.ts';

const TEXT: Record<SaveStatus['kind'], string> = {
  saved: 'Saved',
  saving: 'Saving…',
  offline: 'Offline — kept on this computer, retrying',
  conflict: 'Conflict — saved from another tab; reload',
  rejected: 'Not saved: the server refused it',
};

/** Where the annotation stands on the server: one state at a time, never ambiguous. */
export function SaveChip({ status }: { readonly status: SaveStatus }) {
  const detail = status.kind === 'rejected' ? status.problems.join('\n') : undefined;
  return (
    <span className={`save-chip save-${status.kind}`} title={detail} data-save={status.kind}>
      {status.kind === 'saved' ? '✓ ' : ''}
      {TEXT[status.kind]}
    </span>
  );
}
