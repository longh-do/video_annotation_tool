import { type ReactNode, useRef, useState } from 'react';

interface SidePanelProps {
  /** Tab label → content; the first tab opens first. */
  readonly tabs: Readonly<Record<string, ReactNode>>;
  readonly width: number;
  /** While its left edge is dragged; `done` when it is let go. */
  readonly onResize: (width: number, done: boolean) => void;
}

export const PANEL_WIDTH = { min: 240, normal: 320, max: 760 } as const;

/** Between the narrowest and the widest the panel may be, and never most of the window. */
export function clampPanelWidth(width: number): number {
  const widest = Math.min(PANEL_WIDTH.max, window.innerWidth * 0.6);
  return Math.round(Math.max(Math.min(width, widest), PANEL_WIDTH.min));
}

/**
 * Reference material beside the video: the kept intervals, the task and the general guide. Drag
 * its left edge to make it wider or narrower; a double click puts it back.
 */
export function SidePanel({ tabs, width, onResize }: SidePanelProps) {
  const labels = Object.keys(tabs);
  const [open, setOpen] = useState(labels[0]);
  const drag = useRef<{ readonly x: number; readonly width: number } | null>(null);
  const widthAt = (clientX: number) => {
    const start = drag.current ?? { x: clientX, width };
    return clampPanelWidth(start.width + start.x - clientX);
  };
  return (
    <section className="panel">
      {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no element of its own */}
      <div
        className="panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the side panel"
        aria-valuenow={width}
        tabIndex={-1}
        title="Drag to resize; double-click for the usual width"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width };
        }}
        onPointerMove={(event) => {
          if (drag.current) onResize(widthAt(event.clientX), false);
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          onResize(widthAt(event.clientX), true);
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onDoubleClick={() => onResize(PANEL_WIDTH.normal, true)}
      />
      <div className="panel-tabs" role="tablist">
        {labels.map((label) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={label === open}
            onClick={() => setOpen(label)}
          >
            {label}
          </button>
        ))}
      </div>
      {/* Every tab stays mounted, so switching keeps its scroll position and loaded content. */}
      {labels.map((label) => (
        <div
          key={label}
          className="panel-body"
          role="tabpanel"
          aria-label={label}
          hidden={label !== open}
        >
          {tabs[label]}
        </div>
      ))}
    </section>
  );
}
