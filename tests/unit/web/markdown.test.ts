import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Markdown } from '../../../src/web/markdown.tsx';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

test('renders the guideline subset: headings, paragraphs, lists and inline marks', () => {
  const html = render(
    '# Title\n\nA **bold** and *quiet* `code` line\ncontinued.\n\n- one\n- two\n  wrapped\n\n1. first\n2. second',
  );
  expect(html).toBe(
    '<h1>Title</h1><p>A <strong>bold</strong> and <em>quiet</em> <code>code</code> line continued.</p>' +
      '<ul><li>one</li><li>two wrapped</li></ul><ol><li>first</li><li>second</li></ol>',
  );
});

test('time links stay in the tool; web links open a new tab; anything else is plain text', () => {
  expect(render('[0:26](#rec/780)')).toBe('<p><a href="#rec/780">0:26</a></p>');
  expect(render('[site](https://example.com)')).toBe(
    '<p><a href="https://example.com" target="_blank" rel="noreferrer">site</a></p>',
  );
  expect(render('[x](javascript:alert(1))')).toBe('<p>x)</p>');
});

test('markup in the text is shown, never interpreted', () => {
  expect(render('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
});
