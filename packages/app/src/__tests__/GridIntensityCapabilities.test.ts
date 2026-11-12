/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { setConfig } from '@cloud-carbon-footprint/common'
import { AWS_REGIONS } from '@cloud-carbon-footprint/aws'
import {
  GCP_DUAL_REGIONS,
  GCP_MULTI_REGIONS,
  GCP_REGIONS,
} from '@cloud-carbon-footprint/gcp'
import { AZURE_REGIONS } from '@cloud-carbon-footprint/azure'
import {
  CapabilityReport,
  shutdownDefaultResolver,
} from '@cloud-carbon-footprint/grid-intensity'
import App from '../App'

// The settings the report depends on. Each test starts with none of them
// set, which is the default configuration.
const SETTINGS = [
  'GRID_INTENSITY_SOURCES',
  'GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS',
  'GRID_INTENSITY_STORE',
  'AWS_INCLUDE_ESTIMATES',
  'GCP_INCLUDE_ESTIMATES',
  'AZURE_INCLUDE_ESTIMATES',
  'GCP_USE_CARBON_FREE_ENERGY_PERCENTAGE',
]

const TIER_D = { last24Hours: 'D', last30Days: 'D', last12Months: 'D' }

const regionsOf = (report: CapabilityReport, provider: string) =>
  report.regions
    .filter((entry) => entry.provider === provider)
    .map((entry) => entry.region)

const entryFor = (report: CapabilityReport, provider: string, region: string) =>
  report.regions.find(
    (entry) => entry.provider === provider && entry.region === region,
  )

describe('App.getGridIntensityCapabilities', () => {
  const saved: Record<string, string | undefined> = {}
  const realFetch = global.fetch
  const fetchMock = jest.fn()

  const configure = (settings: Record<string, string> = {}) => {
    Object.assign(process.env, settings)
    setConfig()
  }

  beforeEach(() => {
    for (const name of SETTINGS) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    fetchMock.mockReset()
    global.fetch = fetchMock
    configure()
  })

  afterEach(async () => {
    await shutdownDefaultResolver()
    for (const name of SETTINGS) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    global.fetch = realFetch
    setConfig()
  })

  it('reports tier D from the static source for every AWS, GCP and Azure region with the default configuration', async () => {
    const report = await new App().getGridIntensityCapabilities()

    expect(regionsOf(report, 'AWS')).toEqual(Object.values(AWS_REGIONS))
    expect(regionsOf(report, 'GCP')).toEqual([
      ...Object.values(GCP_REGIONS),
      ...Object.values(GCP_DUAL_REGIONS),
      ...Object.values(GCP_MULTI_REGIONS),
    ])
    expect(regionsOf(report, 'AZURE')).toEqual(
      Object.values(AZURE_REGIONS).map((region) => region.name),
    )
    expect(new Set(report.regions.map((entry) => entry.provider))).toEqual(
      new Set(['AWS', 'GCP', 'AZURE']),
    )

    const notStaticTierD = report.regions.filter(
      ({ sources }) =>
        sources.length !== 1 ||
        sources[0].sourceId !== 'static' ||
        sources[0].licenceState !== 'open' ||
        JSON.stringify(sources[0].bestTier) !== JSON.stringify(TIER_D),
    )
    expect(notStaticTierD).toEqual([])

    const zoneOf = (provider: string, region: string) =>
      entryFor(report, provider, region).sources[0].zoneId
    expect(zoneOf('AWS', 'eu-west-2')).toBe('aws:eu-west-2')
    expect(zoneOf('GCP', 'europe-north2')).toBe('gcp:europe-north2')
    expect(zoneOf('GCP', 'nam4')).toBe('gcp:nam4')
    expect(zoneOf('GCP', 'us')).toBe('gcp:us')
    expect(zoneOf('AZURE', 'uksouth')).toBe('azure:uksouth')
    // Azure's table has no factor for it, so estimates use the Unknown one.
    expect(zoneOf('AZURE', 'qatarcentral')).toBe('azure:Unknown')

    const gridZoneOf = (provider: string, region: string) =>
      entryFor(report, provider, region).gridZoneId
    expect(gridZoneOf('AWS', 'eu-west-2')).toBe('GB')
    expect(gridZoneOf('GCP', 'europe-west2')).toBe('GB')
    expect(gridZoneOf('AZURE', 'uksouth')).toBe('GB')
    expect(gridZoneOf('AWS', 'Unknown')).toBeNull()
    expect(gridZoneOf('GCP', 'us')).toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('leaves out a provider whose estimates are turned off', async () => {
    configure({ GCP_INCLUDE_ESTIMATES: 'false' })
    const report = await new App().getGridIntensityCapabilities()
    expect(new Set(report.regions.map((entry) => entry.provider))).toEqual(
      new Set(['AWS', 'AZURE']),
    )
  })

  it("reads GCP's factors as estimates do, so the carbon-free-energy table applies when it is turned on", async () => {
    configure({ GCP_USE_CARBON_FREE_ENERGY_PERCENTAGE: 'true' })
    const report = await new App().getGridIntensityCapabilities()
    // That table has a 0 for europe-north2, which estimates treat as missing.
    expect(entryFor(report, 'GCP', 'europe-north2').sources[0].zoneId).toBe(
      'gcp:Unknown',
    )
  })
})
