# Documentation

| Where                               | What                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| [../README.md](../README.md)        | What the library is, a first chart, and the list of features          |
| [guide/](guide)                     | One file per feature: how to use it                                   |
| [design.md](design.md)              | The design: findings, principles, architecture, stages and gates      |
| [design/](design)                   | One file per stage or part of a stage: what was decided and built     |
| [benchmarks/](benchmarks/README.md) | The harness, and one file per round of measurements with its raw runs |
| [releasing.md](releasing.md)        | How the packages get to npm                                           |

## Where a change goes

The documents are split so that two pull requests rarely edit the same lines. Keep it that way:

- **A new feature** gets a file of its own in `guide/` and one line in the feature list of the
  [README](../README.md#features). A change to a feature edits that feature's guide only.
- **What a stage built or decided** gets a file of its own in `design/`
  (`stage-<number>-<topic>.md`) and one line at the end of the list below. Its headings are the
  sections of `design.md` it belongs to, with their numbers, so "section 7.1" means the same in
  both. `design.md` itself changes when the design does; it takes at most a one-line pointer to
  the new file under the section concerned.
- **New measurements** get a file of their own in `benchmarks/` and one line at the end of the
  [results list](benchmarks/README.md#results). The numbers stay there: the stage file links to
  them and gives only what the design needs.
- **A new benchmark scenario** is one module in `benchmarks/src/scenarios/` and its tests
  ([adding a scenario](benchmarks/README.md#adding-a-scenario)); no shared list names it.
- **A new open question** is one bullet at the end of section 10 of `design.md`. What later settles
  it goes into the stage file, with a one-line sub-bullet that links there.
- **The status line** of the README changes only when a stage is complete, and so does the
  paragraph that opens its feature list.

## What each stage built

- [design/stage-2.md](design/stage-2.md): level of detail and the memory limit (sections 4.1, 4.2).
- [design/stage-2-follow-ups.md](design/stage-2-follow-ups.md): every series under the memory limit, corrections, deletions and resolution changes (sections 4.1, 4.2, 8).
- [design/stage-3-indicators.md](design/stage-3-indicators.md): indicators in the engine, derived series and plugins (section 5.1).
- [design/stage-4-price-axes.md](design/stage-4-price-axes.md): several price axes and their scale modes (section 8.1).
- [design/stage-4-drawings.md](design/stage-4-drawings.md): drawings, primitives and custom renderers (sections 6.1, 7.1, 8, 9).
- [design/stage-4-time-zones.md](design/stage-4-time-zones.md): time zones and sessions (section 4.3).
- [design/stage-4-save-restore.md](design/stage-4-save-restore.md): save and restore of the chart's state (sections 7.2, 9).
- [design/stage-5-heatmap-scatter.md](design/stage-5-heatmap-scatter.md): heatmap and scatter series in the engine, drawn through a pixel buffer (sections 3, 4.4 to 4.6, 6.3, 7, 8, 9, 10).
- [design/stage-5.md](design/stage-5.md): the optional steps: partial redraw, the min/max loops, and what was rejected or deferred (sections 4.2, 5, 6.2, 9, 10).
- [design/stage-4-follow-ups.md](design/stage-4-follow-ups.md): handles derived from a drawing's points, primitives and drawings in autoscale, and restore by id (sections 7.1, 7.2, 8).

- [Rendering backends for mark series](design/stage-5-mark-renderers.md) covers the integrated backends, runtime selection and device qualification.
- [design/stage-5-mark-history.md](design/stage-5-mark-history.md): marks prepended and removed, let go under the memory limit and fetched back, a heatmap grid that follows the price, sizes, densities and readouts of scatters, timelines made from marks and indicators over them (sections 3 to 10).
