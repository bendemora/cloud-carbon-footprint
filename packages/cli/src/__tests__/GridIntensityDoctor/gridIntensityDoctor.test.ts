/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { GroupBy, setConfig } from '@cloud-carbon-footprint/common'
import { App, MongoDbCacheManager } from '@cloud-carbon-footprint/app'
import {
  CapabilityReport,
  MongoDbIntensityStore,
  SourceCapabilitySummary,
} from '@cloud-carbon-footprint/grid-intensity'
import gridIntensityDoctor, {
  formatCachedPeriodCounts,
  formatCapabilityReport,
} from '../../GridIntensityDoctor/gridIntensityDoctor'

const GENERATED_AT = new Date('2026-11-10T12:00:00.000Z')

/** One value for the last 24 hours, 30 days and 12 months. */
const every = <T>(value: T) => ({
  last24Hours: value,
  last30Days: value,
  last12Months: value,
})

const staticEntry = (zoneId: string): SourceCapabilitySummary => ({
  sourceId: 'static',
  zoneId,
  licenceState: 'open',
  bestTier: every('D'),
  coverage: every(1),
  attribution: 'CCF static factors',
})

const liveEntry = (
  overrides: Partial<SourceCapabilitySummary> = {},
): SourceCapabilitySummary => ({
  sourceId: 'live',
  zoneId: 'GB',
  licenceState: 'open',
  bestTier: every('B'),
  coverage: every(1),
  attribution: 'Live source',
  ...overrides,
})

const london = (
  sources: SourceCapabilitySummary[],
): CapabilityReport['regions'][number] => ({
  provider: 'AWS',
  region: 'eu-west-2',
  gridZoneId: 'GB',
  sources,
})

const tableOf = (output: string) =>
  output.split('\n').filter((line) => line.startsWith('|'))

describe('formatCapabilityReport', () => {
  it('prints one aligned row for each source of each region, under a header row', () => {
    const output = formatCapabilityReport({
      generatedAt: GENERATED_AT,
      regions: [
        london([staticEntry('aws:eu-west-2')]),
        {
          provider: 'AZURE',
          region: 'qatarcentral',
          gridZoneId: null,
          sources: [staticEntry('azure:Unknown')],
        },
      ],
    })
    expect(tableOf(output)).toEqual([
      '| Provider | Region       | Grid zone | Source | Source zone   | Last 24 hours | Last 30 days | Last 12 months | Licence | Error',
      '| AWS      | eu-west-2    | GB        | static | aws:eu-west-2 | D             | D            | D              | open    |',
      '| AZURE    | qatarcentral | -         | static | azure:Unknown | D             | D            | D              | open    |',
    ])
    expect(output).toContain('2026-11-10T12:00:00.000Z')
  })

  it('shows a source without a zone, a licence that needs acknowledgement and an error', () => {
    const output = formatCapabilityReport({
      generatedAt: GENERATED_AT,
      regions: [
        london([
          liveEntry({
            sourceId: 'licensed-file',
            licenceState: 'needs-acknowledgement',
            error: 'HTTP 401',
          }),
          {
            sourceId: 'neso',
            zoneId: null,
            licenceState: 'unavailable',
            bestTier: every(null),
            coverage: every(0),
          },
        ]),
      ],
    })
    expect(tableOf(output)).toEqual([
      '| Provider | Region    | Grid zone | Source        | Source zone | Last 24 hours | Last 30 days | Last 12 months | Licence               | Error',
      '| AWS      | eu-west-2 | GB        | licensed-file | GB          | B             | B            | B              | needs-acknowledgement | HTTP 401',
      '| AWS      | eu-west-2 | GB        | neso          | -           | -             | -            | -              | unavailable           |',
    ])
  })

  it.each([
    ['91 of 366 days', 91 / 366, 'B (24%)'],
    ['1 of 366 days', 1 / 366, 'B (1%)'],
    ['364 of 365 days', 364 / 365, 'B (99%)'],
    ['every day', 1, 'B'],
  ])(
    'adds the share to a tier the source can deliver for %s of the window',
    (_days, last12Months, expectedCell) => {
      const output = formatCapabilityReport({
        generatedAt: GENERATED_AT,
        regions: [
          london([
            liveEntry({
              coverage: { ...every(1), last12Months },
            }),
          ]),
        ],
      })
      const cells = tableOf(output)[1]
        .split('|')
        .map((cell) => cell.trim())
      expect(cells[8]).toBe(expectedCell)
    },
  )

  it('lists a region that has no source', () => {
    const output = formatCapabilityReport({
      generatedAt: GENERATED_AT,
      regions: [london([])],
    })
    expect(tableOf(output)[1]).toBe(
      '| AWS      | eu-west-2 | GB        | -      | -           | -             | -            | -              | -       |',
    )
  })

  it('lists the attribution of each source once', () => {
    const output = formatCapabilityReport({
      generatedAt: GENERATED_AT,
      regions: [
        london([
          liveEntry({ sourceId: 'file', attribution: 'Dataset one' }),
          staticEntry('aws:eu-west-2'),
        ]),
        {
          provider: 'AWS',
          region: 'eu-west-3',
          gridZoneId: 'FR',
          sources: [
            liveEntry({ sourceId: 'file', attribution: 'Dataset two' }),
            liveEntry({ sourceId: 'neso', attribution: undefined }),
            staticEntry('aws:eu-west-3'),
          ],
        },
      ],
    })
    const afterTable = output.split('\n').slice(-4)
    expect(afterTable).toEqual([
      'Attribution:',
      '  file: Dataset one',
      '  file: Dataset two',
      '  static: CCF static factors',
    ])
  })
})

describe('formatCachedPeriodCounts', () => {
  it('prints one line for each grouping under a heading, and what a provisional period is when there is one', () => {
    expect(
      formatCachedPeriodCounts([
        { groupBy: GroupBy.day, cachedPeriods: 14, provisionalPeriods: 3 },
        { groupBy: GroupBy.month, cachedPeriods: 1, provisionalPeriods: 0 },
      ]),
    ).toEqual([
      '',
      'Cached estimates:',
      '  day: 14 cached periods, 3 provisional',
      '  month: 1 cached period, 0 provisional',
      'A provisional period holds rows whose grid intensity can still improve. The refresh-estimates command estimates such periods again.',
    ])
  })

  it('leaves the explanation out when no period is provisional', () => {
    expect(
      formatCachedPeriodCounts([
        { groupBy: GroupBy.week, cachedPeriods: 2, provisionalPeriods: 0 },
      ]),
    ).toEqual([
      '',
      'Cached estimates:',
      '  week: 2 cached periods, 0 provisional',
    ])
  })

  it('prints nothing when nothing is cached', () => {
    expect(formatCachedPeriodCounts([])).toEqual([])
  })
})

describe('gridIntensityDoctor', () => {
  // Run on the settings below alone, whatever the shell has set.
  const SETTINGS = [
    'GRID_INTENSITY_SOURCES',
    'GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS',
    'GRID_INTENSITY_STORE',
    'MONGODB_URI',
    'MONGODB_CREDENTIALS',
    'AWS_INCLUDE_ESTIMATES',
    'GCP_INCLUDE_ESTIMATES',
    'AZURE_INCLUDE_ESTIMATES',
    'GCP_USE_CARBON_FREE_ENERGY_PERCENTAGE',
    'CACHE_MODE',
    'CCF_CACHE_PATH',
    'TEST_MODE',
  ]
  const saved: Record<string, string | undefined> = {}
  const closeStore = jest
    .spyOn(MongoDbIntensityStore.prototype, 'close')
    .mockResolvedValue(undefined)
  // The directory the local estimates cache is in. It starts empty.
  let cacheDirectory: string

  const configure = (settings: Record<string, string> = {}) => {
    Object.assign(process.env, settings)
    setConfig()
  }

  beforeEach(async () => {
    for (const name of SETTINGS) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    closeStore.mockClear()
    cacheDirectory = await mkdtemp(join(tmpdir(), 'doctor-cache-'))
    configure({ CCF_CACHE_PATH: join(cacheDirectory, 'estimates.cache') })
  })

  afterEach(async () => {
    await rm(cacheDirectory, { recursive: true, force: true })
    for (const name of SETTINGS) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    setConfig()
  })

  afterAll(() => closeStore.mockRestore())

  it('prints tier D from the static source for every AWS, GCP and Azure region with the default configuration', async () => {
    const [header, ...rows] = tableOf(await gridIntensityDoctor())
    const cells = rows.map((row) => row.split('|').map((cell) => cell.trim()))
    const count = (provider: string) =>
      cells.filter((row) => row[1] === provider).length

    expect(header).toContain('| Last 12 months')
    expect(count('AWS')).toBeGreaterThanOrEqual(39)
    expect(count('GCP')).toBeGreaterThanOrEqual(51)
    expect(count('AZURE')).toBeGreaterThanOrEqual(81)
    expect(count('AWS') + count('GCP') + count('AZURE')).toBe(rows.length)
    const unexpected = cells.filter(
      ([
        ,
        ,
        ,
        ,
        source,
        ,
        last24Hours,
        last30Days,
        last12Months,
        licence,
        error,
      ]) =>
        source !== 'static' ||
        [last24Hours, last30Days, last12Months].join('') !== 'DDD' ||
        licence !== 'open' ||
        error !== '',
    )
    expect(unexpected).toEqual([])
    const london = cells.find((row) => row[2] === 'eu-west-2')
    expect(london[3]).toBe('GB')
    expect(london[5]).toBe('aws:eu-west-2')
  })

  it('closes the grid intensity store before it returns', async () => {
    configure({
      GRID_INTENSITY_STORE: 'MONGODB',
      MONGODB_URI: 'mongodb://localhost:27017',
    })
    await gridIntensityDoctor()
    expect(closeStore).toHaveBeenCalledTimes(1)
  })

  it('closes the store when the report fails, and the failure still reaches the caller', async () => {
    configure({
      GRID_INTENSITY_STORE: 'MONGODB',
      MONGODB_URI: 'mongodb://localhost:27017',
    })
    const report = App.prototype.getGridIntensityCapabilities
    const failing = jest
      .spyOn(App.prototype, 'getGridIntensityCapabilities')
      .mockImplementationOnce(async function (this: App) {
        // The default resolver and its store exist once the report is built.
        await report.call(this)
        throw new Error('report failed')
      })

    await expect(gridIntensityDoctor()).rejects.toThrow('report failed')
    expect(closeStore).toHaveBeenCalledTimes(1)
    failing.mockRestore()
  })

  describe('the estimates cache', () => {
    /** A cache file of the grouping with one period for each flag given. */
    const seedCache = (grouping: string, provisional: boolean[]) =>
      writeFile(
        join(cacheDirectory, `estimates.cache.${grouping}.json`),
        '[\n' +
          provisional
            .map((isProvisional, index) =>
              JSON.stringify({
                timestamp: new Date(Date.UTC(2026, index, 1)),
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

    const afterTheTable = (output: string) => {
      const lines = output.split('\n')
      return lines.slice(lines.findIndex((line) => line === 'Attribution:'))
    }

    it('says nothing about it, and creates no cache file, when nothing is cached', async () => {
      const output = await gridIntensityDoctor()

      expect(afterTheTable(output)).toEqual([
        'Attribution:',
        expect.stringMatching(/^ {2}static: /),
      ])
      expect(await readdir(cacheDirectory)).toEqual([])
    })

    it('prints after the table how many periods of each grouping are cached and how many of them are provisional', async () => {
      await seedCache('day', [false, true, true])
      await seedCache('month', [false])

      const output = await gridIntensityDoctor()

      expect(tableOf(output).length).toBeGreaterThan(171)
      expect(afterTheTable(output)).toEqual([
        'Attribution:',
        expect.stringMatching(/^ {2}static: /),
        '',
        'Cached estimates:',
        '  day: 3 cached periods, 2 provisional',
        '  month: 1 cached period, 0 provisional',
        'A provisional period holds rows whose grid intensity can still improve. The refresh-estimates command estimates such periods again.',
      ])
    })

    it('still prints the table when the cache cannot be read, and says why under it', async () => {
      await writeFile(
        join(cacheDirectory, 'estimates.cache.day.json'),
        '[\n{"timestamp":"2026-11-01T00:00:00.000Z"}\n]',
      )

      const output = await gridIntensityDoctor()

      expect(tableOf(output).length).toBeGreaterThan(171)
      expect(afterTheTable(output)).toEqual([
        'Attribution:',
        expect.stringMatching(/^ {2}static: /),
        '',
        'The estimates cache could not be read: The estimates cache holds an entry that is not an estimation result: {"timestamp":"2026-11-01T00:00:00.000Z"}',
      ])
    })

    describe('in MongoDB', () => {
      let createDbConnection: jest.SpyInstance
      const client = { close: jest.fn(), db: jest.fn() }

      /** A client whose collections answer the query for their periods. */
      const periodsIn = (periods: { [collection: string]: unknown[] }) =>
        client.db.mockReturnValue({
          collection: (name: string) => ({
            aggregate: () => ({ toArray: async () => periods[name] ?? [] }),
          }),
        })

      beforeEach(() => {
        client.close.mockReset()
        client.db.mockReset()
        // What createDbConnection does when it can create a client.
        createDbConnection = jest
          .spyOn(MongoDbCacheManager, 'createDbConnection')
          .mockImplementation(async () => {
            MongoDbCacheManager.mongoClient = client as any
          })
        configure({
          CACHE_MODE: 'MONGODB',
          MONGODB_URI: 'mongodb://localhost:27017',
        })
      })

      afterEach(() => {
        createDbConnection.mockRestore()
        MongoDbCacheManager.mongoClient = undefined
      })

      it('connects, counts the periods of each collection and closes the connection', async () => {
        // The query answers for each period, cloud provider and region.
        const rowsOf = (date: string, cloudProvider: string) => ({
          timestamp: new Date(date),
          cloudProvider,
          region: 'eu-west-2',
        })
        periodsIn({
          'estimates-by-day': [
            {
              _id: rowsOf('2026-11-01', 'AWS'),
              provisional: 0,
              worstTier: 'B',
            },
            {
              _id: rowsOf('2026-11-02', 'AWS'),
              provisional: 0,
              worstTier: 'B',
            },
            {
              _id: rowsOf('2026-11-02', 'GCP'),
              provisional: 1,
              worstTier: 'C',
            },
          ],
        })

        const output = await gridIntensityDoctor()

        expect(afterTheTable(output).slice(2)).toEqual([
          '',
          'Cached estimates:',
          '  day: 2 cached periods, 1 provisional',
          'A provisional period holds rows whose grid intensity can still improve. The refresh-estimates command estimates such periods again.',
        ])
        expect(createDbConnection).toHaveBeenCalledTimes(1)
        expect(client.close).toHaveBeenCalledTimes(1)
      })

      it('prints the table and the reason when no connection could be made', async () => {
        // What createDbConnection does when it cannot: it logs and returns.
        createDbConnection.mockImplementation(async () => undefined)

        const output = await gridIntensityDoctor()

        expect(tableOf(output).length).toBeGreaterThan(171)
        expect(afterTheTable(output).slice(2)).toEqual([
          '',
          expect.stringMatching(
            /^The estimates cache could not be read: There is no connection to MongoDB\./,
          ),
        ])
      })

      it('closes the connection when the report fails', async () => {
        MongoDbCacheManager.mongoClient = client as any
        const failing = jest
          .spyOn(App.prototype, 'getGridIntensityCapabilities')
          .mockRejectedValueOnce(new Error('report failed'))

        await expect(gridIntensityDoctor()).rejects.toThrow('report failed')

        expect(createDbConnection).not.toHaveBeenCalled()
        expect(client.close).toHaveBeenCalledTimes(1)
        failing.mockRestore()
      })
    })

    it('does not connect to MongoDB when the estimates cache is elsewhere', async () => {
      const createDbConnection = jest.spyOn(
        MongoDbCacheManager,
        'createDbConnection',
      )

      await gridIntensityDoctor()

      expect(createDbConnection).not.toHaveBeenCalled()
      createDbConnection.mockRestore()
    })
  })
})
