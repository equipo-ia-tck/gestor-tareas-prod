import type { ReactNode } from 'react';
import { ImprovingBadge } from '../../components/ui/ImprovingBadge';

export function ViewHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-bold">{title}<ImprovingBadge /></h1>
        {subtitle && <p className="text-sm text-zinc-500 first-letter:uppercase dark:text-zinc-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
