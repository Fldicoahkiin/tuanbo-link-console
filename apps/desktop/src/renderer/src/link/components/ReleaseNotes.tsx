import { ArrowUpRight } from 'lucide-react';
import { Card } from '../ui';
import type { ReleaseNote, ReleaseNoteBlock, ReleaseNoteInline } from '../release-notes';

/** The website lists the notes of the version the update feed serves; the main process opens only this exact page. */
export const WEBSITE_CHANGELOG_URL = 'https://tuanbo-link.jinhefilm.com/download/#changelog';

type ReleaseNotesProps = {
  notes: readonly ReleaseNote[];
  currentVersion: string | null;
  /** A newer version the update feed offers; its notes are not in this build, so they are read on the website. */
  availableVersion: string | null;
};

export function ReleaseNotes({ notes, currentVersion, availableVersion }: ReleaseNotesProps): JSX.Element | null {
  if (!notes.length && !availableVersion) return null;
  return <Card title="更新日志" className="release-notes">
    {availableVersion ? <a className="release-notes-link" href={WEBSITE_CHANGELOG_URL} target="_blank" rel="noreferrer">
      在官网查看 {availableVersion} 的更新内容<ArrowUpRight aria-hidden="true" />
    </a> : null}
    {notes.map((note, index) => <details key={note.version} open={index === 0}>
      <summary>v{note.version}{note.version === currentVersion ? <span className="release-notes-current">当前版本</span> : null}</summary>
      {note.blocks.map((block, blockIndex) => <ReleaseNoteContent key={blockIndex} block={block} />)}
    </details>)}
  </Card>;
}

function ReleaseNoteContent({ block }: { block: ReleaseNoteBlock }): JSX.Element {
  switch (block.kind) {
    case 'heading': return <h4>{block.text}</h4>;
    case 'paragraph': return <p>{inline(block.content)}</p>;
    case 'list': return <ul>{block.items.map((item, index) => <li key={index}>{inline(item)}</li>)}</ul>;
  }
}

function inline(content: readonly ReleaseNoteInline[]): JSX.Element[] {
  return content.map((part, index) => part.strong ? <strong key={index}>{part.text}</strong> : <span key={index}>{part.text}</span>);
}
