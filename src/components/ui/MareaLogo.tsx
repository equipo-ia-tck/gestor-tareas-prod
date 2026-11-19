/**
 * Logo de Marea dibujado en la página (los mismos trazos que `public/logos/marea-lockup.svg`). Los colores son las
 * variables de marca (`--marc`, `--marta`), así que en tema oscuro queda igual que `marea-lockup-dark.svg` (blanco y coral
 * claro). El nombre va en texto de la página para que use Space Grotesk (dentro de un <img> no se cargaría la fuente).
 * Tamaño mínimo del lockup: 120 px de ancho; por debajo, solo el símbolo (`mark`).
 */
export function MareaLogo({ width = 132, mark = false, className = '' }: { width?: number; mark?: boolean; className?: string }) {
  const stroke = { fill: 'none', strokeWidth: 9, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  const paths = (
    <>
      <path d="M12 76 V28 A19 19 0 0 0 50 28 V76" stroke="var(--marc)" {...stroke} />
      <path d="M50 76 V28 A19 19 0 0 0 88 28 V76" stroke="var(--marta)" {...stroke} />
    </>
  );
  if (mark) {
    return (
      <svg viewBox="6 22 88 60" width={width} height={(width * 60) / 88} role="img" aria-label="Marea" className={className}>{paths}</svg>
    );
  }
  return (
    <svg viewBox="0 0 290 96" width={width} height={(width * 96) / 290} role="img" aria-label="Marea" className={className}>
      <g transform="translate(-6,-4)">{paths}</g>
      <text x="108" y="67" fontFamily="var(--font-display)" fontSize="60" fontWeight="700" letterSpacing="-1.5" fill="var(--marc)">marea</text>
    </svg>
  );
}
