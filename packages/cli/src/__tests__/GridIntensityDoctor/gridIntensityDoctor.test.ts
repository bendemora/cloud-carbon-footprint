/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { setConfig } from '@cloud-carbon-footprint/common'
import { App } from '@cloud-carbon-footprint/app'
import {
  CapabilityReport,
  MongoDbIntensityStore,
  SourceCapabilitySummary,
} from '@cloud-carbon-footprint/grid-intensity'
import gridIntensityDoctor, {
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
          sources: [staticEntry('azure:Unknown')],
        },
      ],
    })
    expect(tableOf(output)).toEqual([
      '| Provider | Region       | Source | Zone          | Last 24 hours | Last 30 days | Last 12 months | Licence | Error',
      '| AWS      | eu-west-2    | static | aws:eu-west-2 | D             | D            | D              | open    |',
      '| AZURE    | qatarcentral | static | azure:Unknown | D             | D            | D              | open    |',
    ])
    expect(output).toContain('2026-11-10T12:00:00.000Z')
  })

  it('shows a source without a zone, a licence that needs acknowledgement and an error', () => {
    const output = formatCapabilityReport({
      generatedAt: GENERATED_AT,
      regions: [
        london([
          liveEntry({
            sourceId: 'electricitymaps',
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
      '| Provider | Region    | Source          | Zone | Last 24 hours | Last 30 days | Last 12 months | Licence               | Error',
      '| AWS      | eu-west-2 | electricitymaps | GB   | B             | B            | B              | needs-acknowledgement | HTTP 401',
      '| AWS      | eu-west-2 | neso            | -    | -             | -            | -              | unavailable           |',
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
      expect(cells[7]).toBe(expectedCell)
    },
  )

  it('lists a region that has no source', () => {
    const output = formatCapabilityReport({
      generatedAt: GENERATED_AT,
      regions: [london([])],
    })
    expect(tableOf(output)[1]).toBe(
      '| AWS      | eu-west-2 | -      | -    | -             | -            | -              | -       |',
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

  it('states the Electricity Maps v3 lookup and adds the zone it uses for each region', () => {
    const output = formatCapabilityReport({
      generatedAt: GENERATED_AT,
      legacyElectricityMaps: {
        sourceId: 'electricitymaps-v3',
        qualityTier: 'C',
        message: 'The v3 lookup is in use, tier C.',
      },
      regions: [
        {
          ...london([staticEntry('aws:eu-west-2')]),
          legacyElectricityMapsZoneId: 'GB',
        },
        {
          provider: 'AWS',
          region: 'Unknown',
          sources: [staticEntry('aws:Unknown')],
          legacyElectricityMapsZoneId: null,
        },
      ],
    })
    expect(output).toContain('The v3 lookup is in use, tier C.')
    expect(tableOf(output)).toEqual([
      '| Provider | Region    | Electricity Maps v3 zone | Source | Zone          | Last 24 hours | Last 30 days | Last 12 months | Licence | Error',
      '| AWS      | eu-west-2 | GB                       | static | aws:eu-west-2 | D             | D            | D              | open    |',
      '| AWS      | Unknown   | -                        | static | aws:Unknown   | D             | D            | D              | open    |',
    ])
  })
})

describe('gridIntensityDoctor', () => {
  // Run on the settings below alone, whatever the shell has set.
  const SETTINGS = [
    'ELECTRICITY_MAPS_TOKEN',
    'GRID_INTENSITY_SOURCES',
    'GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS',
    'GRID_INTENSITY_STORE',
    'MONGODB_URI',
    'MONGODB_CREDENTIALS',
    'AWS_INCLUDE_ESTIMATES',
    'GCP_INCLUDE_ESTIMATES',
    'AZURE_INCLUDE_ESTIMATES',
    'GCP_USE_CARBON_FREE_ENERGY_PERCENTAGE',
  ]
  const saved: Record<string, string | undefined> = {}
  const closeStore = jest
    .spyOn(MongoDbIntensityStore.prototype, 'close')
    .mockResolvedValue(undefined)

  const configure = (settings: Record<string, string> = {}) => {
    Object.assign(process.env, settings)
    setConfig()
  }

  beforeEach(() => {
    for (const name of SETTINGS) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    closeStore.mockClear()
    configure()
  })

  afterEach(() => {
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
    expect(cells.find((row) => row[2] === 'eu-west-2')[4]).toBe('aws:eu-west-2')
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
})
