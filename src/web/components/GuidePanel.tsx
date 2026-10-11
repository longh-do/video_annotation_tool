import guide from '../guide.md?raw';
import { Markdown } from '../markdown.tsx';

/**
 * How to use the tool, the same for every task; what to keep is the Task tab's business. The
 * text is `src/web/guide.md`, plain Markdown, so it can be edited without touching code.
 */
export function GuidePanel() {
  return (
    <article className="guideline">
      <Markdown text={guide} />
    </article>
  );
}
