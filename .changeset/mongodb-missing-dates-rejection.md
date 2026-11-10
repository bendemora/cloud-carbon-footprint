---
'@cloud-carbon-footprint/app': patch
---

With `CACHE_MODE=MONGODB`, a footprint request made while MongoDB cannot be reached no longer ends the API process. `MongoDbCacheManager.getMissingDates` went on to query the collection after listing the collections had failed, and nothing handled the failure of that later query, so Node ended the process on the unhandled promise rejection (about 60 seconds after the request with the driver's default timeouts) and the client got an empty reply. Now a failed listing stops there, and a failed read of the cached dates is logged as a warning like any other failure in that method, so the request ends with the HTTP 500 that a failed load of the estimates gives, the API keeps running, and it serves requests again once MongoDB is back. The same change stops a request from hanging when the listing succeeds and the read of the cached dates then fails.
