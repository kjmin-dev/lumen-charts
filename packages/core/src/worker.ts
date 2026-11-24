import { type EngineScope, attachEngineHost } from '@lumen-charts/engine';

// Entry point of the engine worker. The global scope of a dedicated worker has the shape the host needs.
attachEngineHost(globalThis as unknown as EngineScope);
