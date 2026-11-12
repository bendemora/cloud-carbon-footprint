/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EstimationResult,
  getPeriodEndDate,
  GroupBy,
  Logger,
  QualityTier,
  ServiceData,
} from '@cloud-carbon-footprint/common'
import CacheManager, { CachedPeriod } from '../CacheManager'
import { cachedPeriodsOf, replacePeriods } from '../common/helpers'
import { EstimationRequest } from '../CreateValidRequest'
import { refreshCachedEstimates, RefreshRequest } from '../RefreshEstimates'

/** A service estimate of a provider. Its name tells the rows apart. */
const rowOf = (
  cloudProvider: string,
  serviceName: string,
  isProvisional = false,
): ServiceData => ({
  cloudProvider,
  kilowattHours: 1,
  co2e: 1,
  cost: 1,
  accountId: 'account',
  accountName: 'account',
  serviceName,
  region: 'eu-west-2',
  provenance: {
    sourceId: 'live',
    zoneId: 'GB',
    granularity: 'day',
    basis: 'location-consumption',
    factorType: 'direct',
    isEstimated: false,
    licenceId: 'CC-BY-4.0',
    qualityTier: 'B',
    gCO2ePerKWh: 100,
    modelVersion: 'unversioned',
    ...(isProvisional && { isProvisional: true }),
  },
})

const periodOf = (
  date: string,
  serviceEstimates: ServiceData[],
  groupBy = GroupBy.day,
): EstimationResult => ({
  timestamp: new Date(date),
  serviceEstimates,
  periodStartDate: new Date(date),
  periodEndDate: getPeriodEndDate(new Date(date), groupBy),
  groupBy,
})

/** A cached day of AWS rows that are final, or provisional. */
const final = (date: string) => periodOf(date, [rowOf('AWS', 'cached')])
const provisional = (date: string) =>
  periodOf(date, [rowOf('AWS', 'cached', true)])

/**
 * A cache in memory. It answers and replaces as the cache managers do, with
 * the helpers the file managers use, so what it holds after a refresh can be
 * looked at.
 */
const cacheOf = (cached: EstimationResult[]) => {
  const cache = {
    estimates: cached,
    getCachedPeriods: jest.fn(async (_grouping, range) =>
      cachedPeriodsOf(cache.estimates, range),
    ),
    replaceEstimates: jest.fn(
      async (estimates, _grouping, cloudProviders): Promise<void> => {
        cache.estimates = replacePeriods(
          cache.estimates,
          estimates,
          cloudProviders,
        )
      },
    ),
    locationOf: jest.fn((grouping) => `a cache in memory for ${grouping}`),
    manager: undefined as CacheManager,
  }
  cache.manager = cache as unknown as CacheManager
  return cache
}

/** The dates and row names a cache holds. */
const namesOf = (estimates: EstimationResult[]) =>
  estimates.map(({ timestamp, serviceEstimates }) => [
    timestamp.toISOString().slice(0, 10),
    serviceEstimates.map((row) => `${row.cloudProvider} ${row.serviceName}`),
  ])

/** The requests an estimation was asked for. */
const requestsOf = (estimate: jest.Mock): EstimationRequest[] =>
  estimate.mock.calls.map(([request]) => request)

/** The periods of the requests an estimation was asked for. */
const windowsOf = (estimate: jest.Mock) =>
  requestsOf(estimate).map(({ startDate, endDate }) => [
    startDate.toISOString(),
    endDate.toISOString(),
  ])

/**
 * A row of a provider and region with the quality tier, or without
 * provenance when no tier is given.
 */
const tieredRow = (
  cloudProvider: string,
  region: string,
  qualityTier: QualityTier | undefined,
  serviceName: string,
  isProvisional = false,
): ServiceData => {
  const { provenance, ...row } = rowOf(
    cloudProvider,
    serviceName,
    isProvisional,
  )
  return {
    ...row,
    region,
    ...(qualityTier && { provenance: { ...provenance, qualityTier } }),
  }
}

/**
 * An estimation that answers each request with one new AWS row for every
 * day from the start to the end of the request.
 */
const newDays = (isProvisional = false) =>
  jest.fn(async ({ startDate, endDate }: EstimationRequest) => {
    const days: EstimationResult[] = []
    for (
      let day = new Date(startDate);
      day <= endDate;
      day = new Date(day.getTime() + 24 * 3600 * 1000)
    )
      days.push(
        periodOf(day.toISOString().slice(0, 10), [
          rowOf('AWS', 'new', isProvisional),
        ]),
      )
    return days
  })

const november: RefreshRequest = {
  startDate: new Date('2026-11-01'),
  endDate: new Date('2026-11-30'),
  groupBy: GroupBy.day,
}

describe('refreshCachedEstimates', () => {
  describe('which periods it refreshes', () => {
    const cached = () => [
      final('2026-10-31'),
      final('2026-11-01'),
      provisional('2026-11-02'),
      provisional('2026-11-03'),
      final('2026-11-04'),
      provisional('2026-11-06'),
      provisional('2026-12-01'),
    ]

    it('refreshes the periods in the range that hold provisional rows, and no others', async () => {
      const cache = cacheOf(cached())
      const estimate = newDays()

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(namesOf(cache.estimates)).toEqual([
        ['2026-10-31', ['AWS cached']],
        ['2026-11-01', ['AWS cached']],
        ['2026-11-02', ['AWS new']],
        ['2026-11-03', ['AWS new']],
        ['2026-11-04', ['AWS cached']],
        ['2026-11-06', ['AWS new']],
        ['2026-12-01', ['AWS cached']],
      ])
      expect(summary).toEqual({
        groupBy: 'day',
        cache: 'a cache in memory for day',
        cachedPeriods: 5,
        provisionalBefore: 3,
        runs: 2,
        refreshedPeriods: 3,
        emptyPeriods: 0,
        keptBecauseWorse: 0,
        provisionalAfter: 0,
        failedRuns: [],
      })
    })

    it('estimates each run of adjacent periods with one request, without the cache', async () => {
      const cache = cacheOf(cached())
      const estimate = newDays()

      await refreshCachedEstimates(november, estimate, cache.manager)

      expect(estimate.mock.calls).toEqual([
        [
          {
            startDate: new Date('2026-11-02T00:00:00.000Z'),
            endDate: new Date('2026-11-03T23:59:59.999Z'),
            ignoreCache: true,
            groupBy: 'day',
          },
        ],
        [
          {
            startDate: new Date('2026-11-06T00:00:00.000Z'),
            endDate: new Date('2026-11-06T23:59:59.999Z'),
            ignoreCache: true,
            groupBy: 'day',
          },
        ],
      ])
    })

    it('looks only at the cached periods of the grouping whose timestamp lies in the range', async () => {
      const cache = cacheOf(cached())

      await refreshCachedEstimates(november, newDays(), cache.manager)

      expect(cache.getCachedPeriods).toHaveBeenCalledWith('day', {
        startDate: november.startDate,
        endDate: november.endDate,
      })
    })

    it('refreshes every cached period in the range with includeFinal', async () => {
      const cache = cacheOf(cached())
      const estimate = newDays()

      const summary = await refreshCachedEstimates(
        { ...november, includeFinal: true },
        estimate,
        cache.manager,
      )

      expect(windowsOf(estimate)).toEqual([
        ['2026-11-01T00:00:00.000Z', '2026-11-04T23:59:59.999Z'],
        ['2026-11-06T00:00:00.000Z', '2026-11-06T23:59:59.999Z'],
      ])
      expect(namesOf(cache.estimates)).toEqual([
        ['2026-10-31', ['AWS cached']],
        ['2026-11-01', ['AWS new']],
        ['2026-11-02', ['AWS new']],
        ['2026-11-03', ['AWS new']],
        ['2026-11-04', ['AWS new']],
        ['2026-11-06', ['AWS new']],
        ['2026-12-01', ['AWS cached']],
      ])
      expect(summary).toMatchObject({
        cachedPeriods: 5,
        provisionalBefore: 3,
        runs: 2,
        refreshedPeriods: 5,
        emptyPeriods: 0,
        keptBecauseWorse: 0,
        provisionalAfter: 0,
      })
    })

    it('never fills a gap, also when the new estimate has a period that is not cached', async () => {
      const cache = cacheOf([
        provisional('2026-11-04'),
        provisional('2026-11-06'),
      ])
      // An estimation that answers with more days than it was asked for.
      const estimate = jest.fn(async () => [
        periodOf('2026-11-04', [rowOf('AWS', 'new')]),
        periodOf('2026-11-05', [rowOf('AWS', 'new')]),
        periodOf('2026-11-06', [rowOf('AWS', 'new')]),
      ])

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(windowsOf(estimate)).toEqual([
        ['2026-11-04T00:00:00.000Z', '2026-11-04T23:59:59.999Z'],
        ['2026-11-06T00:00:00.000Z', '2026-11-06T23:59:59.999Z'],
      ])
      expect(namesOf(cache.estimates)).toEqual([
        ['2026-11-04', ['AWS new']],
        ['2026-11-06', ['AWS new']],
      ])
      expect(summary).toMatchObject({ runs: 2, refreshedPeriods: 2 })
    })

    it('hands the cloud provider to seed on to each estimation', async () => {
      const cache = cacheOf(cached())
      const estimate = newDays()

      await refreshCachedEstimates(
        { ...november, cloudProviderToSeed: 'aws' },
        estimate,
        cache.manager,
      )

      expect(
        estimate.mock.calls.map(([request]) => request.cloudProviderToSeed),
      ).toEqual(['aws', 'aws'])
    })
  })

  describe('runs of adjacent periods', () => {
    it.each([
      [
        GroupBy.week,
        ['2026-01-05', '2026-01-12', '2026-01-26'],
        [
          // Weeks are ISO weeks: they start on a Monday and end on a Sunday.
          ['2026-01-05T00:00:00.000Z', '2026-01-18T23:59:59.999Z'],
          ['2026-01-26T00:00:00.000Z', '2026-02-01T23:59:59.999Z'],
        ],
      ],
      [
        GroupBy.month,
        ['2026-01-01', '2026-02-01', '2026-04-01'],
        [
          ['2026-01-01T00:00:00.000Z', '2026-02-28T23:59:59.999Z'],
          ['2026-04-01T00:00:00.000Z', '2026-04-30T23:59:59.999Z'],
        ],
      ],
      [
        GroupBy.quarter,
        ['2025-10-01', '2026-01-01', '2026-07-01'],
        [
          ['2025-10-01T00:00:00.000Z', '2026-03-31T23:59:59.999Z'],
          ['2026-07-01T00:00:00.000Z', '2026-09-30T23:59:59.999Z'],
        ],
      ],
      [
        GroupBy.year,
        ['2022-01-01', '2023-01-01', '2025-01-01'],
        [
          ['2022-01-01T00:00:00.000Z', '2023-12-31T23:59:59.999Z'],
          ['2025-01-01T00:00:00.000Z', '2025-12-31T23:59:59.999Z'],
        ],
      ],
    ])(
      'asks for whole periods when grouping by %s',
      async (groupBy, dates, expectedWindows) => {
        const cache = cacheOf(
          dates.map((date) =>
            periodOf(date, [rowOf('AWS', 'cached', true)], groupBy),
          ),
        )
        const estimate = jest.fn(async () =>
          dates.map((date) => periodOf(date, [rowOf('AWS', 'new')], groupBy)),
        )

        const summary = await refreshCachedEstimates(
          {
            startDate: new Date('2020-01-01'),
            endDate: new Date('2030-01-01'),
            groupBy,
          },
          estimate,
          cache.manager,
        )

        expect(windowsOf(estimate)).toEqual(expectedWindows)
        expect(requestsOf(estimate).map((request) => request.groupBy)).toEqual([
          groupBy,
          groupBy,
        ])
        expect(summary).toMatchObject({
          groupBy,
          runs: 2,
          refreshedPeriods: 3,
          provisionalAfter: 0,
        })
      },
    )
  })

  describe('which rows it replaces', () => {
    it('replaces the rows of the providers the new estimate has rows for, and keeps the rows of the others', async () => {
      const cache = cacheOf([
        periodOf('2026-11-02', [
          rowOf('AWS', 'cached', true),
          rowOf('GCP', 'cached'),
          rowOf('AZURE', 'cached'),
        ]),
      ])
      // GCP and Azure are no longer configured: the estimate has AWS only.
      const estimate = newDays()

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(cache.replaceEstimates).toHaveBeenCalledTimes(1)
      expect(cache.replaceEstimates).toHaveBeenCalledWith(
        [periodOf('2026-11-02', [rowOf('AWS', 'new')])],
        'day',
        ['AWS'],
      )
      expect(namesOf(cache.estimates)).toEqual([
        ['2026-11-02', ['GCP cached', 'AZURE cached', 'AWS new']],
      ])
      expect(summary).toMatchObject({
        refreshedPeriods: 1,
        provisionalAfter: 0,
      })
    })

    it('replaces the periods of a run that have rows of the same providers in one call', async () => {
      const cache = cacheOf([
        provisional('2026-11-02'),
        provisional('2026-11-03'),
        provisional('2026-11-04'),
      ])
      const estimate = jest.fn(async () => [
        periodOf('2026-11-02', [rowOf('AWS', 'new')]),
        periodOf('2026-11-03', [rowOf('GCP', 'new'), rowOf('AWS', 'new')]),
        periodOf('2026-11-04', [rowOf('AWS', 'new'), rowOf('AWS', 'new 2')]),
      ])

      await refreshCachedEstimates(november, estimate, cache.manager)

      expect(
        cache.replaceEstimates.mock.calls.map(
          ([estimates, grouping, cloudProviders]) => [
            namesOf(estimates).map(([date]) => date),
            grouping,
            cloudProviders,
          ],
        ),
      ).toEqual([
        [['2026-11-02', '2026-11-04'], 'day', ['AWS']],
        [['2026-11-03'], 'day', ['AWS', 'GCP']],
      ])
    })

    it('still counts a period as provisional when its provisional rows are of a provider that the new estimate has no rows for', async () => {
      const cache = cacheOf([
        periodOf('2026-11-02', [
          rowOf('AWS', 'cached'),
          rowOf('GCP', 'cached', true),
        ]),
      ])

      const summary = await refreshCachedEstimates(
        november,
        newDays(),
        cache.manager,
      )

      expect(namesOf(cache.estimates)).toEqual([
        ['2026-11-02', ['GCP cached', 'AWS new']],
      ])
      expect(summary).toMatchObject({
        provisionalBefore: 1,
        refreshedPeriods: 1,
        provisionalAfter: 1,
      })
    })

    it('counts what the cache holds afterwards: a period whose new rows are provisional again stays provisional', async () => {
      const cache = cacheOf([
        provisional('2026-11-02'),
        provisional('2026-11-03'),
      ])
      const estimate = jest.fn(async () => [
        periodOf('2026-11-02', [rowOf('AWS', 'new')]),
        periodOf('2026-11-03', [rowOf('AWS', 'new', true)]),
      ])

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(summary).toMatchObject({
        provisionalBefore: 2,
        refreshedPeriods: 2,
        provisionalAfter: 1,
      })
      expect(cache.getCachedPeriods).toHaveBeenCalledTimes(2)
    })

    it('takes results of the new estimate that share a timestamp as the rows of one period', async () => {
      const cache = cacheOf([provisional('2026-11-02')])
      const estimate = jest.fn(async () => [
        periodOf('2026-11-02', [rowOf('AWS', 'new')]),
        periodOf('2026-11-02', [rowOf('GCP', 'new')]),
      ])

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(cache.replaceEstimates).toHaveBeenCalledTimes(1)
      expect(cache.replaceEstimates.mock.calls[0][2]).toEqual(['AWS', 'GCP'])
      expect(namesOf(cache.estimates)).toEqual([
        ['2026-11-02', ['AWS new', 'GCP new']],
      ])
      expect(summary).toMatchObject({ refreshedPeriods: 1 })
    })
  })

  describe('a new estimate that is worse than the cached rows', () => {
    const LONDON = 'eu-west-2'
    const VIRGINIA = 'us-east-1'

    /** An estimation that answers with the rows for the 2nd of November. */
    const estimateOf = (...rows: ServiceData[]) =>
      jest.fn(async () => [periodOf('2026-11-02', rows)])

    /** A refresh of November, with what the cache holds for the 2nd after it. */
    const refresh = async (
      cachedRows: ServiceData[],
      newRows: ServiceData[],
      request: RefreshRequest = november,
    ) => {
      const cache = cacheOf([periodOf('2026-11-02', cachedRows)])
      const summary = await refreshCachedEstimates(
        request,
        estimateOf(...newRows),
        cache.manager,
      )
      return { cache, summary, rows: namesOf(cache.estimates)[0][1] }
    }

    it('keeps the cached rows of a provider whose new rows have a worse tier in one region, and replaces the rows of another provider of the same period', async () => {
      // A source for London could not be reached during the run: the new AWS
      // rows there fall back from tier B to the static factors, tier D.
      const { cache, summary, rows } = await refresh(
        [
          tieredRow('AWS', LONDON, 'B', 'cached london', true),
          tieredRow('AWS', VIRGINIA, 'D', 'cached virginia'),
          tieredRow('GCP', LONDON, 'C', 'cached', true),
        ],
        [
          tieredRow('AWS', LONDON, 'D', 'new london', true),
          tieredRow('AWS', VIRGINIA, 'D', 'new virginia'),
          tieredRow('GCP', LONDON, 'B', 'new'),
        ],
      )

      expect(rows).toEqual([
        'AWS cached london',
        'AWS cached virginia',
        'GCP new',
      ])
      // The new AWS rows are not written anywhere.
      expect(cache.replaceEstimates).toHaveBeenCalledTimes(1)
      expect(cache.replaceEstimates).toHaveBeenCalledWith(
        [periodOf('2026-11-02', [tieredRow('GCP', LONDON, 'B', 'new')])],
        'day',
        ['GCP'],
      )
      expect(summary).toEqual({
        groupBy: 'day',
        cache: 'a cache in memory for day',
        cachedPeriods: 1,
        provisionalBefore: 1,
        runs: 1,
        refreshedPeriods: 0,
        emptyPeriods: 0,
        keptBecauseWorse: 1,
        provisionalAfter: 1,
        failedRuns: [],
      })
    })

    it.each([
      ['an equal tier', 'C' as QualityTier],
      ['a better tier', 'A' as QualityTier],
    ])('replaces rows by rows of %s', async (_what, newTier) => {
      const { summary, rows } = await refresh(
        [tieredRow('AWS', LONDON, 'C', 'cached', true)],
        [tieredRow('AWS', LONDON, newTier, 'new')],
      )

      expect(rows).toEqual(['AWS new'])
      expect(summary).toMatchObject({
        refreshedPeriods: 1,
        keptBecauseWorse: 0,
        provisionalAfter: 0,
      })
    })

    it.each([
      [
        'the cached rows have no provenance',
        [tieredRow('AWS', LONDON, undefined, 'cached')],
        [tieredRow('AWS', LONDON, 'D', 'new')],
      ],
      [
        'the new rows have no provenance',
        [tieredRow('AWS', LONDON, 'A', 'cached')],
        [tieredRow('AWS', LONDON, undefined, 'new')],
      ],
      [
        'neither have provenance',
        [tieredRow('AWS', LONDON, undefined, 'cached')],
        [tieredRow('AWS', LONDON, undefined, 'new')],
      ],
    ])('replaces the rows when %s', async (_what, cachedRows, newRows) => {
      const { summary, rows } = await refresh(cachedRows, newRows, {
        ...november,
        includeFinal: true,
      })

      expect(rows).toEqual(['AWS new'])
      expect(summary).toMatchObject({
        refreshedPeriods: 1,
        keptBecauseWorse: 0,
      })
    })

    it('compares a region only when both the cached and the new rows of it have provenance', async () => {
      const { summary, rows } = await refresh(
        [
          tieredRow('AWS', LONDON, 'B', 'cached london', true),
          tieredRow('AWS', 'eu-west-1', 'A', 'cached dublin'),
          tieredRow('AWS', 'eu-west-3', undefined, 'cached paris'),
        ],
        [
          tieredRow('AWS', LONDON, 'B', 'new london'),
          // Dublin has no new rows, Virginia no cached ones, and the cached
          // row of Paris has no provenance: none of the three is compared.
          tieredRow('AWS', VIRGINIA, 'D', 'new virginia'),
          tieredRow('AWS', 'eu-west-3', 'D', 'new paris'),
        ],
      )

      expect(rows).toEqual([
        'AWS new london',
        'AWS new virginia',
        'AWS new paris',
      ])
      expect(summary).toMatchObject({
        refreshedPeriods: 1,
        keptBecauseWorse: 0,
      })
    })

    it('takes the worst tier of the rows of a region on each side', async () => {
      const cachedRows = [
        tieredRow('AWS', LONDON, 'B', 'cached b', true),
        tieredRow('AWS', LONDON, 'C', 'cached c'),
        tieredRow('AWS', LONDON, undefined, 'cached without provenance'),
      ]

      // The worst new tier is C, the worst cached tier: not worse.
      const equal = await refresh(cachedRows, [
        tieredRow('AWS', LONDON, 'A', 'new a'),
        tieredRow('AWS', LONDON, 'C', 'new c'),
      ])
      expect(equal.rows).toEqual(['AWS new a', 'AWS new c'])

      // One new row of tier D among better ones is worse than the cached C.
      const worse = await refresh(cachedRows, [
        tieredRow('AWS', LONDON, 'A', 'new a'),
        tieredRow('AWS', LONDON, 'D', 'new d'),
      ])
      expect(worse.rows).toEqual([
        'AWS cached b',
        'AWS cached c',
        'AWS cached without provenance',
      ])
      expect(worse.summary).toMatchObject({
        refreshedPeriods: 0,
        keptBecauseWorse: 1,
        provisionalAfter: 1,
      })
    })

    it('takes a provider for the same one whatever the case of its name', async () => {
      const { rows } = await refresh(
        [tieredRow('AWS', LONDON, 'B', 'cached', true)],
        [tieredRow('aws', LONDON, 'D', 'new')],
      )

      expect(rows).toEqual(['AWS cached'])
    })

    it('counts a period once when the rows of several providers are kept, and replaces nothing for it', async () => {
      const { cache, summary, rows } = await refresh(
        [
          tieredRow('AWS', LONDON, 'B', 'cached', true),
          tieredRow('GCP', LONDON, 'C', 'cached', true),
        ],
        [
          tieredRow('AWS', LONDON, 'D', 'new', true),
          tieredRow('GCP', LONDON, 'D', 'new', true),
        ],
      )

      expect(rows).toEqual(['AWS cached', 'GCP cached'])
      expect(cache.replaceEstimates).not.toHaveBeenCalled()
      // Nothing was written, so the cache is not read again either.
      expect(cache.getCachedPeriods).toHaveBeenCalledTimes(1)
      expect(summary).toMatchObject({
        refreshedPeriods: 0,
        emptyPeriods: 0,
        keptBecauseWorse: 1,
        provisionalAfter: 1,
        failedRuns: [],
      })
    })

    it('takes the worst of the tiers a cache gives for one provider under several spellings, as a database can', async () => {
      const cache = cacheOf([
        periodOf('2026-11-02', [tieredRow('AWS', LONDON, 'B', 'cached', true)]),
      ])
      const cachedPeriod = (
        ...worstTiers: [string, QualityTier][]
      ): CachedPeriod[] => [
        {
          timestamp: new Date('2026-11-02'),
          isProvisional: true,
          worstTiers: worstTiers.map(([cloudProvider, qualityTier]) => ({
            cloudProvider,
            region: LONDON,
            qualityTier,
          })),
        },
      ]
      // The worst cached tier is C, whatever the order of the answers.
      cache.getCachedPeriods.mockResolvedValue(
        cachedPeriod(['AWS', 'B'], ['aws', 'C'], ['Aws', 'B']),
      )

      const replaced = await refreshCachedEstimates(
        november,
        estimateOf(tieredRow('AWS', LONDON, 'C', 'new')),
        cache.manager,
      )
      const kept = await refreshCachedEstimates(
        november,
        estimateOf(tieredRow('AWS', LONDON, 'D', 'newer')),
        cache.manager,
      )

      expect(replaced).toMatchObject({
        refreshedPeriods: 1,
        keptBecauseWorse: 0,
      })
      expect(kept).toMatchObject({ refreshedPeriods: 0, keptBecauseWorse: 1 })
      expect(namesOf(cache.estimates)).toEqual([['2026-11-02', ['AWS new']]])
    })

    it('keeps final rows too when every cached period is refreshed', async () => {
      const { summary, rows } = await refresh(
        [tieredRow('AWS', LONDON, 'B', 'cached')],
        [tieredRow('AWS', LONDON, 'D', 'new', true)],
        { ...november, includeFinal: true },
      )

      expect(rows).toEqual(['AWS cached'])
      expect(summary).toMatchObject({
        provisionalBefore: 0,
        refreshedPeriods: 0,
        keptBecauseWorse: 1,
        provisionalAfter: 0,
      })
    })

    it('judges each period of a run on its own and counts each once', async () => {
      const cache = cacheOf([
        periodOf('2026-11-02', [tieredRow('AWS', LONDON, 'B', 'cached', true)]),
        periodOf('2026-11-03', [tieredRow('AWS', LONDON, 'C', 'cached', true)]),
        periodOf('2026-11-04', [tieredRow('AWS', LONDON, 'C', 'cached', true)]),
        periodOf('2026-11-05', [tieredRow('AWS', LONDON, 'B', 'cached', true)]),
      ])
      const estimate = jest.fn(async () => [
        periodOf('2026-11-02', [tieredRow('AWS', LONDON, 'C', 'new', true)]),
        periodOf('2026-11-03', [tieredRow('AWS', LONDON, 'C', 'new')]),
        periodOf('2026-11-04', []),
        periodOf('2026-11-05', [tieredRow('AWS', LONDON, 'D', 'new', true)]),
      ])

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(namesOf(cache.estimates)).toEqual([
        ['2026-11-02', ['AWS cached']],
        ['2026-11-03', ['AWS new']],
        ['2026-11-04', ['AWS cached']],
        ['2026-11-05', ['AWS cached']],
      ])
      expect(summary).toEqual({
        groupBy: 'day',
        cache: 'a cache in memory for day',
        cachedPeriods: 4,
        provisionalBefore: 4,
        runs: 1,
        refreshedPeriods: 1,
        emptyPeriods: 1,
        keptBecauseWorse: 2,
        provisionalAfter: 3,
        failedRuns: [],
      })
    })

    it('says in the log which rows it kept and why', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()

      await refresh(
        [tieredRow('AWS', LONDON, 'B', 'cached', true)],
        [tieredRow('AWS', LONDON, 'D', 'new', true)],
      )

      expect(warn).toHaveBeenCalledWith(
        'Kept the cached AWS rows of 2026-11-02T00:00:00.000Z: the new estimate has quality tier D for eu-west-2, where the cache has B. A grid intensity source may have been out of reach.',
      )
      warn.mockRestore()
    })

    it('does not count a kept period among those of a run that fails afterwards', async () => {
      const cache = cacheOf([
        periodOf('2026-11-02', [tieredRow('AWS', LONDON, 'B', 'cached', true)]),
        periodOf('2026-11-03', [tieredRow('AWS', LONDON, 'C', 'cached', true)]),
      ])
      const estimate = jest.fn(async () => [
        periodOf('2026-11-02', [tieredRow('AWS', LONDON, 'D', 'new', true)]),
        periodOf('2026-11-03', [tieredRow('AWS', LONDON, 'B', 'new')]),
      ])
      cache.replaceEstimates.mockRejectedValue(
        new Error('The cache could not be written'),
      )

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(summary).toMatchObject({
        refreshedPeriods: 0,
        emptyPeriods: 0,
        keptBecauseWorse: 1,
        failedRuns: [{ periods: 1, error: 'The cache could not be written' }],
      })
    })
  })

  describe('a new estimate without rows', () => {
    it('leaves a period alone, and counts it, when the new estimate has no rows for it', async () => {
      const cache = cacheOf([
        provisional('2026-11-02'),
        provisional('2026-11-03'),
        provisional('2026-11-04'),
      ])
      const before = cache.estimates
      const estimate = jest.fn(async () => [
        // No result at all for the 2nd, and one without rows for the 3rd.
        periodOf('2026-11-03', []),
        periodOf('2026-11-04', [rowOf('AWS', 'new')]),
      ])

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(cache.estimates[0]).toBe(before[0])
      expect(cache.estimates[1]).toBe(before[1])
      expect(namesOf(cache.estimates)).toEqual([
        ['2026-11-02', ['AWS cached']],
        ['2026-11-03', ['AWS cached']],
        ['2026-11-04', ['AWS new']],
      ])
      expect(summary).toEqual({
        groupBy: 'day',
        cache: 'a cache in memory for day',
        cachedPeriods: 3,
        provisionalBefore: 3,
        runs: 1,
        refreshedPeriods: 1,
        emptyPeriods: 2,
        keptBecauseWorse: 0,
        provisionalAfter: 2,
        failedRuns: [],
      })
    })

    it('replaces nothing, and does not read the cache again, when no new estimate has rows', async () => {
      const cache = cacheOf([provisional('2026-11-02')])

      const summary = await refreshCachedEstimates(
        november,
        jest.fn().mockResolvedValue([]),
        cache.manager,
      )

      expect(cache.replaceEstimates).not.toHaveBeenCalled()
      expect(cache.getCachedPeriods).toHaveBeenCalledTimes(1)
      expect(summary).toMatchObject({
        refreshedPeriods: 0,
        emptyPeriods: 1,
        keptBecauseWorse: 0,
        provisionalAfter: 1,
        failedRuns: [],
      })
    })
  })

  describe('a run that fails', () => {
    const cached = () => [
      provisional('2026-11-02'),
      provisional('2026-11-03'),
      provisional('2026-11-06'),
    ]

    it('leaves the cache as it was for a run whose estimation fails, carries on with the others and reports the failure', async () => {
      const cache = cacheOf(cached())
      const before = cache.estimates
      const estimate = newDays()
      estimate.mockRejectedValueOnce(new Error('The billing query failed'))

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(cache.estimates[0]).toBe(before[0])
      expect(cache.estimates[1]).toBe(before[1])
      expect(namesOf(cache.estimates)).toEqual([
        ['2026-11-02', ['AWS cached']],
        ['2026-11-03', ['AWS cached']],
        ['2026-11-06', ['AWS new']],
      ])
      expect(summary).toEqual({
        groupBy: 'day',
        cache: 'a cache in memory for day',
        cachedPeriods: 3,
        provisionalBefore: 3,
        runs: 2,
        refreshedPeriods: 1,
        emptyPeriods: 0,
        keptBecauseWorse: 0,
        provisionalAfter: 2,
        failedRuns: [
          {
            startDate: new Date('2026-11-02T00:00:00.000Z'),
            endDate: new Date('2026-11-03T23:59:59.999Z'),
            periods: 2,
            error: 'The billing query failed',
          },
        ],
      })
    })

    it('reports every run when all of them fail, and does not read the cache again', async () => {
      const cache = cacheOf(cached())

      const summary = await refreshCachedEstimates(
        november,
        jest.fn().mockRejectedValue(new Error('No credentials')),
        cache.manager,
      )

      expect(cache.replaceEstimates).not.toHaveBeenCalled()
      expect(cache.getCachedPeriods).toHaveBeenCalledTimes(1)
      expect(summary).toMatchObject({
        refreshedPeriods: 0,
        provisionalAfter: 3,
      })
      expect(
        summary.failedRuns.map(({ periods, error }) => [periods, error]),
      ).toEqual([
        [2, 'No credentials'],
        [1, 'No credentials'],
      ])
    })

    it('reports what was thrown when it is not an error', async () => {
      const cache = cacheOf([provisional('2026-11-02')])

      const summary = await refreshCachedEstimates(
        november,
        jest.fn().mockRejectedValue('throttled'),
        cache.manager,
      )

      expect(summary.failedRuns).toEqual([
        {
          startDate: new Date('2026-11-02T00:00:00.000Z'),
          endDate: new Date('2026-11-02T23:59:59.999Z'),
          periods: 1,
          error: 'throttled',
        },
      ])
    })

    it('reports a run whose rows could not be replaced, with the periods that were not', async () => {
      const cache = cacheOf(cached())
      const estimate = jest.fn(async ({ startDate }: EstimationRequest) =>
        startDate.getTime() === new Date('2026-11-02').getTime()
          ? [
              periodOf('2026-11-02', [rowOf('AWS', 'new')]),
              periodOf('2026-11-03', [rowOf('GCP', 'new')]),
            ]
          : [periodOf('2026-11-06', [rowOf('AWS', 'new')])],
      )
      // The first replacement of the first run works, the second does not.
      const replace = cache.replaceEstimates.getMockImplementation()
      cache.replaceEstimates
        .mockImplementationOnce(replace)
        .mockRejectedValueOnce(new Error('The cache could not be written'))

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(namesOf(cache.estimates)).toEqual([
        ['2026-11-02', ['AWS new']],
        ['2026-11-03', ['AWS cached']],
        ['2026-11-06', ['AWS new']],
      ])
      expect(summary).toMatchObject({
        runs: 2,
        refreshedPeriods: 2,
        emptyPeriods: 0,
        keptBecauseWorse: 0,
        provisionalAfter: 1,
        failedRuns: [
          {
            startDate: new Date('2026-11-02T00:00:00.000Z'),
            endDate: new Date('2026-11-03T23:59:59.999Z'),
            periods: 1,
            error: 'The cache could not be written',
          },
        ],
      })
    })

    it('fails as a whole when the cache cannot be read', async () => {
      const cache = cacheOf(cached())
      cache.getCachedPeriods.mockRejectedValue(new Error('the read failed'))
      const estimate = newDays()

      await expect(
        refreshCachedEstimates(november, estimate, cache.manager),
      ).rejects.toThrow('the read failed')

      expect(estimate).not.toHaveBeenCalled()
    })
  })

  describe('nothing to refresh', () => {
    it('does nothing when no period of the range is cached', async () => {
      const cache = cacheOf([provisional('2026-10-31')])
      const estimate = newDays()

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(estimate).not.toHaveBeenCalled()
      expect(cache.replaceEstimates).not.toHaveBeenCalled()
      expect(cache.getCachedPeriods).toHaveBeenCalledTimes(1)
      expect(summary).toEqual({
        groupBy: 'day',
        cache: 'a cache in memory for day',
        cachedPeriods: 0,
        provisionalBefore: 0,
        runs: 0,
        refreshedPeriods: 0,
        emptyPeriods: 0,
        keptBecauseWorse: 0,
        provisionalAfter: 0,
        failedRuns: [],
      })
    })

    it('does nothing when no cached period of the range is provisional', async () => {
      const cache = cacheOf([final('2026-11-01'), final('2026-11-02')])
      const estimate = newDays()

      const summary = await refreshCachedEstimates(
        november,
        estimate,
        cache.manager,
      )

      expect(estimate).not.toHaveBeenCalled()
      expect(summary).toMatchObject({
        cachedPeriods: 2,
        provisionalBefore: 0,
        runs: 0,
        refreshedPeriods: 0,
        provisionalAfter: 0,
      })
    })
  })
})
