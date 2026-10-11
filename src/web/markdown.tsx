/**
 * Renders a guideline written in a small subset of Markdown: headings, paragraphs, bulleted and
 * numbered lists, **bold**, *italic*, `code` and [links](…). It builds React elements, never HTML
 * strings, so a guideline can't inject markup. Links to `#<recording>/<frame>` stay in the tool and
 * jump to that moment; other links open in a new tab.
 */
import type { MouseEvent, ReactNode } from 'react';

type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] };

export function Markdown({ text }: { readonly text: string }) {
  return (
    <>
      {parseBlocks(text).map((block, i) => {
        const key = `${block.kind}-${i}`;
        if (block.kind === 'heading') {
          const Heading = block.level <= 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3';
          return <Heading key={key}>{inline(block.text)}</Heading>;
        }
        if (block.kind === 'paragraph') return <p key={key}>{inline(block.text)}</p>;
        const List = block.ordered ? 'ol' : 'ul';
        return (
          <List key={key}>
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </List>
        );
      })}
    </>
  );
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+\.\s+(.*)$/;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    if (list) blocks.push({ kind: 'list', ...list });
    paragraph = [];
    list = null;
  };
  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
    } else if (item) {
      const ordered = numbered !== null;
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[1] ?? '');
    } else if (line.trim() === '') flush();
    else if (list && /^\s+\S/.test(line)) {
      // A wrapped list item continues on an indented line.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

const INLINE = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\((.+?)\)/g;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, bold, italic, code, label, href] = match;
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = match.index;
    if (bold !== undefined) nodes.push(<strong key={key}>{inline(bold)}</strong>);
    else if (italic !== undefined) nodes.push(<em key={key}>{inline(italic)}</em>);
    else if (code !== undefined) nodes.push(<code key={key}>{code}</code>);
    else if (label !== undefined && href !== undefined) nodes.push(link(key, label, href));
    last = match.index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Links never take the focus: Space and Enter must keep reaching the shortcuts. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

function link(key: number, label: string, href: string): ReactNode {
  if (href.startsWith('#')) {
    return (
      <a key={key} href={href} onMouseDown={keepFocus}>
        {inline(label)}
      </a>
    );
  }
  if (!/^https?:\/\//.test(href)) return label;
  return (
    <a key={key} href={href} target="_blank" rel="noreferrer" onMouseDown={keepFocus}>
      {inline(label)}
    </a>
  );
}
