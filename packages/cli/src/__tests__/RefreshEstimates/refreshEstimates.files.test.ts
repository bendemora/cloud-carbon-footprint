/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * The refresh-estimates command with the real app and a local cache file in
 * a temporary directory. Only the estimation that asks the cloud providers
 * is replaced. The other tests of the command replace the app.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  EstimationResult,
  GroupBy,
  ServiceData,
  setConfig,
} from '@cloud-carbon-footprint/common'
import { App } from '@cloud-carbon-footprint/app'
import refreshEstimates from '../../RefreshEstimates/refreshEstimates'

const rowOf = (
  cloudProvider: string,
  serviceName: string,
  isProvisional = false,
): ServiceData => ({
  cloudProvider,
  kilowattHours: 1.5,
  co2e: 0.0005,
  cost: 2,
  usesAverageCPUConstant: false,
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

const dayOf = (
  date: string,
  serviceEstimates: ServiceData[],
): EstimationResult => ({
  timestamp: new Date(date),
  serviceEstimates,
  periodStartDate: new Date(date),
  periodEndDate: new Date(`${date}T23:59:59.000Z`),
  groupBy: GroupBy.day,
})

/** The text of a cache file: a JSON array with one estimation result per line. */
const cacheText = (estimates: EstimationResult[]) =>
  '[\n' + estimates.map((e) => JSON.stringify(e)).join('\n,\n') + '\n]'

describe('refreshEstimates with a local cache file', () => {
  // Run on the settings below alone, whatever the shell has set.
  const SETTINGS = ['CACHE_MODE', 'CCF_CACHE_PATH', 'TEST_MODE']
  const saved: Record<string, string | undefined> = {}
  let directory: string
  let cacheFile: string
  let estimation: jest.SpyInstance

  const cached = () => [
    dayOf('2026-11-01', [rowOf('AWS', 'cached')]),
    dayOf('2026-11-02', [rowOf('AWS', 'cached', true), rowOf('GCP', 'cached')]),
    dayOf('2026-11-03', [rowOf('AWS', 'cached', true)]),
    dayOf('2026-11-05', [rowOf('AWS', 'cached', true)]),
  ]

  const command = (...options: string[]) => [
    'executable',
    'file',
    '--startDate',
    '2026-11-01',
    '--endDate',
    '2026-11-07',
    ...options,
  ]

  beforeEach(async () => {
    for (const name of SETTINGS) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    directory = await mkdtemp(join(tmpdir(), 'refresh-estimates-'))
    process.env.CCF_CACHE_PATH = join(directory, 'estimates.cache')
    cacheFile = join(directory, 'estimates.cache.day.json')
    setConfig()
    estimation = jest.spyOn(App.prototype, 'getCostAndEstimatesWithoutCache')
  })

  afterEach(async () => {
    estimation.mockRestore()
    await rm(directory, { recursive: true, force: true })
    for (const name of SETTINGS) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    setConfig()
  })

  it('replaces the provisional periods in the cache file and reports what it did', async () => {
    await writeFile(cacheFile, cacheText(cached()), 'utf8')
    estimation
      .mockResolvedValueOnce([
        dayOf('2026-11-02', [rowOf('AWS', 'new')]),
        dayOf('2026-11-03', [rowOf('AWS', 'new', true)]),
      ])
      .mockResolvedValueOnce([])

    const { output, exitCode } = await refreshEstimates(command())

    expect(estimation.mock.calls).toEqual([
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
          startDate: new Date('2026-11-05T00:00:00.000Z'),
          endDate: new Date('2026-11-05T23:59:59.999Z'),
          ignoreCache: true,
          groupBy: 'day',
        },
      ],
    ])
    const [first, , , fourth] = cached()
    expect(await readFile(cacheFile, 'utf8')).toEqual(
      cacheText([
        first,
        dayOf('2026-11-02', [rowOf('GCP', 'cached'), rowOf('AWS', 'new')]),
        dayOf('2026-11-03', [rowOf('AWS', 'new', true)]),
        fourth,
      ]),
    )
    expect(await readdir(directory)).toEqual(['estimates.cache.day.json'])
    expect(output.split('\n')).toEqual([
      'Refresh of the cached estimates grouped by day',
      `Cache: file ${cacheFile}`,
      'Range: periods that start from 2026-11-01T00:00:00.000Z to 2026-11-07T00:00:00.000Z',
      'Refreshing: the cached periods in the range that hold provisional rows',
      'Cached periods in the range: 4',
      'Provisional before: 3',
      'Estimation requests, one for each run of adjacent periods: 2',
      'Periods refreshed: 2',
      'Periods left alone because the new estimate had no rows: 1',
      'Periods kept because the new estimate had a worse quality tier: 0',
      'Provisional after: 2',
      'Failed runs: 0',
    ])
    expect(exitCode).toBe(0)
  })

  it('refreshes every cached period in the range with --all, and ends with 1 when a run fails', async () => {
    await writeFile(cacheFile, cacheText(cached()), 'utf8')
    estimation
      .mockResolvedValueOnce([
        dayOf('2026-11-01', [rowOf('AWS', 'new')]),
        dayOf('2026-11-02', [rowOf('AWS', 'new'), rowOf('GCP', 'new')]),
        dayOf('2026-11-03', [rowOf('AWS', 'new')]),
      ])
      .mockRejectedValueOnce(new Error('The billing query failed'))

    const { output, exitCode } = await refreshEstimates(command('--all'))

    expect(await readFile(cacheFile, 'utf8')).toEqual(
      cacheText([
        dayOf('2026-11-01', [rowOf('AWS', 'new')]),
        dayOf('2026-11-02', [rowOf('AWS', 'new'), rowOf('GCP', 'new')]),
        dayOf('2026-11-03', [rowOf('AWS', 'new')]),
        cached()[3],
      ]),
    )
    expect(output.split('\n').slice(4)).toEqual([
      'Cached periods in the range: 4',
      'Provisional before: 3',
      'Estimation requests, one for each run of adjacent periods: 2',
      'Periods refreshed: 3',
      'Periods left alone because the new estimate had no rows: 0',
      'Periods kept because the new estimate had a worse quality tier: 0',
      'Provisional after: 1',
      'Failed runs: 1',
      '  2026-11-05T00:00:00.000Z to 2026-11-05T23:59:59.999Z, 1 period not refreshed: The billing query failed',
    ])
    expect(exitCode).toBe(1)
  })

  it('keeps the cached rows where the new estimate has a worse quality tier, and says what that may mean', async () => {
    await writeFile(cacheFile, cacheText(cached()), 'utf8')
    // The estimate of a run during which no source could be reached: it has
    // fallen back from tier B to the static factors, tier D.
    const fallback = (cloudProvider: string) => {
      const row = rowOf(cloudProvider, 'new', true)
      row.provenance.qualityTier = 'D'
      return row
    }
    estimation
      .mockResolvedValueOnce([
        dayOf('2026-11-02', [fallback('AWS'), rowOf('GCP', 'new')]),
        dayOf('2026-11-03', [fallback('AWS')]),
      ])
      .mockResolvedValueOnce([dayOf('2026-11-05', [rowOf('AWS', 'new')])])

    const { output, exitCode } = await refreshEstimates(command())

    const [first, second, third] = cached()
    expect(await readFile(cacheFile, 'utf8')).toEqual(
      cacheText([
        first,
        // The AWS rows stay and the GCP row, which is not worse, is replaced.
        dayOf('2026-11-02', [second.serviceEstimates[0], rowOf('GCP', 'new')]),
        third,
        dayOf('2026-11-05', [rowOf('AWS', 'new')]),
      ]),
    )
    expect(output.split('\n').slice(7)).toEqual([
      'Periods refreshed: 1',
      'Periods left alone because the new estimate had no rows: 0',
      'Periods kept because the new estimate had a worse quality tier: 2',
      'Provisional after: 2',
      'Failed runs: 0',
      'Kept periods: a grid intensity source may have been out of reach during the run, so that the new estimate fell back to a worse source. The cached rows of the cloud provider concerned were kept. Run the refresh again later.',
    ])
    expect(exitCode).toBe(0)
  })

  it('does nothing, and creates no cache file, when there is no cache', async () => {
    const { output, exitCode } = await refreshEstimates(command())

    expect(estimation).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
    expect(output.split('\n').slice(4)).toEqual([
      'Cached periods in the range: 0',
      'Provisional before: 0',
      'Estimation requests, one for each run of adjacent periods: 0',
      'Periods refreshed: 0',
      'Periods left alone because the new estimate had no rows: 0',
      'Periods kept because the new estimate had a worse quality tier: 0',
      'Provisional after: 0',
      'Failed runs: 0',
      'Nothing to refresh: the cache holds no period of this grouping in the range.',
    ])
    expect(exitCode).toBe(0)
  })
})
