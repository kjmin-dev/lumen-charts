---
'@lumen-charts/engine': patch
---

Start background work right after a command. A worker waited 20 ms after each command before it
recomputed indicators or built levels of detail, so the window request after a load could go first.
It now starts at once in 1 ms slices for those 20 ms: with 20 indicators, a 10k prepend through the
worker shows its indicators after about 19 instead of 52 ms, and a load of 1M bars settles about
30 ms sooner.
