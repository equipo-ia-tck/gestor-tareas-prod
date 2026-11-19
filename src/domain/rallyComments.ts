// Sin imports: lo usan la app y el servidor (Node lo ejecuta sin compilar).

/**
 * Comentarios que se dejan en la discusión de Rally al mover un elemento desde el gestor. Las US (y el resto de tipos)
 * hablan de crear o cambiar guías; los TS, de validarlas, así que tienen sus propios textos y a veces otra persona a la
 * que va dirigido el comentario.
 */
export const MOVE_COMMENTS = {
  defined: 'Guía definida correctamente',
  doing: 'Se comienza a trabajar en la guía solicitada',
  blocked: 'Guía bloqueada',
  done: 'Se finaliza la guía a la espera de validación',
  accepted: 'Tras la revisión y OK del PO, PO IT y analista, se entrega la guía y se da por Accepted la US.\n\nGracias!',
} as const;

export const TS_MOVE_COMMENTS = {
  defined: 'TS definida correctamente',
  doing: 'Se comienza a trabajar en la validación solicitada',
  blocked: 'TS bloqueada',
  done: 'Tengo la validación hecha por si la quieres revisar antes de la entrega',
  accepted: 'Tras la revisión con analista y validación, se entrega la validación y se da por Accepted la TS. Gracias!',
} as const;

export type MoveStep = keyof typeof MOVE_COMMENTS;

/** Textos según el tipo de elemento («TS» = Test Set; el resto, los de las guías). */
export const commentsFor = (kind: string | null | undefined) => (kind === 'TS' ? TS_MOVE_COMMENTS : MOVE_COMMENTS);

/**
 * Al quitar Ready. US: «Tengo la guía validada…» para el Owner. TS: el mismo comentario opcional que al pasar a
 * Completed, dirigido al analista.
 */
export const unreadyText = (kind: string | null | undefined) =>
  kind === 'TS' ? TS_MOVE_COMMENTS.done : 'Tengo la guía validada por si la quieres revisar antes de la reunión con PO y PO IT';

/** Texto al marcar Blocked con el botón (igual que al mover a Bloqueado). */
export const blockedText = (kind: string | null | undefined) => commentsFor(kind).blocked;

/**
 * A quién va dirigida la primera mención del comentario:
 * - `owner`: el Owner del elemento (el PO), que se puede cambiar con el lápiz.
 * - `analyst`: el analista (TS a Completed y TS al quitar Ready), elegido a mano; el analista ya no va en el CC.
 * - `po-it`: el PO IT (TS a Need Review), elegido a mano; el analista va en el CC.
 */
export type CommentAddressee = 'owner' | 'analyst' | 'po-it';

/** Cómo es la ventana del comentario en cada paso. */
export interface CommentShape {
  addressee: CommentAddressee;
  /** Se puede mover (o quitar Ready) sin comentar. */
  optional: boolean;
  /** Se espera un analista en el CC (se avisa si falta, pero no impide publicar). */
  analystExpected: boolean;
  /** Se propone en el CC a todas las personas ya mencionadas en el elemento. */
  ccEveryone: boolean;
}

export function commentShape(kind: string | null | undefined, step: MoveStep | 'unready' | 'need-review'): CommentShape {
  const base: CommentShape = { addressee: 'owner', optional: false, analystExpected: false, ccEveryone: false };
  if (kind !== 'TS') return base;
  if (step === 'done' || step === 'unready') return { ...base, addressee: 'analyst', optional: true };
  if (step === 'need-review') return { ...base, addressee: 'po-it', analystExpected: true };
  if (step === 'accepted') return { ...base, ccEveryone: true };
  return base;
}
