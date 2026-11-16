---
'@lumen-charts/core': patch
'@lumen-charts/engine': patch
---

Make wide views with indicators and loads cheaper: the loops that take a highest and a lowest value
(pixel columns and price range of a series view, level-of-detail buckets, rolling highest and
lowest, Stochastic's range) use `Math.max` and `Math.min` instead of comparisons, which V8 compiles
without the branches that prices mispredict.

One rule now holds wherever an extreme is taken: of values that include zeros of both signs, the
highest is `+0` and the lowest is `-0`, whatever their order. Before, the zero met first was kept,
so the sign of such a zero could differ from now, and in the rolling highest and lowest (and
Stochastic) it depended on where a computation started. Nothing else changes: missing values are
skipped as before.
