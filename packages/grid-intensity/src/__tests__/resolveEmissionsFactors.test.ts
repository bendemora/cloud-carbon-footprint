/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { configLoader } from '@cloud-carbon-footprint/common'
import { GridIntensityResolver } from '../GridIntensityResolver'
import {
  resetDefaultResolver,
  resolveEmissionsFactors,
  shutdownDefaultResolver,
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
  Logger: jest.fn().mockImplementation(() => ({ warn: mockWarn })),
}))

const mockConfig = (
  gridIntensity: Record<string, unknown> = {},
  mongodb: Record<string, unknown> = {},
) =>
  (configLoader as jest.Mock).mockReturnValue({
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
        resolver,
      )
      expect(result.factors).toEqual({ 'eu-west-2': 0.0001875 })
      expect(result.provenance).toMatchObject({
        sourceId: 'fake',
        zoneId: 'GB',
        qualityTier: 'B',
      })
    })

    it('rethrows errors other than no source being available', async () => {
      const resolver = new GridIntensityResolver({ sources: [] })
      await expect(
        resolveEmissionsFactors(
          'AWS',
          'eu-west-2',
          START,
          START,
          awsTable,
          resolver,
        ),
      ).rejects.toThrow(RangeError)
    })
  })
})
