import type { ReactNode } from 'react';

/** Small icons drawn in the current text colour. They are decoration: buttons carry the words. */
function Svg({
  size = 16,
  strokeWidth = 1.6,
  children,
}: {
  readonly size?: number;
  readonly strokeWidth?: number;
  readonly children: ReactNode;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function PlayIcon() {
  return (
    <Svg>
      <path d="M5 3.2v9.6l7.5-4.8z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function PauseIcon() {
  return (
    <Svg>
      <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth={2.4} />
    </Svg>
  );
}

/** Go to the previous boundary: a bar, then a triangle pointing at it. */
export function PreviousIcon() {
  return (
    <Svg>
      <path d="M3.5 3.5v9" />
      <path d="M12.5 3.5v9L6 8z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function NextIcon() {
  return (
    <Svg>
      <path d="M12.5 3.5v9" />
      <path d="M3.5 3.5v9L10 8z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function UndoIcon() {
  return (
    <Svg>
      <path d="M6 3.5L3 6.5l3 3" />
      <path d="M3.5 6.5h6a3.5 3.5 0 0 1 0 7H7" />
    </Svg>
  );
}

export function RedoIcon() {
  return (
    <Svg>
      <path d="M10 3.5l3 3-3 3" />
      <path d="M12.5 6.5h-6a3.5 3.5 0 0 0 0 7H9" />
    </Svg>
  );
}

/** Something to look at before going on. */
export function WarningIcon() {
  return (
    <Svg>
      <path d="M8 2.5l6 11H2z" />
      <path d="M8 6.5v3.2M8 11.6v.1" />
    </Svg>
  );
}

export function ChevronIcon() {
  return (
    <Svg size={12}>
      <path d="M4 6l4 4 4-4" />
    </Svg>
  );
}

export function SoundIcon({ on }: { readonly on: boolean }) {
  return (
    <Svg>
      <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" fill="currentColor" />
      {on ? (
        <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4" />
      ) : (
        <path d="M11 6l4 4M15 6l-4 4" />
      )}
    </Svg>
  );
}

export function ListIcon() {
  return (
    <Svg size={14}>
      <path d="M2 4h12M2 8h12M2 12h8" />
    </Svg>
  );
}

/** A cut point on the timeline, like the badges of video editors. */
export function ScissorsIcon() {
  return (
    <Svg size={10} strokeWidth={1.8}>
      <circle cx="4" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M5.4 10.6L12 2M10.6 10.6L4 2" />
    </Svg>
  );
}
