import { MessageSquare } from 'lucide-react';
import { uploadedAt, type RallyItem } from '../../domain/rally';

/**
 * Icono de la discusión de un elemento de Rally (feedback: «saber a simple vista si el último en comentar fui yo»):
 * verde con ✓ si el último comentario es tuyo; ámbar si es de otra persona (puede que toque contestar). Sin discusión, nada.
 */
export function LastCommentIcon({ item, compact }: { item: Pick<RallyItem, 'lastComment'>; compact?: boolean }) {
  const c = item.lastComment;
  if (!c) return null;
  const when = c.date ? uploadedAt(c.date) : '';
  const title = c.mine ? `El último comentario es tuyo${when ? ` (${when})` : ''}` : `Último comentario de ${c.author ?? 'otra persona'}${when ? ` (${when})` : ''}`;
  return (
    <span title={title} aria-label={title}
      className={`relative inline-flex shrink-0 items-center ${c.mine ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
      <MessageSquare className={compact ? 'size-3.5' : 'size-4'} fill="currentColor" fillOpacity={0.15} />
      <span className="absolute inset-0 flex items-center justify-center text-[8px] leading-none font-bold">{c.mine ? '✓' : '!'}</span>
    </span>
  );
}
