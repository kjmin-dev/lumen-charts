/// <reference types="node" />
// Copies the standalone worker bundle emitted by `@lumen-ticks/engine` into a re-exporting package's
// `dist/worker.js` so `./worker` works as both a bundler worker entry and a standalone static asset URL.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceFile = join(root, 'packages/engine/dist/worker.js');
const targetDir = resolve(process.cwd(), 'dist');
const targetFile = join(targetDir, 'worker.js');
const staleMap = join(targetDir, 'worker.js.map');

// Strip the engine-local sourceMappingURL comment; declaration maps (`worker.d.ts.map`) remain intact.
const code = readFileSync(sourceFile, 'utf8').replace(/\n\/\/# sourceMappingURL=worker\.js\.map\s*$/, '\n');
writeFileSync(targetFile, code);
rmSync(staleMap, { force: true });
