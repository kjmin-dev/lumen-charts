# Level of detail

Wide views draw from levels of detail: the engine keeps buckets of 16, 64, 256, ... bars (first
open, highest high, lowest low, last close; the largest volume), and above 16 bars per device pixel
the chart draws the coarsest level whose buckets fit a pixel column. Frame time stops growing with
the number of bars in view, and the main thread holds buckets instead of bars for wide views.
