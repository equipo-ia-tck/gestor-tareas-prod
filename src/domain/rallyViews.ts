import type { RallyItem } from './rally';
import { fold } from './text';

/**
 * Vistas guardadas de la pantalla Rally: las mismas que el equipo usa en la «React Custom List» de Rally (dashboard de
 * Owners de etiquetado), con sus nombres. Se aplican sobre lo cargado (los proyectos elegidos).
 *
 * Como en Rally: varias condiciones sobre el mismo campo se cumplen con que valga una (o); condiciones sobre campos
 * distintos se tienen que cumplir todas (y). Así «14. Long tail» es (nombre con «long tail» o «longtail») y alguna de sus
 * etiquetas. Las comparaciones no distinguen mayúsculas ni tildes.
 */
export type RallyViewCondition =
  | { field: 'tags'; op: 'contains' | '!contains'; values: string[] }
  | { field: 'flowState'; op: '=' | '!='; values: string[] }
  | { field: 'name'; op: 'contains'; values: string[] }
  | { field: 'ready'; op: '='; value: boolean };

export interface RallyView { id: string; name: string; conditions: RallyViewCondition[] }

/** Las once etiquetas de VS (la vista 12 enseña lo que no tiene ninguna). */
const VS_TAGS = [
  'Otros Servicios', 'Empresas', 'Pagos Transaccionales', 'Onboarding', 'Cuentas y Tarjetas', 'Plataforma Transversal',
  'Ahorro e Inversiones', 'Prestamos e Hipotecas', 'Seguros', 'Longtail Etiquetado', 'Servicios no financieros',
];

const tags = (...values: string[]): RallyViewCondition => ({ field: 'tags', op: 'contains', values });

export const RALLY_VIEWS: RallyView[] = [
  { id: 'default', name: 'Default View', conditions: [] },
  { id: '01', name: '01. USs peticion de etiquetado', conditions: [] },
  { id: '02', name: '02. VS Pagos Transaccionales', conditions: [tags('Pagos Transaccionales')] },
  { id: '03', name: '03. VS Plataforma Transversal', conditions: [tags('Plataforma Transversal')] },
  { id: '04', name: '04. VS Cuentas y Tarjetas', conditions: [tags('Cuentas y Tarjetas')] },
  { id: '05', name: '05. VS Onboarding', conditions: [tags('Onboarding'), tags('ANA_etiquetado')] },
  { id: '06', name: '06. VS Préstamos e Hipotecas', conditions: [tags('Prestamos e Hipotecas')] },
  { id: '07', name: '07. VS Seguros', conditions: [tags('Seguros')] },
  { id: '08', name: '08. VS Ahorro e Inversiones', conditions: [tags('Ahorro e Inversiones')] },
  { id: '09', name: '09. VS Empresas', conditions: [tags('Empresas')] },
  { id: '10', name: '10. VS Servicios no financieros', conditions: [tags('Otros Servicios', 'Servicios no financieros')] },
  {
    id: '11-consultas', name: '11. Consultas', conditions: [
      tags('Consulta'),
      { field: 'flowState', op: '=', values: ['New', 'Defined', 'To Do', 'In-Progress', 'Completed', 'Blocked'] },
    ],
  },
  {
    id: '12', name: '12. US/ TS sin VS asignado', conditions: [
      { field: 'tags', op: '!contains', values: VS_TAGS },
      { field: 'flowState', op: '!=', values: ['Accepted', 'Completed'] },
    ],
  },
  { id: '13', name: '13. US/ TS pendiente validar OK', conditions: [{ field: 'ready', op: '=', value: true }] },
  {
    id: '14', name: '14. Long tail', conditions: [
      { field: 'name', op: 'contains', values: ['long tail'] },
      { field: 'name', op: 'contains', values: ['longtail'] },
      tags('Longtail', 'Longtail Etiquetado', '[UX] : Longtail'),
    ],
  },
];

function holds(c: RallyViewCondition, it: RallyItem): boolean {
  switch (c.field) {
    case 'tags': {
      const mine = new Set(it.tags.map(fold));
      const any = c.values.some((v) => mine.has(fold(v)));
      return c.op === 'contains' ? any : !any;
    }
    case 'flowState': {
      const any = c.values.some((v) => fold(v) === fold(it.state));
      return c.op === '=' ? any : !any;
    }
    case 'name':
      return c.values.some((v) => fold(it.name).includes(fold(v)));
    case 'ready':
      return it.ready === c.value;
  }
}

/** ¿Sale el elemento en la vista? Mismo campo: basta una condición; campos distintos: todas. */
export function inRallyView(view: RallyView, it: RallyItem): boolean {
  const byField = new Map<string, RallyViewCondition[]>();
  for (const c of view.conditions) byField.set(c.field, [...(byField.get(c.field) ?? []), c]);
  return [...byField.values()].every((group) => group.some((c) => holds(c, it)));
}
