import { useState } from 'react';
import { Check, Copy, ExternalLink, ListOrdered } from 'lucide-react';
import { routeHref } from '../../app/router';
import type { Inventory, InventorySource } from '../../domain/inventory';
import type { Chunk } from '../../domain/knowledge';
import { inventory } from '../../domain/inventory';

/** Una vez por pregunta y conjunto de trozos (recorrer toda la documentación no es gratis). */
const cache = new WeakMap<Chunk[], Map<string, Inventory | null>>();
export function inventoryFor(chunks: Chunk[], question: string): Inventory | null {
  let byQ = cache.get(chunks);
  if (!byQ) { byQ = new Map(); cache.set(chunks, byQ); }
  if (!byQ.has(question)) byQ.set(question, inventory(chunks, question));
  return byQ.get(question)!;
}

function hrefOf(s: InventorySource): { href: string; external: boolean } | null {
  if (/^https?:\/\//.test(s.ref)) return { href: s.ref, external: true };
  if (s.source === 'note') return { href: routeHref({ view: 'notes', id: s.ref }), external: false };
  if (s.source === 'list') return { href: routeHref({ view: 'lista' }), external: false };
  if (s.source === 'person') return { href: routeHref({ view: 'person', name: s.ref }), external: false };
  return null;
}

/** La línea con el identificador en negrita. */
function Line({ text, id }: { text: string; id: string }) {
  const re = new RegExp(`(${id.replace(/(\D+)(\d+)$/, (_, p: string, n: string) => `${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s_-]?${n}`)})(?!\\d)`, 'i');
  const m = re.exec(text);
  if (!m) return <>{text}</>;
  return <>{text.slice(0, m.index)}<b className="text-zinc-900 dark:text-zinc-50">{m[0]}</b>{text.slice(m.index + m[0].length)}</>;
}

/**
 * «Dame las evar que hay»: la lista exacta, sacada de toda la documentación (`domain/inventory.ts`), en vez de la IA (que
 * solo ve unos pocos trozos). Cada fila es texto de la fuente, con su enlace.
 */
export function InventoryAnswer({ inv }: { inv: Inventory }) {
  const [copied, setCopied] = useState(false);
  const word = inv.items[0]?.id.replace(/\d+$/, '') ?? inv.term;
  const copy = () => {
    const text = inv.items.map((i) => `${i.id}\t${i.line}\t${i.sources.map((s) => s.title).join(', ')}`).join('\n');
    void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };
  return (
    <div className="mb-3 rounded-md border-l-4 border-indigo-500 bg-indigo-50/60 px-3 py-2 text-sm dark:bg-indigo-950/40">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ListOrdered className="size-4 text-indigo-600 dark:text-indigo-300" />
        <p className="flex-1 font-medium text-zinc-800 dark:text-zinc-100">
          {inv.items.length}{inv.truncated ? '+' : ''} {word} distintas en la documentación
          {inv.about.length > 0 && <> donde se habla de «{inv.about.join(' ')}»</>}
        </p>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:bg-zinc-800">
          {copied ? <><Check className="size-3.5 text-emerald-600" />Copiada</> : <><Copy className="size-3.5" />Copiar lista</>}
        </button>
      </div>
      <p className="mb-2 text-xs text-zinc-500">Lista exacta, sin IA: cada fila es la línea de la documentación que mejor la explica, con dónde sale.</p>
      <div className="max-h-[60vh] overflow-y-auto rounded border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-800">
            <tr><th className="px-2 py-1 font-semibold">{word}</th><th className="px-2 py-1 font-semibold">Qué dice la documentación</th><th className="px-2 py-1 font-semibold">Dónde</th></tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {inv.items.map((i) => (
              <tr key={i.num} className="align-top">
                <td className="px-2 py-1 font-semibold whitespace-nowrap">{i.id}</td>
                <td className="px-2 py-1 text-zinc-700 dark:text-zinc-300"><Line text={i.line} id={i.id} /></td>
                <td className="px-2 py-1">
                  {i.sources.map((s, k) => {
                    const link = hrefOf(s);
                    const label = `${s.title}${s.section ? ` › ${s.section}` : ''}`;
                    return (
                      <span key={k} className="block max-w-56 truncate" title={label}>
                        {link
                          ? <a href={link.href} {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})} className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline dark:text-indigo-400">
                              {label}{link.external && <ExternalLink className="size-3 shrink-0" />}</a>
                          : label}
                      </span>
                    );
                  })}
                  {i.count > i.sources.length && <span className="text-zinc-400">sale {i.count} veces</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {inv.truncated && <p className="mt-1 text-xs text-zinc-500">Hay más: se enseñan las 300 primeras.</p>}
    </div>
  );
}
