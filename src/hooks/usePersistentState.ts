import { useEffect, useState } from 'react';

const EVENT = 'gestor-persistent-state';

/**
 * Estado recordado en este navegador (preferencias de vista). Si localStorage falla, funciona en memoria. Los componentes
 * que usan la misma clave se mantienen iguales (p. ej. los botones del tablero en los filtros y las columnas).
 */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const storageKey = `gestor-tareas:${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; value: unknown }>).detail;
      if (d.key === storageKey) setValue(d.value as T);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [storageKey]);
  const set = (v: T) => {
    setValue(v);
    try { localStorage.setItem(storageKey, JSON.stringify(v)); } catch { /* sin almacenamiento: solo en memoria */ }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { key: storageKey, value: v } }));
  };
  return [value, set];
}
