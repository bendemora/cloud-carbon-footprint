/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  configLoader,
  getEmissionsFactors,
} from '@cloud-carbon-footprint/common'
import { GridIntensityResolver } from '../GridIntensityResolver'
import {
  ElectricityMapsRequestError,
  isElectricityMapsRequestError,
  lastFullUtcDay,
  resetDefaultResolver,
  resolveEmissionsFactors,
  shutdownDefaultResolver,
  usagePeriod,
} from '../resolveEmissionsFactors'
import { MongoDbIntensityStore } from '../stores/MongoDbIntensityStore'
import { StaticFactorTable } from '../sources/StaticSource'
import { FakeSource } from './fixtures/FakeSource'

const mockWarn = jest.fn()
jest.mock('mongodb', () => ({
  MongoClient: jest.fn(),
  ServerApiVersion: { v1: '1' },
}))
jest.mock('@cloud-carbon-footprint/common', () => ({
  configLoader: jest.fn(),
  getEmissionsFactors: jest.fn(),
  Logger: jest.fn().mockImplementation(() => ({ warn: mockWarn })),
}))

const mockConfig = (
  gridIntensity: Record<string, unknown> = {},
  mongodb: Record<string, unknown> = {},
  topLevel: Record<string, unknown> = {},
) =>
  (configLoader as jest.Mock).mockReturnValue({
    ...topLevel,
    MONGODB: mongodb,
    GRID_INTENSITY: {
      SOURCES: ['static'],
      LICENCE_ACKNOWLEDGEMENTS: [],
      CAPABILITY_TTL_HOURS: 24,
      ...gridIntensity,
    },
  })

const utc = (iso: string) => new Date(iso)
const START = utc('2026-03-10T00:00:00.000Z')
const END = utc('2026-03-11T00:00:00.000Z')
const awsFactors = { 'eu-west-2': 0.000305, Unknown: 0.0004 }
const awsTable: StaticFactorTable = { factors: awsFactors }

describe('resolveEmissionsFactors', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetDefaultResolver()
    mockConfig()
  })

  describe('with the default configuration (static only)', () => {
    it("returns the caller's table unchanged with tier D provenance", async () => {
      const result = await resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        START,
        END,
        awsTable,
      )
      expect(result.factors).toBe(awsFactors)
      expect(result.provenance).toMatchObject({
        sourceId: 'static',
        zoneId: 'aws:eu-west-2',
        qualityTier: 'D',
        isEstimated: false,
        gCO2ePerKWh: 305,
      })
    })

    it('reads a factor getter at call time', async () => {
      const cfeAdjusted = { 'us-central1': 0.00005369 }
      const result = await resolveEmissionsFactors(
        'GCP',
        'us-central1',
        START,
        END,
        { factors: () => cfeAdjusted, basis: 'location-consumption' },
      )
      expect(result.factors).toBe(cfeAdjusted)
      expect(result.provenance).toMatchObject({
        zoneId: 'gcp:us-central1',
        basis: 'location-consumption',
      })
    })

    it("maps an unlisted region to the table's Unknown zone", async () => {
      const result = await resolveEmissionsFactors(
        'AWS',
        'mars-north-1',
        START,
        END,
        awsTable,
      )
      expect(result.factors).toBe(awsFactors)
      expect(result.provenance.zoneId).toBe('aws:Unknown')
      expect(result.provenance.gCO2ePerKWh).toBe(400)
    })

    it('reports the Unknown factor that estimateCo2 applies for a zero-valued region', async () => {
      // GCP_USE_CARBON_FREE_ENERGY_PERCENTAGE=true gives europe-north2 a 0.
      const cfeFactors = { 'europe-north2': 0, Unknown: 0.00018894 }
      const result = await resolveEmissionsFactors(
        'GCP',
        'europe-north2',
        START,
        END,
        { factors: cfeFactors },
      )
      expect(result.factors).toBe(cfeFactors)
      expect(result.provenance).toMatchObject({
        zoneId: 'gcp:Unknown',
        gCO2ePerKWh: 188.94,
      })
    })

    it('logs no warning for GCP multi-region factors above the fetched-data bound', async () => {
      const gcpFactors = { us: 0.00381, Unknown: 0.0002 }
      const result = await resolveEmissionsFactors('GCP', 'us', START, END, {
        factors: gcpFactors,
      })
      expect(result.factors).toBe(gcpFactors)
      expect(result.provenance).toMatchObject({
        zoneId: 'gcp:us',
        isEstimated: false,
        gCO2ePerKWh: 3810,
      })
      expect(mockWarn).not.toHaveBeenCalled()
    })

    it('still returns the table, flagged as estimated, when no source can serve the region', async () => {
      const factors = { 'us-east-1': 0.0004 }
      const result = await resolveEmissionsFactors(
        'AZURE',
        'uksouth',
        START,
        END,
        { factors },
      )
      expect(result.factors).toBe(factors)
      expect(result.provenance).toEqual({
        sourceId: 'static',
        zoneId: 'azure:uksouth',
        granularity: 'year',
        basis: 'location-production',
        factorType: 'direct',
        isEstimated: true,
        licenceId: 'open-attribution',
        qualityTier: 'D',
        // the table has neither the region nor an Unknown entry
        gCO2ePerKWh: NaN,
        modelVersion: 'unversioned',
      })
    })

    it('builds the default resolver once and rebuilds it after a reset', async () => {
      await resolveEmissionsFactors('AWS', 'eu-west-2', START, END, awsTable)
      await resolveEmissionsFactors('AWS', 'eu-west-2', START, END, awsTable)
      expect(configLoader).toHaveBeenCalledTimes(1)
      resetDefaultResolver()
      await resolveEmissionsFactors('AWS', 'eu-west-2', START, END, awsTable)
      expect(configLoader).toHaveBeenCalledTimes(2)
    })
  })

  describe('configuration', () => {
    it('warns once about an unknown source id and ignores it', async () => {
      mockConfig({ SOURCES: ['electricitymaps', 'static'] })
      const result = await resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        START,
        END,
        awsTable,
      )
      await resolveEmissionsFactors('AWS', 'eu-west-2', START, END, awsTable)
      expect(result.provenance.sourceId).toBe('static')
      expect(mockWarn).toHaveBeenCalledTimes(1)
      expect(mockWarn.mock.calls[0][0]).toContain("'electricitymaps'")
    })

    it('falls back to the static table when static is not configured', async () => {
      mockConfig({ SOURCES: [] })
      const result = await resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        START,
        END,
        awsTable,
      )
      expect(result.factors).toBe(awsFactors)
      expect(result.provenance).toMatchObject({
        sourceId: 'static',
        zoneId: 'aws:eu-west-2',
        isEstimated: false,
        qualityTier: 'D',
        gCO2ePerKWh: 305,
      })
    })

    it('reports the Unknown factor for a zero-valued region when static is not configured', async () => {
      mockConfig({ SOURCES: [] })
      const result = await resolveEmissionsFactors(
        'GCP',
        'europe-north2',
        START,
        END,
        { factors: { 'europe-north2': 0, Unknown: 0.00018894 } },
      )
      expect(result.provenance).toMatchObject({
        zoneId: 'gcp:Unknown',
        isEstimated: false,
        gCO2ePerKWh: 188.94,
      })
    })

    it('uses defaults when the configuration has no GRID_INTENSITY block', async () => {
      ;(configLoader as jest.Mock).mockReturnValue({})
      const result = await resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        START,
        END,
        awsTable,
      )
      expect(result.provenance.zoneId).toBe('aws:eu-west-2')
    })
  })

  describe('shutdownDefaultResolver', () => {
    it('closes the store of the default resolver and discards it', async () => {
      mockConfig({ STORE: 'MONGODB' }, { URI: 'mongodb://db:27017' })
      const close = jest
        .spyOn(MongoDbIntensityStore.prototype, 'close')
        .mockResolvedValue(undefined)
      await resolveEmissionsFactors('AWS', 'eu-west-2', START, END, awsTable)
      await shutdownDefaultResolver()
      expect(close).toHaveBeenCalledTimes(1)
      await resolveEmissionsFactors('AWS', 'eu-west-2', START, END, awsTable)
      expect(configLoader).toHaveBeenCalledTimes(2)
      close.mockRestore()
    })

    it('does nothing when no default resolver was built', async () => {
      await expect(shutdownDefaultResolver()).resolves.toBeUndefined()
    })

    it('discards a default resolver whose store has nothing to close', async () => {
      mockConfig({ STORE: 'LOCAL' })
      await resolveEmissionsFactors('AWS', 'eu-west-2', START, END, awsTable)
      await shutdownDefaultResolver()
      await resolveEmissionsFactors('AWS', 'eu-west-2', START, END, awsTable)
      expect(configLoader).toHaveBeenCalledTimes(2)
    })
  })

  describe('with a live source', () => {
    it('returns the resolved intensity for the region in tCO2e/kWh', async () => {
      const resolver = new GridIntensityResolver({
        sources: [new FakeSource({ value: () => 187.5 })],
      })
      const result = await resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        START,
        END,
        awsTable,
        { resolver },
      )
      expect(result.factors).toEqual({ 'eu-west-2': 0.0001875 })
      expect(result.provenance).toMatchObject({
        sourceId: 'fake',
        zoneId: 'GB',
        qualityTier: 'B',
        gCO2ePerKWh: 187.5,
      })
    })

    it("rethrows an explicit resolver's errors other than no source being available", async () => {
      const resolver = {
        resolve: () => Promise.reject(new TypeError('resolver failed')),
      }
      await expect(
        resolveEmissionsFactors('AWS', 'eu-west-2', START, END, awsTable, {
          resolver,
        }),
      ).rejects.toThrow(new TypeError('resolver failed'))
    })
  })

  describe('legacy Electricity Maps v3 lookup', () => {
    const zones = { 'eu-west-2': 'GB' }
    const legacyFactors = { 'eu-west-2': 0.000212 }
    const withToken = () =>
      mockConfig({}, {}, { ELECTRICITY_MAPS_TOKEN: 'token-for-tests' })

    it('uses getEmissionsFactors when a token is set, labelling the single-hour sample as estimated', async () => {
      withToken()
      ;(getEmissionsFactors as jest.Mock).mockResolvedValue(legacyFactors)
      const result = await resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        START,
        END,
        awsTable,
        { legacyElectricityMapsZones: zones },
      )
      expect(getEmissionsFactors).toHaveBeenCalledWith(
        'eu-west-2',
        START.toISOString(),
        awsFactors,
        zones,
        expect.anything(),
      )
      expect(result.factors).toBe(legacyFactors)
      expect(result.provenance).toEqual({
        sourceId: 'electricitymaps-v3',
        zoneId: 'GB',
        granularity: 'hour',
        basis: 'location-consumption',
        factorType: 'lifecycle',
        isEstimated: true,
        licenceId: 'custom',
        qualityTier: 'C',
        gCO2ePerKWh: 212,
        modelVersion: 'unversioned',
      })
    })

    it('is tier A for hourly usage', async () => {
      withToken()
      ;(getEmissionsFactors as jest.Mock).mockResolvedValue(legacyFactors)
      const result = await resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        utc('2026-03-10T13:00:00.000Z'),
        utc('2026-03-10T14:00:00.000Z'),
        awsTable,
        { legacyElectricityMapsZones: zones },
      )
      expect(result.provenance).toMatchObject({
        isEstimated: false,
        qualityTier: 'A',
      })
    })

    it('falls back to the resolver when the lookup returns the static table', async () => {
      withToken()
      ;(getEmissionsFactors as jest.Mock).mockImplementation(
        async (_r, _d, staticFactors) => staticFactors,
      )
      const result = await resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        START,
        END,
        awsTable,
        { legacyElectricityMapsZones: zones },
      )
      expect(result.factors).toBe(awsFactors)
      expect(result.provenance).toMatchObject({
        sourceId: 'static',
        qualityTier: 'D',
      })
    })

    it('rethrows a failed lookup, as before, so the run stops and nothing is cached', async () => {
      // Falling back here would retry the failing request on every row and
      // write static rows into the estimates cache for good.
      withToken()
      ;(getEmissionsFactors as jest.Mock).mockRejectedValue(
        new Error('Failed to get data from Electricity Maps.'),
      )
      const failure = resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        START,
        END,
        awsTable,
        { legacyElectricityMapsZones: zones },
      )
      await expect(failure).rejects.toThrow(
        'Failed to get data from Electricity Maps.',
      )
      // Named, so per-subscription catches (Azure) can let it through.
      await expect(failure).rejects.toBeInstanceOf(ElectricityMapsRequestError)
      expect(isElectricityMapsRequestError(await failure.catch((e) => e))).toBe(
        true,
      )
    })

    it('recognises the named error by name as well as by class', () => {
      const copy = Object.assign(new Error('x'), {
        name: 'ElectricityMapsRequestError',
      })
      expect(isElectricityMapsRequestError(copy)).toBe(true)
      expect(isElectricityMapsRequestError(new Error('x'))).toBe(false)
      expect(isElectricityMapsRequestError(undefined)).toBe(false)
    })

    it('is not used without a token', async () => {
      const result = await resolveEmissionsFactors(
        'AWS',
        'eu-west-2',
        START,
        END,
        awsTable,
        { legacyElectricityMapsZones: zones },
      )
      expect(getEmissionsFactors).not.toHaveBeenCalled()
      expect(result.provenance.sourceId).toBe('static')
    })

    it('is not used without a zone map, or with an explicit resolver', async () => {
      withToken()
      await resolveEmissionsFactors('AWS', 'eu-west-2', START, END, awsTable)
      await resolveEmissionsFactors('AWS', 'eu-west-2', START, END, awsTable, {
        legacyElectricityMapsZones: zones,
        resolver: new GridIntensityResolver({
          sources: [new FakeSource()],
        }),
      })
      expect(getEmissionsFactors).not.toHaveBeenCalled()
    })
  })
})

describe('usagePeriod', () => {
  it.each([
    ['day', '2026-03-10T00:00:00.000Z', '2026-03-11T00:00:00.000Z'],
    ['week', '2026-03-09T00:00:00.000Z', '2026-03-16T00:00:00.000Z'],
    ['month', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
    ['quarter', '2026-01-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
    ['year', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
  ])('a %s from %s ends, exclusive, at %s', (grouping, start, end) => {
    expect(usagePeriod(utc(start), grouping)).toEqual({
      start: utc(start),
      end: utc(end),
    })
  })

  it('treats an unknown grouping as a day', () => {
    expect(usagePeriod(START, 'fortnight').end).toEqual(END)
  })
})

describe('lastFullUtcDay', () => {
  it('is yesterday in UTC', () => {
    expect(lastFullUtcDay(utc('2026-11-05T13:45:00.000Z'))).toEqual({
      start: utc('2026-11-04T00:00:00.000Z'),
      end: utc('2026-11-05T00:00:00.000Z'),
    })
  })

  it('defaults to the current time', () => {
    const { end } = lastFullUtcDay()
    expect(end.getTime()).toBeLessThanOrEqual(Date.now())
    expect(Date.now() - end.getTime()).toBeLessThan(24 * 3600 * 1000)
  })
})
