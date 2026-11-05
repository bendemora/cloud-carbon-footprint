# @cloud-carbon-footprint/core

## 2.0.0

### Major Changes

- fd33210: Service estimates carry provenance. `ServiceData` and `FootprintEstimate` gain an optional `provenance` (source, grid zone, granularity, basis, factor type, estimated flag, licence, quality tier, the gCO2e/kWh applied, model version). The `Provenance` type and its literal types now live in `common` and are re-exported by `grid-intensity`; `Provenance` gains `gCO2ePerKWh`. AWS, GCP and Azure attach it to every billing row. Unknown-usage rows now resolve grid intensity like other rows; with the default configuration this changes nothing, and with `ELECTRICITY_MAPS_TOKEN` set they now use the same Electricity Maps value as the known rows of the same region and day instead of the static factor. `common` and `core` take a major bump, as the design specifies for packages whose public types gained provenance fields. Provenance roughly doubles the size of each service estimate in API responses and in the estimates cache (about 250 more bytes of JSON per row with the default factors). With the LOCAL or GCS cache, one period's estimates must still fit in one string of about 512 MiB, so that limit falls from about 2.3 million rows to about 1.1 million; the API response and the MongoDB cache no longer have a limit of this kind.

### Patch Changes

- 1031ced: core: `estimateKwh` returns 0 kWh instead of Infinity or NaN when neither the region nor `Unknown` has a non-zero factor, so embodied emissions in a zone at 0 gCO2e/kWh no longer turn the row's kWh into Infinity. Results for any non-zero factor are unchanged.
- be5c136: Fixes from a review of the Phase 1 grid intensity work. With `ELECTRICITY_MAPS_TOKEN` set, an invalid token (HTTP 401 with `Invalid auth-token`) or an Electricity Maps server error (HTTP 5xx) now fails the request like a network error, instead of falling back to the default factors row by row and caching those rows. A 401 for a zone or endpoint the token has no access to still falls back for that zone, as before; the error is an `ElectricityMapsRequestError`, and Azure no longer skips the subscription when it sees one, so the run stops and nothing partial is cached. A region whose static factor is 0 (GCP `europe-north2` with `GCP_USE_CARBON_FREE_ENERGY_PERCENTAGE=true`) now gets provenance for the Unknown zone and factor that `estimateCo2` applies, instead of 0 gCO2e/kWh; the estimate itself is unchanged. The static factors are no longer checked against the 0 to 1500 gCO2e/kWh bounds meant for fetched data, which logged a misleading "Dropped 1 point" warning for GCP multi-regions; estimates are unchanged. With `GRID_INTENSITY_STORE=MONGODB`, a malformed `MONGODB_URI` or a missing `MONGODB_CREDENTIALS` file now logs a warning, without the user name or password from `MONGODB_URI`, and keeps points in memory instead of failing every AWS, GCP and Azure estimate. When rows with different provenance are merged into one service estimate, the merged row takes the more restrictive of their licences. The API's deployment package now includes `grid-intensity` instead of expecting it from npm.
- Updated dependencies [fd49e2b]
- Updated dependencies [241cdd9]
- Updated dependencies [be5c136]
- Updated dependencies [fd33210]
  - @cloud-carbon-footprint/common@3.0.0

## 1.0.0

### Major Changes

- b05c4ba: Upgraded the node to 24, jest and eslint.

### Patch Changes

- Updated dependencies [b05c4ba]
  - @cloud-carbon-footprint/common@2.0.0

## 0.17.3

### Patch Changes

- 65386330: bumps ramda dependency

## 0.17.2

### Patch Changes

- f1818030: Fixes pointer for main file

## 0.17.1

### Patch Changes

- 9e929f03: Fixes main field in package.json pointing to incorrect file
- Updated dependencies [1d297700]
- Updated dependencies [3f17990d]
  - @cloud-carbon-footprint/common@1.10.0

## 0.17.0

### Minor Changes

- a6423a68: Aggregate footprint estimates for AWS resources by tags.

### Patch Changes

- a6423a68: A small refactor to fix one of the null check errors by replacing a null date.
- a6423a68: updates ts-node dependency
- a6423a68: Refactored to resolve null check errors and make code more efficient.
- a6423a68: Add default values to get rid of null check errors.
- Updated dependencies [a6423a68]
- Updated dependencies [a6423a68]
- Updated dependencies [a6423a68]
  - @cloud-carbon-footprint/common@1.8.0

## 0.16.1

### Patch Changes

- 510d4b86: updates packages: axios googleapis dotenv @types/jest-when

  See [this commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/8d8c1db6ff94da5127d559e10632479a8520c67a) for changes to the create-app templates.

- ff05607b: Bumps to latest version of typescript and sets resolution for this

  See [this commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/6cdc1469dcd5380c9c8a84b9fe13b977991db54c) for changes to the create-app templates.

- Updated dependencies [510d4b86]
- Updated dependencies [ff05607b]
  - @cloud-carbon-footprint/common@1.5.1

## 0.16.0

### Minor Changes

- 497ae495: Adds support for estimating energy and carbon emissions for Azure GPU VMs
- ef6af294: Adds initial support for energy/carbon estimation for GPU instances for AWS and GCP
- 9938c9b0: refactors ccf for v1 implementation of on-premise estimations
  Refer to [this](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/b3ba4120d633a8b83bf8bc0c131855dd67e6a288) commit to update cli package templates.

### Patch Changes

- Updated dependencies [7ecd432d]
- Updated dependencies [9fcbfc67]
- Updated dependencies [9938c9b0]
  - @cloud-carbon-footprint/common@1.5.0

## 0.15.0

### Minor Changes

- a23e1e59: Updates logic for handling unknown usage types to dynamically build kilowatt hour per usage amount (GCP, Azure) or cost (AWS) by service name and usage unit, to increase accuracy.

### Patch Changes

- Updated dependencies [f40ce29e]
- Updated dependencies [04f2be16]
  - @cloud-carbon-footprint/common@1.4.0

## 0.14.0

### Minor Changes

- 808085cc: Adds replication factor for Cloud Spanner and Kubernetes engine and updates unsoported usage types
- aaeb61a3: Updates estimation for unknown usage types to calculate kilowatt hours first, then co2e, to improve acccuracy

### Patch Changes

- 8fd171ed: Updates a number of packages and fixes linting, typescript and dependency issues
- Updated dependencies [8fd171ed]
  - @cloud-carbon-footprint/common@1.3.1

## 0.13.0

### Minor Changes

- c29a3b53: Adds support for specifying groupBy via API param and for displaying line chart data according to data grouping

  For changes to create-app templates, please refer to this [commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/8743e9a36f005716095300b7a1f331b4ffaa8100).

### Patch Changes

- Updated dependencies [c29a3b53]
  - @cloud-carbon-footprint/common@1.3.0

## 0.12.1

### Patch Changes

- a304acb6: Upgrades version of typescript to 4.5.3
- Updated dependencies [a304acb6]
  - @cloud-carbon-footprint/common@1.2.1

## 0.12.0

### Minor Changes

- 4238d3b8: "Add embodied emissions to the estimations for GCP"

### Patch Changes

- 4238d3b8: Bug fix in core package to handle no estimates and implementation of terraform deployments for aws
- 4238d3b8: changeset: Adds embodied emissions to the estimations for AWS and Azure

## 0.11.1

### Patch Changes

- 8b200348: Renames numberOfvCpus in ComputeUsage to match its use in ComputeEstimator

## 0.11.0

### Minor Changes

- c439b0ba: implements reclassification and estimations for unknown usage rows
- 52237bc6: Adds additional dashboard for viewing cloud provider recommendations including refactoring filters for reusability

  For updating the create-app templates, please refer to the following [commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/d1f9a94ea88e6f9210a781e16df18b9f64a0b03d).

### Patch Changes

- Updated dependencies [f3569daa]
- Updated dependencies [61332214]
- Updated dependencies [52237bc6]
  - @cloud-carbon-footprint/common@1.2.0

## 0.10.0

### Minor Changes

- 5a0aab5b: implements classifying unknown usage types for aws

## 0.9.0

### Minor Changes

- 13f39ac7: implements recommendations for aws rightsizing recommendations api

  Please refer to this [commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/b2181a1942b0910613c8b15f97d074a7be6100b8) to update create app templates.

- e76d5fdd: Adds accountId to the Estimation Results returned from the Cloud Carbon Footprint API

  Please refer to this [commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/cd2d5b988544246d87abbc441895d76003fed72b) to update create app templates.

### Patch Changes

- bbceed8b: Updates dependencies: @types/fs-extra, typescript, husky and @types/node
- Updated dependencies [13f39ac7]
- Updated dependencies [91ed3d75]
- Updated dependencies [72fc2752]
- Updated dependencies [e76d5fdd]
- Updated dependencies [bbceed8b]
  - @cloud-carbon-footprint/common@1.0.0

## 0.8.2

### Patch Changes

- e93d31ec: Extracts common data from cloud providers
- 3b42775b: Updates @types/node to 15.12.4
- Updated dependencies [e93d31ec]
- Updated dependencies [3b42775b]
- Updated dependencies [53366130]
  - @cloud-carbon-footprint/common@0.0.3

## 0.8.1

### Patch Changes

- 3f283737: Adds support for regions with unknown constants
- Updated dependencies [8e24c32b]
  - @cloud-carbon-footprint/common@0.0.2

## 0.8.0

### Minor Changes

- f9fbcb4c: Updates GCPCredentials class to us the @google-cloud/iam-credentials library instead, to reduce the core package size
- ababb826: Extracts two new packages app and common to avoid circular dependancies and make it easier to extract cloud provider packages
- e84a4c7a: Extract logic into the new packages: app, common, gcp, aws, azure:

  There are many files that have been updated/extracted.
  In order to update create-app templates, refer to the follow [commit](https://github.com/cloud-carbon-footprint/cloud-carbon-footprint/commit/8c6aaed52e9f3949e134852986d50362aad3367a).

  The following changes were made to,
  'packages/create-app/templates/default-app/packages/client/tsconfig.json':

  ```diff
      // ...
          "skipLibCheck": true,
          "esModuleInterop": true,
          "allowSyntheticDefaultImports": true,
  -        "strict": true,
          "forceConsistentCasingInFileNames": true,
          "module": "esnext",
          "moduleResolution": "node",
          "resolveJsonModule": true,
  -        "isolatedModules": true,
          "noEmit": true,
          "jsx": "react-jsx",
  -        "noFallthroughCasesInSwitch": true
  +        "noFallthroughCasesInSwitch": true,
  +        "strict": false,
  +        "isolatedModules": true
        },
  -      "include": [
  -        "src",
  -        "node_modules/apexcharts/types/apexcharts.d.ts"
  -      ]
  +      "include": ["src"]
      }
      // ...
  ```

  Additionally, the following dependencies have been updated and should also be updated in their respective template package.json file:
  - @cloud-carbon-footprint root package.json:
    - "@types/fs-extra": "^9.0.11"
    - "concurrently": "^6.2.0"
    - "marked": ">=2.0.5"
  - @cloud-carbon-footprint/api and @cloud-carbon-footprint/cli:
    - "dotenv": "^10.0.0"
    - "@cloud-carbon-footprint/app": Can be added with `yarn up @cloud-carbon-footprint/app`
    - "@cloud-carbon-footprint/common": Can be added with `yarn up @cloud-carbon-footprint/common`
  - @cloud-carbon-footprint/client:
    - "dotenv": "^10.0.0"
    - "@testing-library/react-hooks": "^7.0.0"
    - "concurrently": "^6.2.0"
    - "@cloud-carbon-footprint/common": Can be added with `yarn up @cloud-carbon-footprint/common`

### Patch Changes

- c7fa7db0: Updates dependencies to the latest

## 0.7.0

### Minor Changes

- 68365cbf: implements memory calculations for gcp
- 8df5703b: implements memory calculations for azure
- 3e2f876d: adds improvements to memory implementation for aws
- 370c509d: implements memory calculations for aws

### Patch Changes

- 56bb6da6: #244 Bug fixed by changing configs boolean conditionals:
  In order to update, you need to apply the following changes in the `client` package:

  `packages/client/src/dashboard/CarbonFormulaDrawer.tsx`:

  ```diff
      // ...

        }
      }

  -    const previousYearOfUsage = !!process.env.REACT_APP_PREVIOUS_YEAR_OF_USAGE
  +    const previousYearOfUsage =
  +        !!process.env.REACT_APP_PREVIOUS_YEAR_OF_USAGE &&
  +        process.env.REACT_APP_PREVIOUS_YEAR_OF_USAGE !== 'false'

      const appConfig: ClientConfig = {
          CURRENT_PROVIDERS: [

      // ...
  ```

- b63d8a67: The default `aws-sdk` dependency was bumped to `"^2.890.0"`,
- 3abe3dca: Adds support for AmazonNeptune storage service to AWS CostAndUSageReports
- 29f48e7c: Bug Fixed: Cache file is written with empty API data
- 7d523b59: adds default unknown processor types for azure and aws

## 0.6.1

### Patch Changes

- 021c345f: Google Cloud Storage option added to store cache file

## 0.6.0

### Minor Changes

- 8b4c992d: Add support for using the median for a group of processors when there are outliers

### Patch Changes

- 216ea2ec: adds error handling for azure request error"

## 0.5.0

### Minor Changes

- 0ccce96b: Adds additional Azure usage types and regions based on THoughtWorks' Azure usage

### Patch Changes

- 8175b41d: updates packages with readmes and metadata

## 0.4.0

### Minor Changes

- 6c620db: Updates the GCP Emissions factors to use those published by Google
- 033a504: adds integration testing
- 82aeb1e: Updates average min/max compute coefficients for cloud providers based on microarchitectures. Adds min/max compute coefficient for Graviton 2 processor

### Patch Changes

- f3d4c8a: fixes azure pue value
- c5f28fe: updates googleapis dependency version
- 906f14e: updates consumption types for azure and adds logs
- bb82d7b: updates gcp shared core processors list to enum
- 9b10f3b: fixes hdd storage types list and lint fix

## 0.3.0

### Minor Changes

- 29e9897: implements using min and max coefficients based on processor types for gcp
- 75176d7: Updates the cloud provider queries to be configurable by grouping dates and allows configurable date ranges
- ce0f249: Updates Application Config to support Docker Secrets

### Patch Changes

- beabadf: fix storage estimator and estimates cache
- e2ac070: Fixes default config for querying data
- 29e9897: adds AmazonLightsail to aws list of ssd services types
- a0ac965: Fixes failing tests when running them in a different timezone

## 0.2.0

### Minor Changes

- 96cb023: Adds support for Microsoft Azure, as well as updates to the microsite.

## 0.1.0

### Minor Changes

- 3b3bec3: Update packages to have base version
