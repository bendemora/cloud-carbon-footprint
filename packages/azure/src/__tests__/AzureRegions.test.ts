/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { AZURE_EMISSIONS_FACTORS_METRIC_TON_PER_KWH } from '../domain'
import {
  AZURE_MAPPED_REGIONS_TO_ELECTRICITY_MAPS_ZONES,
  AZURE_REGIONS,
} from '../lib'

// The regions the grid intensity capability report lists (packages/app).
// Some have no factor of their own; estimates use the Unknown factor there.
describe('Azure region tables', () => {
  const regions = Object.values(AZURE_REGIONS).map((region) => region.name)
  const namedIn = (table: object) =>
    Object.entries(table).map(([region]) => region)

  it('name only regions of the region table in the factor table and the Electricity Maps zone map', () => {
    const unknown = [
      ...namedIn(AZURE_EMISSIONS_FACTORS_METRIC_TON_PER_KWH),
      ...namedIn(AZURE_MAPPED_REGIONS_TO_ELECTRICITY_MAPS_ZONES),
    ].filter((region) => !regions.includes(region))
    expect(unknown).toEqual([])
  })
})
