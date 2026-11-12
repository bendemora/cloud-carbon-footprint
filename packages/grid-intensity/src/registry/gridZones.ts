/*
 * © 2021 Thoughtworks, Inc.
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { CloudProvider } from '../types'

/*
 * The grid zone registry (design section 5.5): the electricity grid each
 * cloud region is on, or null where the grid is not known. A region that is
 * absent has no grid zone either. Regions without one are served by the
 * static factors only.
 *
 * A grid zone identifier is a country code, followed by a grid area where
 * the zone list divides the country: a bidding zone (SE-SE3), a balancing
 * authority (US-MIDA-PJM), a market region (AU-NSW) or a regional system
 * (IN-WE). A source maps a region to its own zone in two steps: region to
 * grid zone here, then grid zone to the source's zone in a table the source
 * holds.
 *
 * The mappings and identifiers are the ones upstream CCF held in
 * AWSRegions.ts, GCPRegions.ts and AzureRegions.ts, moved here unchanged by
 * ADR 0026; design section 5.5 records where they come from. The region
 * names are the values of each provider's region table, which a test in each
 * provider package checks. This is the one place that says which grid a
 * region is on.
 */

/** Raised whenever a mapping changes. */
export const GRID_ZONE_REGISTRY_VERSION = 1

export type GridZoneMap = { readonly [region: string]: string | null }

export const GRID_ZONES: {
  readonly [provider in 'AWS' | 'GCP' | 'AZURE']: GridZoneMap
} = {
  AWS: {
    'us-east-1': 'US-MIDA-PJM',
    'us-east-2': 'US-MIDW-MISO',
    'us-west-1': 'US-CAL-CISO',
    'us-west-2': 'US-NW-PACW',
    'af-south-1': 'ZA',
    'ap-east-1': 'HK',
    'ap-east-2': 'TW',
    'ap-south-1': 'IN-WE',
    'ap-south-2': 'IN-SO',
    'ap-northeast-1': 'JP-TK',
    'ap-northeast-2': 'KR',
    'ap-northeast-3': 'JP-KN',
    'ap-southeast-1': 'SG',
    'ap-southeast-2': 'AU-NSW',
    'ap-southeast-3': 'ID',
    'ap-southeast-4': 'AU-VIC',
    'ap-southeast-5': 'MY-WM',
    'ap-southeast-6': 'NZ',
    'ap-southeast-7': 'TH',
    'ca-central-1': 'CA-ON',
    'ca-west-1': 'CA-AB',
    'cn-north-1': 'CN',
    'cn-northwest-1': 'CN',
    'eu-central-1': 'DE',
    'eu-central-2': 'CH',
    'eu-west-1': 'IE',
    'eu-west-2': 'GB',
    'eu-west-3': 'FR',
    'eu-south-1': 'IT-NO',
    'eu-south-2': 'ES',
    'eu-north-1': 'SE-SE3',
    'il-central-1': 'IL',
    'me-south-1': 'BH',
    'me-central-1': 'AE',
    'mx-central-1': 'MX',
    'sa-east-1': 'BR-CS',
    'us-gov-east-1': 'US-MIDA-PJM',
    'us-gov-west-1': 'US-NW-PACW',
    Unknown: null,
  },
  GCP: {
    'asia-east1': 'TW',
    'asia-east2': null,
    'asia-northeast1': 'JP-TK',
    'asia-northeast2': 'JP-KN',
    'asia-northeast3': 'KR',
    'asia-south1': 'IN-WE',
    'asia-south2': 'IN-NO',
    'asia-southeast1': 'SG',
    'asia-southeast2': 'ID',
    'australia-southeast1': 'AU-NSW',
    'australia-southeast2': 'AU-VIC',
    'europe-central2': 'PL',
    'europe-north1': 'FI',
    'europe-southwest1': 'ES',
    'europe-west1': 'BE',
    'europe-west2': 'GB',
    'europe-west3': 'DE',
    'europe-west4': 'NL',
    'europe-west6': 'CH',
    'europe-west8': 'IT-NO',
    'europe-west9': 'FR',
    'europe-west10': 'DE',
    'europe-west12': 'IT-NO',
    'northamerica-northeast1': 'CA-QC',
    'northamerica-northeast2': 'CA-ON',
    'southamerica-east1': 'BR-CS',
    'southamerica-west1': 'CL-SEN',
    'us-central1': 'US-MIDW-MISO',
    'us-central2': 'US-MIDW-MISO',
    'us-east1': 'US-CAR-SCEG',
    'us-east4': 'US-MIDA-PJM',
    'us-east5': 'US-MIDA-PJM',
    'us-south1': 'US-TEX-ERCO',
    'us-west1': 'US-NW-PACW',
    'us-west2': 'US-CAL-CISO',
    'us-west3': 'US-NW-PACE',
    'us-west4': 'US-NW-NEVP',
    'africa-south1': 'ZA',
    'europe-north2': 'SE-SE3',
    'me-central1': null,
    'me-central2': null,
    'me-west1': 'IL',
    'northamerica-south1': 'MX',
    'us-east2': 'US-MIDA-PJM',
    Unknown: null,
  },
  AZURE: {
    southafricanorth: 'ZA',
    southafricawest: 'ZA',
    australiacentral: 'AU-NSW',
    australiacentral2: 'AU-NSW',
    australiaeast: 'AU-NSW',
    australiasoutheast: 'AU-VIC',
    apeast: null,
    apsoutheast: 'SG',
    japaneast: 'JP-TK',
    japanwest: 'JP-KN',
    koreacentral: 'KR',
    koreasouth: 'KR',
    centralindia: 'IN-WE',
    southindia: 'IN-SO',
    westindia: 'IN-WE',
    northeurope: 'IE',
    westeurope: 'NL',
    francecentral: 'FR',
    francesouth: 'FR',
    swedencentral: 'SE-SE3',
    switzerlandnorth: 'CH',
    switzerlandwest: 'CH',
    uksouth: 'GB',
    ukwest: 'GB',
    uk: 'GB',
    germany: 'DE',
    germanynorth: 'DE',
    germanywestcentral: 'DE',
    norwayeast: 'NO-NO1',
    norwaywest: 'NO-NO2',
    uaecentral: null,
    uaenorth: null,
    canadacentral: 'CA-ON',
    canadaeast: 'CA-QC',
    CentralUS: 'US-MIDW-MISO',
    centraluseuap: 'US-MIDW-MISO',
    centralusstage: 'US-MIDW-MISO',
    unitedstates: 'US-MIDW-MISO',
    unitedstateseuap: 'US-MIDW-MISO',
    EastUS: 'US-MIDA-PJM',
    eastusstage: 'US-MIDA-PJM',
    EastUS2: 'US-MIDA-PJM',
    eastus2euap: 'US-MIDA-PJM',
    eastus2stage: 'US-MIDA-PJM',
    EastUS3: 'US-MIDA-PJM',
    USNorth: 'US-MIDW-MISO',
    NorthCentralUs: 'US-MIDW-MISO',
    northcentralusstage: 'US-MIDW-MISO',
    SouthCentralUS: 'US-TEX-ERCO',
    southcentralusstage: 'US-TEX-ERCO',
    WestCentralUS: 'US-NW-PACE',
    WestUS: 'US-CAL-CISO',
    westusstage: 'US-CAL-CISO',
    westus2: 'US-NW-PACE',
    westus2stage: 'US-NW-PACE',
    westus3: 'US-NW-PACE',
    brazilsouth: 'BR-CS',
    brazilsoutheast: 'BR-CS',
    Unknown: null,
  },
}

/**
 * The grid zone of a cloud region, or null when the registry has none for
 * it: the region is unknown, is not on one grid (a GCP multi-region), or
 * belongs to a provider the registry does not cover.
 *
 * The region is matched exactly as the provider's region table spells it,
 * which is the name the provider package gives to resolveEmissionsFactors.
 * Some Azure names there are mixed case (EastUS, CentralUS), so 'eastus'
 * finds nothing.
 */
export const gridZoneOf = (
  provider: CloudProvider,
  region: string,
): string | null => {
  if (!Object.hasOwn(GRID_ZONES, provider)) return null
  const zones = (GRID_ZONES as { [provider: string]: GridZoneMap })[provider]
  return (Object.hasOwn(zones, region) && zones[region]) || null
}
