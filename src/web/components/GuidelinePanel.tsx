import { useEffect, useState } from 'react';
import { fetchText } from '../api.ts';
import { Markdown } from '../markdown.tsx';

/** The batch's guideline, shown as written: the tool never interprets it. */
export function GuidelinePanel({ version }: { readonly version: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    fetchText('/api/guideline').then(setText, () => setError(true));
  }, []);
  if (error) return <p className="empty">The guideline couldn't be loaded.</p>;
  if (text === null) return <p className="empty">Loading the guideline…</p>;
  return (
    <article className="guideline">
      <Markdown text={text} />
      <p className="guideline-version">Version {version}</p>
    </article>
  );
}
