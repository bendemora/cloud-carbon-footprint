---
'@cloud-carbon-footprint/app': patch
---

With `CACHE_MODE=MONGODB`, an estimates collection that exists but holds no rows is no longer reported as fully cached. `MongoDbCacheManager.getMissingDates` asked for the row count and for the cached dates at the same time, and only handled the empty collection when the count answered first. When the dates answered first (about 4 calls in 10 against MongoDB 6.0 on the same machine), it logged `Cannot read properties of undefined (reading 'dates')` and reported that no date was missing, so the request was answered from the empty cache without estimating anything. An empty answer for the cached dates now means that every requested date is missing. The collection is empty after a first request that produced no estimates, because loading from a missing collection creates it.
