/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { setConfig } from '@cloud-carbon-footprint/common'
import { GRID_ZONES } from '@cloud-carbon-footprint/grid-intensity'
import { getGCPEmissionsFactors } from '../domain'
import { GCP_DUAL_REGIONS, GCP_MULTI_REGIONS, GCP_REGIONS } from '../lib'

// The regions the grid intensity capability report lists (packages/app).
describe('GCP region tables', () => {
  const regions: string[] = [
    ...Object.values(GCP_REGIONS),
    ...Object.values(GCP_DUAL_REGIONS),
    ...Object.values(GCP_MULTI_REGIONS),
  ]
  const namedIn = (table: object) =>
    Object.entries(table).map(([region]) => region)

  beforeAll(() => {
    setConfig({ GCP: { USE_CARBON_FREE_ENERGY_PERCENTAGE: false } })
  })
  afterAll(() => {
    setConfig()
  })

  it('have a grid emissions factor for every region, dual-region and multi-region', () => {
    const factors = getGCPEmissionsFactors()
    expect(regions.filter((region) => !(region in factors))).toEqual([])
  })

  it('name only regions of the region tables in the factor table and the grid zone registry', () => {
    const unknown = [
      ...namedIn(getGCPEmissionsFactors()),
      ...namedIn(GRID_ZONES.GCP),
    ].filter((region) => !regions.includes(region))
    expect(unknown).toEqual([])
  })
})
