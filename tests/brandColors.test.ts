import { describe, expect, it } from 'vitest';
import { BRAND_COLORS, brandColorFor, colorFor, OLD_PROJECT_COLORS, textOn } from '../src/domain/colors';
import { PROJECT_COLORS } from '../src/domain/types';

describe('colores de Marea', () => {
  it('proyectos, grupos, etiquetas y personas usan la paleta de la marca', () => {
    expect(PROJECT_COLORS).toEqual(BRAND_COLORS);
    expect(BRAND_COLORS).toContain(colorFor('Ana'));
  });
  it('cada color de antes pasa a uno de Marea en el mismo orden; los demás se quedan', () => {
    expect(OLD_PROJECT_COLORS.map(brandColorFor)).toEqual(BRAND_COLORS);
    expect(brandColorFor('#EF4444')).toBe(BRAND_COLORS[4]); // rojo de proyecto (índice 4)
    expect(brandColorFor('#64748b')).toBe(BRAND_COLORS[12 % BRAND_COLORS.length]); // gris de etiqueta
    expect(brandColorFor('#123456')).toBeNull();
    expect(brandColorFor(BRAND_COLORS[0])).toBeNull(); // ya es de Marea: no se vuelve a tocar
  });
  it('texto blanco sobre los oscuros y azul marino sobre los claros', () => {
    expect(textOn('#1F7A5C')).toBe('#FFFFFF');
    expect(textOn('#8FB3FF')).toBe('#1B2B4B');
    expect(textOn('#A9B3C7')).toBe('#1B2B4B');
  });
});
