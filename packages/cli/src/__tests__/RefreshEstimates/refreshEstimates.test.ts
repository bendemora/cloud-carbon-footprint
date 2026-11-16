/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  configLoader,
  EstimationRequestValidationError,
  GroupBy,
} from '@cloud-carbon-footprint/common'
import {
  MongoDbCacheManager,
  RefreshSummary,
} from '@cloud-carbon-footprint/app'
import { shutdownDefaultResolver } from '@cloud-carbon-footprint/grid-intensity'
import refreshEstimates, {
  formatRefreshSummary,
} from '../../RefreshEstimates/refreshEstimates'

const mockRefreshEstimates = jest.fn()

jest.mock('@cloud-carbon-footprint/grid-intensity', () => ({
  shutdownDefaultResolver: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@cloud-carbon-footprint/app', () => ({
  ...(jest.requireActual('@cloud-carbon-footprint/app') as Record<
    string,
    unknown
  >),
  App: jest.fn().mockImplementation(() => {
    return {
      refreshEstimates: mockRefreshEstimates,
    }
  }),
}))

jest.mock('@cloud-carbon-footprint/common', () => ({
  ...(jest.requireActual('@cloud-carbon-footprint/common') as Record<
    string,
    unknown
  >),
  configLoader: jest.fn().mockImplementation(() => ({
    CACHE_MODE: '',
  })),
}))

const summaryOf = (
  overrides: Partial<RefreshSummary> = {},
): RefreshSummary => ({
  groupBy: GroupBy.day,
  cache: 'file /ccf/packages/cli/estimates.cache.day.json',
  cachedPeriods: 7,
  provisionalBefore: 3,
  runs: 2,
  refreshedPeriods: 2,
  emptyPeriods: 1,
  keptBecauseWorse: 0,
  provisionalAfter: 1,
  failedRuns: [],
  ...overrides,
})

const command = (...options: string[]) => [
  'executable',
  'file',
  '--startDate',
  '2026-11-01',
  '--endDate',
  '2026-11-07',
  ...options,
]

describe('refreshEstimates', () => {
  beforeEach(() => {
    mockRefreshEstimates.mockReset()
    mockRefreshEstimates.mockResolvedValue(summaryOf())
    ;(shutdownDefaultResolver as jest.Mock).mockClear()
    ;(configLoader as jest.Mock).mockReturnValue({ CACHE_MODE: '' })
  })

  describe('what it asks the app for', () => {
    it('asks for the provisional periods of the range, grouped by day, when given the dates only', async () => {
      await refreshEstimates(command())

      expect(mockRefreshEstimates).toHaveBeenCalledTimes(1)
      expect(mockRefreshEstimates).toHaveBeenCalledWith({
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        endDate: new Date('2026-11-07T00:00:00.000Z'),
        groupBy: 'day',
        includeFinal: false,
        cloudProviderToSeed: undefined,
      })
    })

    it('hands the grouping, --all and the cloud provider to seed on', async () => {
      await refreshEstimates(
        command('--groupBy', 'month', '--all', '--cloudProviderToSeed', 'aws'),
      )

      expect(mockRefreshEstimates).toHaveBeenCalledWith({
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        endDate: new Date('2026-11-07T00:00:00.000Z'),
        groupBy: 'month',
        includeFinal: true,
        cloudProviderToSeed: 'aws',
      })
    })

    it('reads the options of the command line when it is given none', async () => {
      const argv = process.argv
      process.argv = command('--groupBy', 'quarter')
      try {
        await refreshEstimates()
      } finally {
        process.argv = argv
      }

      expect(mockRefreshEstimates).toHaveBeenCalledWith({
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        endDate: new Date('2026-11-07T00:00:00.000Z'),
        groupBy: 'quarter',
        includeFinal: false,
        cloudProviderToSeed: undefined,
      })
    })

    it('takes the short options too', async () => {
      await refreshEstimates([
        'executable',
        'file',
        '-s',
        '2026-10-01',
        '-e',
        '2026-10-31',
        '-g',
        'week',
        '-a',
      ])

      expect(mockRefreshEstimates).toHaveBeenCalledWith({
        startDate: new Date('2026-10-01T00:00:00.000Z'),
        endDate: new Date('2026-10-31T00:00:00.000Z'),
        groupBy: 'week',
        includeFinal: true,
        cloudProviderToSeed: undefined,
      })
    })

    it.each([
      [
        'no dates',
        ['executable', 'file'],
        'Start date must be provided, End date must be provided',
      ],
      [
        'no end date',
        ['executable', 'file', '--startDate', '2026-11-01'],
        'End date must be provided',
      ],
      [
        'a start date after the end date',
        ['executable', 'file', '-s', '2026-11-08', '-e', '2026-11-07'],
        'Start date is after end date',
      ],
      [
        'a grouping that does not exist',
        command('--groupBy', 'hour'),
        'Please specify a valid groupBy period',
      ],
      [
        'a cloud provider that cannot be seeded',
        command('--cloudProviderToSeed', 'asw'),
        'Not a valid cloud provider to seed',
      ],
    ])('refuses %s, and refreshes nothing', async (_what, argv, message) => {
      await expect(refreshEstimates(argv)).rejects.toThrow(
        new EstimationRequestValidationError(message),
      )

      expect(mockRefreshEstimates).not.toHaveBeenCalled()
    })
  })

  describe('what it prints', () => {
    it('prints the summary in plain lines and ends with 0 when no run failed', async () => {
      const { output, exitCode } = await refreshEstimates(command())

      expect(output.split('\n')).toEqual([
        'Refresh of the cached estimates grouped by day',
        'Cache: file /ccf/packages/cli/estimates.cache.day.json',
        'Range: periods that start from 2026-11-01T00:00:00.000Z to 2026-11-07T00:00:00.000Z',
        'Refreshing: the cached periods in the range that hold provisional rows',
        'Cached periods in the range: 7',
        'Provisional before: 3',
        'Estimation requests, one for each run of adjacent periods: 2',
        'Periods refreshed: 2',
        'Periods left alone because the new estimate had no rows: 1',
        'Periods kept because the new estimate had a worse quality tier: 0',
        'Provisional after: 1',
        'Failed runs: 0',
      ])
      expect(exitCode).toBe(0)
    })

    it('lists the runs that failed and ends with 1', async () => {
      mockRefreshEstimates.mockResolvedValue(
        summaryOf({
          refreshedPeriods: 0,
          emptyPeriods: 0,
          keptBecauseWorse: 0,
          provisionalAfter: 3,
          failedRuns: [
            {
              startDate: new Date('2026-11-02T00:00:00.000Z'),
              endDate: new Date('2026-11-03T23:59:59.999Z'),
              periods: 2,
              error: 'The billing query failed',
            },
            {
              startDate: new Date('2026-11-06T00:00:00.000Z'),
              endDate: new Date('2026-11-06T23:59:59.999Z'),
              periods: 1,
              error: 'No credentials',
            },
          ],
        }),
      )

      const { output, exitCode } = await refreshEstimates(command())

      expect(output.split('\n').slice(-3)).toEqual([
        'Failed runs: 2',
        '  2026-11-02T00:00:00.000Z to 2026-11-03T23:59:59.999Z, 2 periods not refreshed: The billing query failed',
        '  2026-11-06T00:00:00.000Z to 2026-11-06T23:59:59.999Z, 1 period not refreshed: No credentials',
      ])
      expect(exitCode).toBe(1)
    })

    it('says that --all was given', async () => {
      const { output } = await refreshEstimates(command('--all'))

      expect(output.split('\n')[3]).toBe(
        'Refreshing: every cached period in the range (--all)',
      )
    })

    it('counts the periods that were kept because the new estimate was worse, and says what that may mean', async () => {
      mockRefreshEstimates.mockResolvedValue(
        summaryOf({
          refreshedPeriods: 1,
          emptyPeriods: 0,
          keptBecauseWorse: 2,
          provisionalAfter: 2,
        }),
      )

      const { output, exitCode } = await refreshEstimates(command())

      expect(output.split('\n').slice(7)).toEqual([
        'Periods refreshed: 1',
        'Periods left alone because the new estimate had no rows: 0',
        'Periods kept because the new estimate had a worse quality tier: 2',
        'Provisional after: 2',
        'Failed runs: 0',
        'Kept periods: a grid intensity source may have been out of reach during the run, so that the new estimate fell back to a worse source. The cached rows of the cloud provider concerned were kept. Run the refresh again later.',
      ])
      // A kept period is not a failure.
      expect(exitCode).toBe(0)
    })

    it('says so when the cache holds no period in the range', () => {
      const output = formatRefreshSummary(
        summaryOf({
          cachedPeriods: 0,
          provisionalBefore: 0,
          runs: 0,
          refreshedPeriods: 0,
          emptyPeriods: 0,
          keptBecauseWorse: 0,
          provisionalAfter: 0,
        }),
        {
          startDate: new Date('2026-11-01'),
          endDate: new Date('2026-11-07'),
          includeFinal: false,
        },
      )

      expect(output.split('\n').slice(-2)).toEqual([
        'Failed runs: 0',
        'Nothing to refresh: the cache holds no period of this grouping in the range.',
      ])
    })

    it('says so when no cached period in the range is provisional', () => {
      const output = formatRefreshSummary(
        summaryOf({
          provisionalBefore: 0,
          runs: 0,
          refreshedPeriods: 0,
          emptyPeriods: 0,
          keptBecauseWorse: 0,
          provisionalAfter: 0,
        }),
        {
          startDate: new Date('2026-11-01'),
          endDate: new Date('2026-11-07'),
          includeFinal: false,
        },
      )

      expect(output.split('\n').slice(-2)).toEqual([
        'Failed runs: 0',
        'Nothing to refresh: no cached period in the range is provisional. Use --all to refresh every cached period.',
      ])
    })
  })

  describe('what it closes', () => {
    it('closes the grid intensity store once the refresh is over', async () => {
      mockRefreshEstimates.mockImplementation(async () => {
        expect(shutdownDefaultResolver).not.toHaveBeenCalled()
        return summaryOf()
      })

      await refreshEstimates(command())

      expect(shutdownDefaultResolver).toHaveBeenCalledTimes(1)
    })

    it('closes it when the refresh fails, and the failure still reaches the caller', async () => {
      mockRefreshEstimates.mockRejectedValue(
        new Error('the cache cannot be read'),
      )

      await expect(refreshEstimates(command())).rejects.toThrow(
        'the cache cannot be read',
      )

      expect(shutdownDefaultResolver).toHaveBeenCalledTimes(1)
    })

    describe('with the estimates cache in MongoDB', () => {
      const mockCreateDbConnection = jest.fn()
      const mockClient = { close: jest.fn() }
      const createDbConnection = MongoDbCacheManager.createDbConnection

      beforeEach(() => {
        mockCreateDbConnection.mockReset()
        mockClient.close.mockReset()
        MongoDbCacheManager.createDbConnection = mockCreateDbConnection
        MongoDbCacheManager.mongoClient = mockClient as any
        ;(configLoader as jest.Mock).mockReturnValue({ CACHE_MODE: 'MONGODB' })
      })

      afterEach(() => {
        MongoDbCacheManager.createDbConnection = createDbConnection
        MongoDbCacheManager.mongoClient = undefined
      })

      it('connects before the refresh and closes the connection after it', async () => {
        mockRefreshEstimates.mockImplementation(async () => {
          expect(mockCreateDbConnection).toHaveBeenCalledTimes(1)
          expect(mockClient.close).not.toHaveBeenCalled()
          return summaryOf()
        })

        await refreshEstimates(command())

        expect(mockClient.close).toHaveBeenCalledTimes(1)
        expect(shutdownDefaultResolver).toHaveBeenCalledTimes(1)
      })

      it('closes the connection when the refresh fails', async () => {
        mockRefreshEstimates.mockRejectedValue(new Error('no rows'))

        await expect(refreshEstimates(command())).rejects.toThrow('no rows')

        expect(mockClient.close).toHaveBeenCalledTimes(1)
      })

      it('has nothing to close when no client could be created, and still reports the failure', async () => {
        MongoDbCacheManager.mongoClient = undefined
        mockRefreshEstimates.mockRejectedValue(
          new Error('There is no connection to MongoDB'),
        )

        await expect(refreshEstimates(command())).rejects.toThrow(
          'There is no connection to MongoDB',
        )
      })
    })

    it('does not connect to MongoDB when the estimates cache is elsewhere', async () => {
      const createDbConnection = jest.spyOn(
        MongoDbCacheManager,
        'createDbConnection',
      )

      await refreshEstimates(command())

      expect(createDbConnection).not.toHaveBeenCalled()
      createDbConnection.mockRestore()
    })
  })
})
