import type { SaveStatus } from '../saver.ts';

const TEXT: Record<Exclude<SaveStatus['kind'], 'offline'>, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  conflict: 'Conflict — saved from another tab or computer; reload',
  rejected: 'Not saved: the server refused it',
};

/** Where the annotation stands on the server: one state at a time, never ambiguous. */
export function SaveChip({ status }: { readonly status: SaveStatus }) {
  const detail =
    status.kind === 'rejected'
      ? status.problems.join('\n')
      : status.kind === 'offline'
        ? (status.serverError ?? undefined)
        : undefined;
  return (
    <span className={`save-chip save-${status.kind}`} title={detail} data-save={status.kind}>
      {status.kind === 'saved' ? '✓ ' : ''}
      {status.kind === 'offline' ? offlineText(status) : TEXT[status.kind]}
    </span>
  );
}

/** While saves fail: why (no answer, or a server error), and whether the change is kept. */
function offlineText({ serverError, kept }: Extract<SaveStatus, { kind: 'offline' }>): string {
  const why = serverError === null ? 'Offline' : 'Server error';
  return `${why} — ${kept ? 'kept on this computer' : 'not kept on this computer'}, retrying`;
}
