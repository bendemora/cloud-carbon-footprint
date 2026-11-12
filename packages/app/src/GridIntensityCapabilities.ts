/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { configLoader } from '@cloud-carbon-footprint/common'
import {
  AWS_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
  AWS_REGIONS,
} from '@cloud-carbon-footprint/aws'
import {
  GCP_DUAL_REGIONS,
  GCP_MULTI_REGIONS,
  GCP_REGIONS,
  getGCPEmissionsFactors,
} from '@cloud-carbon-footprint/gcp'
import {
  AZURE_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
  AZURE_REGIONS,
} from '@cloud-carbon-footprint/azure'
import {
  CapabilityReport,
  createCapabilityReporter,
  ProviderRegion,
} from '@cloud-carbon-footprint/grid-intensity'

/**
 * Every region in the region tables of AWS, GCP and Azure, the providers
 * whose estimates resolve grid intensity. A provider whose estimates are
 * turned off (<PROVIDER>_INCLUDE_ESTIMATES=false) is left out.
 */
const providerRegions = (): ProviderRegion[] => {
  const { AWS, GCP, AZURE } = configLoader()
  const regions: ProviderRegion[] = []
  const add = (provider: ProviderRegion['provider'], names: string[]) =>
    regions.push(...names.map((region) => ({ provider, region })))

  if (AWS?.INCLUDE_ESTIMATES !== false) add('AWS', Object.values(AWS_REGIONS))
  if (GCP?.INCLUDE_ESTIMATES !== false)
    add('GCP', [
      ...Object.values(GCP_REGIONS),
      ...Object.values(GCP_DUAL_REGIONS),
      ...Object.values(GCP_MULTI_REGIONS),
    ])
  if (AZURE?.INCLUDE_ESTIMATES !== false)
    add(
      'AZURE',
      Object.values(AZURE_REGIONS).map((region) => region.name),
    )
  return regions
}

/**
 * The grid zone of each provider region and what each configured grid
 * intensity source can deliver for it (design section 6.5): the report
 * behind the doctor command and GET /api/grid-intensity/capabilities.
 *
 * The static tables are the ones the provider packages give
 * resolveEmissionsFactors, so the report describes what estimates would use.
 */
export const getGridIntensityCapabilities = (): Promise<CapabilityReport> =>
  createCapabilityReporter({
    regions: providerRegions(),
    staticTables: {
      AWS: { factors: AWS_EMISSIONS_FACTORS_METRIC_TON_PER_KWH },
      GCP: { factors: getGCPEmissionsFactors },
      AZURE: { factors: AZURE_EMISSIONS_FACTORS_METRIC_TON_PER_KWH },
    },
  }).capabilities()
