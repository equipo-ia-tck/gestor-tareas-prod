/** Worker del modelo de lenguaje del Asistente (WebLLM): el modelo corre aquí, en la gráfica, sin congelar la pantalla. */
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg);
