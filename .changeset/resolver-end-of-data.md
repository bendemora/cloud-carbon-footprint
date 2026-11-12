---
'@cloud-carbon-footprint/grid-intensity': patch
---

The resolver asks a source again for its capability before the capability TTL is over, when a usage period runs beyond the end of data the answer gives and the answer is an hour old. The end of a live source's data moves with the clock, and the TTL is 24 hours by default, so a long-running API server served a recent day from the hours the source had when it was first asked. The static source gives no end of data and is not affected.
