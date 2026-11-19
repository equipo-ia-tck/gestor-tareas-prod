import { useState } from 'react';
import { AlertTriangle, Pencil, Plus, UserRound, X } from 'lucide-react';
import type { RallyCc, RallyRef } from '../../domain/rally';
import type { CommentAddressee } from '../../domain/rallyComments';
import { lastAnalyst } from './AnalystPrompt';
import { AnalystSearch, OwnerMention } from './UserSearch';

/** Personas de un comentario de Rally: a quién va dirigido (primera mención) y el CC (analista y quien se añada). */
export interface CommentPeopleValue {
  /** Persona elegida a mano como destinataria (null = el Owner si `addressee` es `owner`, o nadie todavía). */
  to: RallyRef | null;
  analyst: RallyRef | null;
  others: RallyCc[];
}

export const ADDRESSEE_LABEL: Record<CommentAddressee, string> = { owner: 'PO (Owner)', analyst: 'Analista', 'po-it': 'PO IT' };

/** Valores de partida: el último analista donde se espera, y las personas propuestas en el CC. */
export function initialPeople(addressee: CommentAddressee, analystExpected: boolean, cc: RallyCc[] = []): CommentPeopleValue {
  const last = lastAnalyst();
  return {
    to: addressee === 'analyst' ? last : null,
    analyst: addressee !== 'analyst' && analystExpected ? last : null,
    others: cc,
  };
}

/** Todas las personas del CC, sin repetir (el analista primero). */
export function ccOf(v: CommentPeopleValue): RallyCc[] {
  const all: RallyCc[] = [...(v.analyst ? [{ name: v.analyst.name, ref: v.analyst.ref }] : []), ...v.others];
  return all.filter((p, i) => all.findIndex((x) => x.name === p.name) === i && p.name !== v.to?.name);
}

/** Nombre de la primera mención tal como se publicará (null = nadie). */
export function addresseeName(addressee: CommentAddressee, owner: string | null, v: CommentPeopleValue): string | null {
  return v.to?.name ?? (addressee === 'owner' ? owner : null);
}

/** Avisos de personas que faltan. No impiden publicar: solo se ve que se esperan. */
export function missingPeople(addressee: CommentAddressee, analystExpected: boolean, owner: string | null, v: CommentPeopleValue): string[] {
  const out: string[] = [];
  if (!addresseeName(addressee, owner, v)) {
    out.push(addressee === 'owner' ? 'No tiene Owner en Rally: no se menciona a ningún PO.' : `Falta elegir ${ADDRESSEE_LABEL[addressee] === 'Analista' ? 'al analista' : 'al PO IT'}.`);
  }
  if (analystExpected && addressee !== 'analyst' && !v.analyst) out.push('Falta el analista en el CC.');
  return out;
}

const chip = 'inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300';
const addBtn = 'inline-flex items-center gap-0.5 rounded-full border border-dashed border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:border-indigo-400 hover:text-indigo-700 dark:border-zinc-600 dark:text-zinc-300';

/**
 * Para: la persona a la que va el comentario. Con `owner`, el Owner del elemento con el lápiz para cambiarlo; con
 * `analyst` o `po-it`, se elige en Rally (de entrada, el último analista) y se marca en ámbar si falta.
 */
export function AddresseeRow({ addressee, owner, value, onChange }: {
  addressee: CommentAddressee;
  owner: string | null;
  value: CommentPeopleValue;
  onChange: (v: CommentPeopleValue) => void;
}) {
  const [open, setOpen] = useState(false);
  if (addressee === 'owner') {
    return (
      <div className="flex items-start gap-1.5">
        <span className="w-9 shrink-0 pt-0.5 text-xs text-zinc-500">Para</span>
        <OwnerMention owner={owner} value={value.to} onChange={(to) => onChange({ ...value, to })} />
      </div>
    );
  }
  const label = ADDRESSEE_LABEL[addressee];
  return (
    <div className="flex items-start gap-1.5">
      <span className="w-9 shrink-0 pt-0.5 text-xs text-zinc-500">Para</span>
      <span className="block min-w-0 flex-1">
        <button type="button" onClick={() => setOpen(!open)} title={`Elegir ${label.toLowerCase()} en Rally`}
          className={`inline-flex items-center gap-1 rounded px-0.5 text-xs font-medium ${value.to
            ? 'text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950'
            : 'text-amber-700 ring-1 ring-amber-400 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950'}`}>
          {value.to ? `@${value.to.name}` : `Elegir ${label}`}
          {value.to && <span className="font-normal text-zinc-400">· {label}</span>}
          <Pencil className="size-3 opacity-60" />
        </button>
        {open && (
          <span className="mt-1 block">
            <AnalystSearch value={value.to} onChange={(u) => { onChange({ ...value, to: u }); setOpen(false); }}
              placeholder={`Buscar ${label === 'Analista' ? 'al analista' : 'al PO IT'} en Rally`} autoFocus />
          </span>
        )}
      </span>
    </div>
  );
}

/** CC: el analista (marcar o no) y cualquier otra persona de Rally («+ Mencionar a alguien más»); cada una se quita con ✕. */
export function CcRow({ addressee, analystExpected, value, onChange }: {
  addressee: CommentAddressee;
  analystExpected: boolean;
  value: CommentPeopleValue;
  onChange: (v: CommentPeopleValue) => void;
}) {
  const [adding, setAdding] = useState<'analyst' | 'other' | null>(null);
  const saved = lastAnalyst();
  // Si el último analista ya está en el CC (p. ej. propuesto en Accepted), no se ofrece otra vez.
  const last = saved && !value.others.some((x) => x.ref === saved.ref || x.name === saved.name) ? saved : null;
  const showAnalyst = addressee !== 'analyst';
  return (
    <div className="flex items-start gap-1.5">
      <span className="w-9 shrink-0 pt-0.5 text-xs text-zinc-500">CC</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1">
          {showAnalyst && value.analyst && (
            <span className={chip} title="Analista">
              <UserRound className="size-3" />@{value.analyst.name}<span className="font-normal opacity-70">· analista</span>
              <button type="button" onClick={() => onChange({ ...value, analyst: null })} aria-label={`Quitar a ${value.analyst.name}`}
                className="opacity-60 hover:opacity-100"><X className="size-3" /></button>
            </span>
          )}
          {value.others.map((p) => (
            <span key={p.ref ?? p.uuid ?? p.name} className={chip}>
              @{p.name}
              <button type="button" onClick={() => onChange({ ...value, others: value.others.filter((x) => x !== p) })} aria-label={`Quitar a ${p.name}`}
                className="opacity-60 hover:opacity-100"><X className="size-3" /></button>
            </span>
          ))}
          {showAnalyst && !value.analyst && (
            last && adding !== 'analyst' ? (
              <span className={`${addBtn} ${analystExpected ? 'border-amber-400 text-amber-700 dark:text-amber-400' : ''}`}>
                <button type="button" onClick={() => onChange({ ...value, analyst: last })} title={`Marcar a ${last.name} como analista`}>
                  <Plus className="inline size-3" /> Analista: {last.name}
                </button>
                <button type="button" onClick={() => setAdding('analyst')} title="Elegir otro analista" className="ml-1 opacity-60 hover:opacity-100"><Pencil className="size-3" /></button>
              </span>
            ) : (
              <button type="button" onClick={() => setAdding(adding === 'analyst' ? null : 'analyst')}
                className={`${addBtn} ${analystExpected ? 'border-amber-400 text-amber-700 dark:text-amber-400' : ''}`}>
                <Plus className="size-3" /> Marcar analista
              </button>
            )
          )}
          <button type="button" onClick={() => setAdding(adding === 'other' ? null : 'other')} className={addBtn}>
            <Plus className="size-3" /> Mencionar a alguien más
          </button>
        </div>
        {adding && (
          <div className="mt-1">
            <AnalystSearch value={null} autoFocus
              placeholder={adding === 'analyst' ? 'Buscar al analista en Rally' : 'Buscar a quién mencionar en Rally'}
              onChange={(u) => {
                if (adding === 'analyst') onChange({ ...value, analyst: u });
                else if (!value.others.some((x) => x.ref === u.ref || x.name === u.name)) onChange({ ...value, others: [...value.others, { name: u.name, ref: u.ref }] });
                setAdding(null);
              }} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Avisos en ámbar de las personas que se esperan y faltan. */
export function MissingPeople({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {items.map((m) => (
        <p key={m} className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle className="size-3.5" />{m}</p>
      ))}
    </div>
  );
}
