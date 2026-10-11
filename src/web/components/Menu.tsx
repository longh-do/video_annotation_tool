import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  readonly label: string;
  readonly run: () => void;
  readonly disabled?: boolean;
  /** Removes something: drawn in red. */
  readonly danger?: boolean;
  /** One of several choices; true for the one in effect (e.g. the current speed). */
  readonly checked?: boolean;
  /** The key that does the same thing. */
  readonly keys?: string;
}

/** Where the menu opens: at the pointer, or under (else over) an element. */
export type MenuAnchor = { readonly x: number; readonly y: number } | DOMRect;

interface MenuProps {
  readonly label: string;
  /** Null draws a separator. */
  readonly items: readonly (MenuItem | null)[];
  readonly at: MenuAnchor;
  /** The button that opened it: pressing it again is left to the button. */
  readonly owner?: HTMLElement | null;
  readonly onClose: () => void;
}

const MARGIN = 8;

/**
 * A small menu: the timeline's right-click menu and the speed dropdown. A choice, a click
 * elsewhere, any key (which then does what it always does) or leaving the window closes it. It
 * never takes the keyboard focus, so the shortcuts keep working.
 */
export function Menu({ label, items, at, owner, onClose }: MenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Placed before it is painted, moved inside the window if it would stick out.
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const anchored = 'width' in at;
    let left = anchored ? at.left : at.x;
    let top = anchored ? at.bottom + 4 : at.y;
    // No room below: above the button, or above the pointer.
    if (top + height > innerHeight - MARGIN) top = (anchored ? at.top - 4 : at.y) - height;
    left = Math.min(left, innerWidth - MARGIN - width);
    setPlace({ left: Math.max(left, MARGIN), top: Math.max(top, MARGIN) });
  }, [at]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !owner?.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      onClose();
    };
    window.addEventListener('pointerdown', onPointer, { capture: true });
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointer, { capture: true });
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [owner, onClose]);

  return (
    <div
      ref={menu}
      className="menu"
      role="menu"
      aria-label={label}
      style={place ?? { left: 0, top: 0, visibility: 'hidden' }}
    >
      {items.map((item, i) => {
        if (item === null) return <hr key={i} className="menu-separator" />;
        const look = {
          type: 'button',
          className: `menu-item${item.danger ? ' menu-danger' : ''}`,
          disabled: item.disabled,
          onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
          onClick: () => {
            onClose();
            item.run();
          },
        } as const;
        const content = (
          <>
            <span className="menu-check">{item.checked ? '✓' : ''}</span>
            <span className="menu-label">{item.label}</span>
            {item.keys && <kbd>{item.keys}</kbd>}
          </>
        );
        return item.checked === undefined ? (
          <button key={item.label} role="menuitem" {...look}>
            {content}
          </button>
        ) : (
          <button key={item.label} role="menuitemradio" aria-checked={item.checked} {...look}>
            {content}
          </button>
        );
      })}
    </div>
  );
}
