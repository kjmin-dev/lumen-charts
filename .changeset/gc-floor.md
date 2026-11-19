---
'@lumen-charts/core': patch
'@lumen-charts/engine': patch
---

Apply a tick without leaving garbage behind. The engine now sends the patches of an event packed
into two buffers instead of an object and a typed array per patch, and the chart reads them in
place. With 20 indicators on 1M bars a tick brings 243 patches: the main thread allocated 45 kB
for them per tick, which with the engine in a worker went straight to the old generation of its
heap and filled it every few hundred ticks; it now allocates under 2 kB. The chart draws and
behaves as before.

For code that reads engine events itself: `EngineEvent.patches` is a `Patches` (`index`, `data`)
instead of a `Patch[]`. `unpackPatches(event.patches)` gives the patches as objects, as before, and
`packPatches` packs such objects.
