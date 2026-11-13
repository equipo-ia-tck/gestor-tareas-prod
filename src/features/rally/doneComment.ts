import guide from '../../../plantillas/guia-5-entrega.md?raw';
import { parseTemplate, templateComment } from '../../domain/templates';

/**
 * Comentario por defecto al pasar un elemento a Completed: el de la plantilla «Owner · Entrega de la guía» (la misma
 * del «Mensaje» al marcar Ready). Se puede cambiar con el lápiz antes de publicarlo.
 */
export const DONE_COMMENT = templateComment(parseTemplate('guia-5-entrega', guide));
