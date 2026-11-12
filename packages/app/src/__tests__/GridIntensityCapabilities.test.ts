/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
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
import LocalCacheManager from '../LocalCacheManager'

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
  'CACHE_MODE',
  'CCF_CACHE_PATH',
  'TEST_MODE',
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

  describe('with the estimates cache', () => {
    let directory: string

    /** A cache file of the grouping with one day for each flag given. */
    const seedCache = (grouping: string, provisionalDays: boolean[]) =>
      writeFile(
        join(directory, `estimates.cache.${grouping}.json`),
        '[\n' +
          provisionalDays
            .map((isProvisional, index) =>
              JSON.stringify({
                timestamp: new Date(Date.UTC(2026, 10, 1 + index)),
                serviceEstimates: [
                  {
                    cloudProvider: 'AWS',
                    serviceName: 'service',
                    provenance: isProvisional ? { isProvisional } : {},
                  },
                ],
                groupBy: grouping,
              }),
            )
            .join('\n,\n') +
          '\n]',
      )

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'estimates-cache-'))
      process.env.CCF_CACHE_PATH = join(directory, 'estimates.cache')
    })

    afterEach(async () => {
      jest.restoreAllMocks()
      await rm(directory, { recursive: true, force: true })
    })

    it('does not read the estimates cache unless it is asked to', async () => {
      await seedCache('day', [false, true])
      const getCachedPeriods = jest.spyOn(
        LocalCacheManager.prototype,
        'getCachedPeriods',
      )

      const report = await new App().getGridIntensityCapabilities()
      const notAsked = await new App().getGridIntensityCapabilities({
        cachedEstimates: false,
      })

      expect(getCachedPeriods).not.toHaveBeenCalled()
      expect(report).not.toHaveProperty('cachedEstimates')
      expect(notAsked).not.toHaveProperty('cachedEstimates')
    })

    it('adds the cached periods of each grouping next to the report when it is asked to', async () => {
      await seedCache('day', [false, true, true])
      await seedCache('month', [false])
      const plainReport = await new App().getGridIntensityCapabilities()

      const report = await new App().getGridIntensityCapabilities({
        cachedEstimates: true,
      })

      expect(report.cachedEstimates).toEqual([
        { groupBy: 'day', cachedPeriods: 3, provisionalPeriods: 2 },
        { groupBy: 'month', cachedPeriods: 1, provisionalPeriods: 0 },
      ])
      expect(report.regions).toEqual(plainReport.regions)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reports no cached periods, and creates no cache file, when there is no cache', async () => {
      const report = await new App().getGridIntensityCapabilities({
        cachedEstimates: true,
      })

      expect(report.cachedEstimates).toEqual([])
      expect(await readdir(directory)).toEqual([])
    })

    it('fails when it is asked for the cached periods and the cache cannot be read', async () => {
      await writeFile(
        join(directory, 'estimates.cache.day.json'),
        '[\n{"timestamp":"2026-11-01T00',
      )

      await expect(
        new App().getGridIntensityCapabilities({ cachedEstimates: true }),
      ).rejects.toThrow(SyntaxError)
    })
  })
})
