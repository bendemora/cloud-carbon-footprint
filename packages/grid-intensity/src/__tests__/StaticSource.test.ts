/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { StaticSource, StaticFactorTables } from '../sources/StaticSource'

const utc = (iso: string) => new Date(iso)
const retrievedAt = utc('2026-11-05T12:00:00.000Z')

const tables: StaticFactorTables = {
  AWS: {
    factors: {
      'us-east-1': 0.000365127796,
      'eu-west-2': 0.000305,
      Unknown: 0.0004,
    },
  },
  GCP: {
    factors: { 'europe-west2': 0.000231 },
    basis: 'location-consumption',
    factorType: 'lifecycle',
  },
}

const createSource = (t: StaticFactorTables = tables) =>
  new StaticSource(t, () => retrievedAt)

describe('StaticSource', () => {
  it('has the id static and an open, redistributable licence', () => {
    const source = createSource()
    expect(source.id).toBe('static')
    expect(source.licence).toMatchObject({
      id: 'open-attribution',
      redistributable: true,
      retention: 'unlimited',
    })
    expect(source.licence.attribution).toContain('Cloud Carbon Footprint')
  })

  it('is always reachable and needs no authentication', async () => {
    await expect(createSource().probe()).resolves.toEqual({
      reachable: true,
      authenticated: true,
    })
  })

  describe('mapRegion', () => {
    it('maps a region in the table to a provider-qualified zone', () => {
      expect(createSource().mapRegion('AWS', 'eu-west-2')).toBe('aws:eu-west-2')
    })

    it("falls back to the table's Unknown entry for an unlisted region", () => {
      expect(createSource().mapRegion('AWS', 'mars-north-1')).toBe(
        'aws:Unknown',
      )
    })

    it('returns null for an unlisted region when the table has no Unknown entry', () => {
      expect(createSource().mapRegion('GCP', 'mars-north1')).toBeNull()
    })

    it('returns null for a provider without a table', () => {
      expect(createSource().mapRegion('AZURE', 'uksouth')).toBeNull()
    })

    it('reads a factor getter at call time', () => {
      let useAlternative = false
      const source = createSource({
        GCP: {
          factors: () =>
            useAlternative ? { 'us-central1': 0.00005369 } : { other: 0.1 },
        },
      })
      expect(source.mapRegion('GCP', 'us-central1')).toBeNull()
      useAlternative = true
      expect(source.mapRegion('GCP', 'us-central1')).toBe('gcp:us-central1')
    })
  })

  describe('capabilities', () => {
    it('reports annual granularity, the table basis and the source licence', async () => {
      const source = createSource()
      await expect(source.capabilities('gcp:europe-west2')).resolves.toEqual({
        zoneId: 'gcp:europe-west2',
        granularities: ['year'],
        bases: ['location-consumption'],
        licence: source.licence,
      })
    })

    it('defaults the basis to location-production', async () => {
      const capability = await createSource().capabilities('aws:us-east-1')
      expect(capability?.bases).toEqual(['location-production'])
    })

    it.each(['aws:mars-north-1', 'azure:uksouth', 'no-separator', 'nasa:moon'])(
      'returns null for the unknown zone %s',
      async (zoneId) => {
        await expect(createSource().capabilities(zoneId)).resolves.toBeNull()
      },
    )
  })

  describe('fetch', () => {
    it('returns one annual point per calendar year overlapping the range, in gCO2e/kWh', async () => {
      const points = await createSource().fetch(
        'aws:us-east-1',
        utc('2025-12-31T00:00:00.000Z'),
        utc('2026-01-02T00:00:00.000Z'),
        'year',
      )
      expect(points).toEqual([
        {
          zoneId: 'aws:us-east-1',
          periodStart: utc('2025-01-01T00:00:00.000Z'),
          periodEnd: utc('2026-01-01T00:00:00.000Z'),
          granularity: 'year',
          gCO2ePerKWh: 365.127796,
          basis: 'location-production',
          factorType: 'direct',
          isEstimated: false,
          sourceId: 'static',
          retrievedAt,
        },
        {
          zoneId: 'aws:us-east-1',
          periodStart: utc('2026-01-01T00:00:00.000Z'),
          periodEnd: utc('2027-01-01T00:00:00.000Z'),
          granularity: 'year',
          gCO2ePerKWh: 365.127796,
          basis: 'location-production',
          factorType: 'direct',
          isEstimated: false,
          sourceId: 'static',
          retrievedAt,
        },
      ])
    })

    it('stamps points with the current time when no clock is given', async () => {
      const before = Date.now()
      const [point] = await new StaticSource(tables).fetch(
        'aws:us-east-1',
        utc('2026-03-01T00:00:00.000Z'),
        utc('2026-03-02T00:00:00.000Z'),
        'year',
      )
      expect(point.retrievedAt.getTime()).toBeGreaterThanOrEqual(before)
      expect(point.retrievedAt.getTime()).toBeLessThanOrEqual(Date.now())
    })

    it('uses the basis and factor type the table declares', async () => {
      const [point] = await createSource().fetch(
        'gcp:europe-west2',
        utc('2026-03-01T00:00:00.000Z'),
        utc('2026-03-02T00:00:00.000Z'),
        'year',
      )
      expect(point).toMatchObject({
        gCO2ePerKWh: 231,
        basis: 'location-consumption',
        factorType: 'lifecycle',
      })
    })

    it('serves the Unknown entry for the Unknown zone', async () => {
      const [point] = await createSource().fetch(
        'aws:Unknown',
        utc('2026-03-01T00:00:00.000Z'),
        utc('2026-03-02T00:00:00.000Z'),
        'year',
      )
      expect(point.gCO2ePerKWh).toBe(400)
    })

    it('returns no points for an empty range', async () => {
      const t = utc('2026-03-01T00:00:00.000Z')
      await expect(
        createSource().fetch('aws:us-east-1', t, t, 'year'),
      ).resolves.toEqual([])
    })

    it('rejects granularities finer than annual', async () => {
      await expect(
        createSource().fetch(
          'aws:us-east-1',
          utc('2026-03-01T00:00:00.000Z'),
          utc('2026-03-02T00:00:00.000Z'),
          'day',
        ),
      ).rejects.toThrow('Static source only provides year granularity')
    })

    it('rejects an unknown zone', async () => {
      await expect(
        createSource().fetch(
          'aws:mars-north-1',
          utc('2026-03-01T00:00:00.000Z'),
          utc('2026-03-02T00:00:00.000Z'),
          'year',
        ),
      ).rejects.toThrow('Static source has no factor for zone aws:mars-north-1')
    })
  })
})
