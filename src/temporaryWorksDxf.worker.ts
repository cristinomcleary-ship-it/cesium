import { readPlanningDxf } from './temporaryWorksDxf.ts';

self.onmessage = async (event: MessageEvent<File>) => {
  try { self.postMessage({ value: await readPlanningDxf(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
