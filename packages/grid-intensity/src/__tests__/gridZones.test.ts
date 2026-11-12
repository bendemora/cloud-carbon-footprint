/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GRID_ZONE_REGISTRY_VERSION,
  GRID_ZONES,
  GridZoneMap,
  gridZoneOf,
} from '../registry/gridZones'
import { CloudProvider } from '../types'

describe('grid zone registry', () => {
  it.each([
    ['AWS', 'eu-west-2', 'GB'],
    ['AWS', 'us-east-1', 'US-MIDA-PJM'],
    ['GCP', 'europe-north1', 'FI'],
    ['GCP', 'us-central1', 'US-MIDW-MISO'],
    ['AZURE', 'ukwest', 'GB'],
    ['AZURE', 'EastUS', 'US-MIDA-PJM'],
  ] as const)('puts %s %s on grid zone %s', (provider, region, zone) => {
    expect(gridZoneOf(provider, region)).toBe(zone)
  })

  it.each([
    ['a region the registry maps to null', 'AWS', 'Unknown'],
    ['a region whose grid is not known', 'GCP', 'asia-east2'],
    ['a region the registry does not list', 'AWS', 'mars-north-1'],
    ['a multi-region, which is not on one grid', 'GCP', 'us'],
    ['a provider the registry does not cover', 'ALI', 'eu-west-1'],
    ['a provider the registry does not cover', 'ON_PREMISE', 'eu-west-2'],
    ['a provider name every object inherits', 'toString', 'name'],
    ['a name every object inherits', 'AWS', 'constructor'],
    ["a region in another case than the provider's table", 'AZURE', 'eastus'],
  ] as const)('has no grid zone for %s (%s %s)', (_case, provider, region) => {
    expect(gridZoneOf(provider as CloudProvider, region)).toBeNull()
  })

  it('names every zone as a country code, with a grid area where the country has more than one', () => {
    const zones = Object.values(GRID_ZONES).flatMap((regions) =>
      Object.values(regions).filter((zone) => zone !== null),
    )
    const malformed = zones.filter(
      (zone) => !/^[A-Z]{2}(-[A-Z0-9]+){0,2}$/.test(zone),
    )
    expect(malformed).toEqual([])
    expect(new Set(zones).size).toBe(48)
  })

  /*
   * The version is there so that an output can say which registry mapped
   * its regions. When this fails because a mapping was added or changed,
   * raise GRID_ZONE_REGISTRY_VERSION and add a row for the new version to
   * FINGERPRINTS. Never edit an old row. The order of the entries in the
   * registry does not matter.
   */
  it('matches the fingerprint recorded for its version, which is the latest recorded', () => {
    const recordedVersions = Object.keys(FINGERPRINTS).map(Number)
    expect(GRID_ZONE_REGISTRY_VERSION).toBe(Math.max(...recordedVersions))
    expect(fingerprintOf(canonical(GRID_ZONES))).toBe(
      FINGERPRINTS[GRID_ZONE_REGISTRY_VERSION],
    )
  })

  it('has a fingerprint that follows the mappings and not their order', () => {
    const reordered = {
      AZURE: GRID_ZONES.AZURE,
      AWS: Object.fromEntries(Object.entries(GRID_ZONES.AWS).reverse()),
      GCP: GRID_ZONES.GCP,
    }
    const remapped = {
      ...GRID_ZONES,
      AWS: { ...GRID_ZONES.AWS, 'eu-west-2': 'IE' },
    }
    const recorded = FINGERPRINTS[GRID_ZONE_REGISTRY_VERSION]
    expect(fingerprintOf(canonical(reordered))).toBe(recorded)
    expect(fingerprintOf(canonical(remapped))).not.toBe(recorded)
  })
})

/** The fingerprint of the registry at each version. */
const FINGERPRINTS: { [version: number]: number } = {
  1: 3573156945,
}

/** The registry as text, with providers and regions in code unit order. */
const canonical = (registry: { [provider: string]: GridZoneMap }): string => {
  const sorted = <T>(entries: [string, T][]) =>
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(
    sorted(Object.entries(registry)).map(([provider, zones]) => [
      provider,
      sorted(Object.entries(zones)),
    ]),
  )
}

/** 32-bit FNV-1a, as a decimal number. Enough to notice a changed mapping. */
const fingerprintOf = (text: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
