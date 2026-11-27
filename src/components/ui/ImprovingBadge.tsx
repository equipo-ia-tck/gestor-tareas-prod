import { Wrench } from 'lucide-react';

/**
 * «En mejora»: junto al título de todas las pantallas menos Hoy (petición de la usuaria, nov 2026), para que el equipo sepa
 * que se están cambiando. Para quitarlo, `IMPROVING = false`.
 */
export const IMPROVING = true;

export function ImprovingBadge({ className = '' }: { className?: string }) {
  if (!IMPROVING) return null;
  return (
    <span title="Estamos mejorando esta pantalla: puede que veas cambios en los próximos días. Lo nuevo ya está en Hoy."
      className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-[#FAECE7] px-2 py-0.5 align-middle text-[11px] font-normal tracking-normal text-[#712B13] normal-case dark:bg-[#4A1B0C] dark:text-[#F5C4B3] ${className}`}>
      <Wrench className="size-3" aria-hidden="true" />En mejora
    </span>
  );
}
