/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { GRID_ZONES } from '@cloud-carbon-footprint/grid-intensity'
import { AWS_EMISSIONS_FACTORS_METRIC_TON_PER_KWH } from '../domain'
import { AWS_REGIONS } from '../lib'

// The regions the grid intensity capability report lists (packages/app).
describe('AWS region tables', () => {
  const regions: string[] = Object.values(AWS_REGIONS)
  const namedIn = (table: object) =>
    Object.entries(table).map(([region]) => region)

  it('have a grid emissions factor for every region', () => {
    const factors = AWS_EMISSIONS_FACTORS_METRIC_TON_PER_KWH
    expect(regions.filter((region) => !(region in factors))).toEqual([])
  })

  it('name only regions of the region table in the factor table and the grid zone registry', () => {
    const unknown = [
      ...namedIn(AWS_EMISSIONS_FACTORS_METRIC_TON_PER_KWH),
      ...namedIn(GRID_ZONES.AWS),
    ].filter((region) => !regions.includes(region))
    expect(unknown).toEqual([])
  })
})
