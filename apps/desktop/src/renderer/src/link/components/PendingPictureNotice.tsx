import { CircleAlert } from 'lucide-react';
import { pendingPictureNotice, type PendingPictureEdits } from '../view-models/pending-picture-edits';
import './timeline-pending.css';

/** The note above the editor's timeline, under its toolbar, that picture edits made while the song plays
 * wait for 停止 and a replay, counting deletions, which the timeline no longer draws. Not in the toolbar:
 * at 1280 × 720 its one row has no room left. Nothing while there are none. */
export function PendingPictureNotice({ edits }: { edits: PendingPictureEdits }): JSX.Element | null {
  const notice = pendingPictureNotice(edits);
  return notice ? <p className="timeline-pending-notice" role="status" title={`${notice.text}。${notice.detail}`}>
    <CircleAlert aria-hidden="true" /><strong>{notice.text}</strong><span>{notice.detail}</span>
  </p> : null;
}
