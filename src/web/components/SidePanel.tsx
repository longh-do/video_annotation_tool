import { type ReactNode, useState } from 'react';

interface SidePanelProps {
  /** Tab label → content; the first tab opens first. */
  readonly tabs: Readonly<Record<string, ReactNode>>;
}

/** Reference material beside the video: the kept intervals and the guideline. */
export function SidePanel({ tabs }: SidePanelProps) {
  const labels = Object.keys(tabs);
  const [open, setOpen] = useState(labels[0]);
  return (
    <section className="panel">
      <div className="panel-tabs" role="tablist">
        {labels.map((label) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={label === open}
            onMouseDown={(event) => event.preventDefault()}
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
