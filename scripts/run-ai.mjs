import { pathToFileURL } from 'node:url';
import { buildAiPoc } from './build-ai.mjs';

// Keep CLI arguments and environment unchanged; the compiled script owns execution.
await import(pathToFileURL(await buildAiPoc()).href);
