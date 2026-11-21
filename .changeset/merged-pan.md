---
'@lumen-charts/core': patch
---

Make pans of wide views cheaper. Below a pixel per bar, a pan moves the pixel columns the bars are
merged into by whole pixels, so a series view now keeps the columns it holds and merges only those
the pan uncovers, instead of merging every column of every series again. With 20 indicators on 1M
candles, a pan frame takes 3.4 instead of 4.3 ms of JavaScript with 20,000 bars in view.
