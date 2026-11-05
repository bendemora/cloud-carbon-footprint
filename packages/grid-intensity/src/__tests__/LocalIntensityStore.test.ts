/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { LocalIntensityStore } from '../stores/LocalIntensityStore'
import { Granularity, IntensityPoint } from '../types'

const utc = (iso: string) => new Date(iso)

const point = (
  periodStart: string,
  periodEnd: string,
  overrides: Partial<IntensityPoint> = {},
): IntensityPoint => ({
  zoneId: 'GB',
  periodStart: utc(periodStart),
  periodEnd: utc(periodEnd),
  granularity: 'hour' as Granularity,
  gCO2ePerKWh: 100,
  basis: 'location-consumption',
  factorType: 'lifecycle',
  isEstimated: false,
  sourceId: 'electricitymaps',
  retrievedAt: utc('2026-11-01T00:00:00.000Z'),
  ...overrides,
})

describe('LocalIntensityStore', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'grid-intensity-store-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('round-trips points, with dates restored, in period order', async () => {
    const store = new LocalIntensityStore(directory)
    const stored = [
      point('2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z', {
        gCO2ePerKWh: 210.5,
        isEstimated: true,
      }),
      point('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'),
    ]
    await store.put(stored)
    const points = await new LocalIntensityStore(directory).get(
      'electricitymaps',
      'GB',
      utc('2026-01-01T00:00:00.000Z'),
      utc('2026-01-01T02:00:00.000Z'),
      'hour',
    )
    expect(points).toEqual([stored[1], stored[0]])
  })

  it('writes one file per source, zone, granularity and calendar month', async () => {
    const store = new LocalIntensityStore(directory)
    await store.put([
      point('2026-01-31T23:00:00.000Z', '2026-02-01T00:00:00.000Z'),
      point('2026-02-01T00:00:00.000Z', '2026-02-01T01:00:00.000Z'),
      point('2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z', {
        granularity: 'day',
      }),
    ])
    const files = await readdir(join(directory, 'electricitymaps', 'GB'))
    expect(files.sort()).toEqual([
      '2026-01.hour.json',
      '2026-02.day.json',
      '2026-02.hour.json',
    ])
  })

  it('reads points across month boundaries', async () => {
    const store = new LocalIntensityStore(directory)
    await store.put([
      point('2026-01-31T23:00:00.000Z', '2026-02-01T00:00:00.000Z'),
      point('2026-02-01T00:00:00.000Z', '2026-02-01T01:00:00.000Z'),
    ])
    const points = await store.get(
      'electricitymaps',
      'GB',
      utc('2026-01-31T23:00:00.000Z'),
      utc('2026-02-01T01:00:00.000Z'),
      'hour',
    )
    expect(points).toHaveLength(2)
  })

  it('stores annual points in one file per year and finds them from any month', async () => {
    const store = new LocalIntensityStore(directory)
    const annual = point(
      '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
      {
        granularity: 'year',
        sourceId: 'static',
        zoneId: 'aws:eu-west-2',
      },
    )
    await store.put([annual])
    const points = await store.get(
      'static',
      'aws:eu-west-2',
      utc('2026-06-10T00:00:00.000Z'),
      utc('2026-06-11T00:00:00.000Z'),
      'year',
    )
    expect(points).toEqual([annual])
    const files = await readdir(join(directory, 'static', 'aws%3Aeu-west-2'))
    expect(files).toEqual(['2026.year.json'])
  })

  it('replaces a point stored again for the same period', async () => {
    const store = new LocalIntensityStore(directory)
    await store.put([
      point('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'),
    ])
    await store.put([
      point('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', {
        gCO2ePerKWh: 120,
      }),
      point('2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z'),
    ])
    const points = await store.get(
      'electricitymaps',
      'GB',
      utc('2026-01-01T00:00:00.000Z'),
      utc('2026-01-01T02:00:00.000Z'),
      'hour',
    )
    expect(points.map((p) => p.gCO2ePerKWh)).toEqual([120, 100])
  })

  it('returns an empty list when nothing is stored', async () => {
    await expect(
      new LocalIntensityStore(join(directory, 'missing')).get(
        'electricitymaps',
        'GB',
        utc('2026-01-01T00:00:00.000Z'),
        utc('2026-01-01T01:00:00.000Z'),
        'hour',
      ),
    ).resolves.toEqual([])
  })

  it('fails with the file path when a store file is corrupt', async () => {
    const file = join(directory, 'electricitymaps', 'GB', '2026-01.hour.json')
    await mkdir(join(directory, 'electricitymaps', 'GB'), { recursive: true })
    await writeFile(file, '{ not json')
    await expect(
      new LocalIntensityStore(directory).get(
        'electricitymaps',
        'GB',
        utc('2026-01-01T00:00:00.000Z'),
        utc('2026-01-01T01:00:00.000Z'),
        'hour',
      ),
    ).rejects.toThrow(file)
  })

  it('rejects a store file with an unsupported format version', async () => {
    const zoneDirectory = join(directory, 'electricitymaps', 'GB')
    await mkdir(zoneDirectory, { recursive: true })
    await writeFile(
      join(zoneDirectory, '2026-01.hour.json'),
      JSON.stringify({ version: 99, points: [] }),
    )
    await expect(
      new LocalIntensityStore(directory).get(
        'electricitymaps',
        'GB',
        utc('2026-01-01T00:00:00.000Z'),
        utc('2026-01-01T01:00:00.000Z'),
        'hour',
      ),
    ).rejects.toThrow('unsupported format version 99')
  })

  it('rethrows file system errors other than a missing file', async () => {
    // A directory where the store file should be: EISDIR on read.
    await mkdir(join(directory, 'electricitymaps', 'GB', '2026-01.hour.json'), {
      recursive: true,
    })
    await expect(
      new LocalIntensityStore(directory).get(
        'electricitymaps',
        'GB',
        utc('2026-01-01T00:00:00.000Z'),
        utc('2026-01-01T01:00:00.000Z'),
        'hour',
      ),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('rethrows file system errors while listing for a purge', async () => {
    // A file where the source directory should be: ENOTDIR on list.
    await writeFile(join(directory, 'neso'), '')
    await expect(
      new LocalIntensityStore(directory).purge('neso', utc('2026-11-01')),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('keeps zone and source ids such as .. inside the store directory', async () => {
    const store = new LocalIntensityStore(directory)
    await store.put([
      point('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', {
        sourceId: '..',
        zoneId: '../..',
      }),
    ])
    expect(await readdir(directory)).toEqual(['%2E%2E'])
    expect(await readdir(join(directory, '%2E%2E'))).toEqual([
      '%2E%2E%2F%2E%2E',
    ])
  })

  it('purges points of a source retrieved before the cut-off', async () => {
    const store = new LocalIntensityStore(directory)
    await store.put([
      point('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', {
        retrievedAt: utc('2026-10-01T00:00:00.000Z'),
      }),
      point('2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z', {
        retrievedAt: utc('2026-11-04T00:00:00.000Z'),
      }),
      point('2026-02-01T00:00:00.000Z', '2026-02-01T01:00:00.000Z', {
        retrievedAt: utc('2026-10-01T00:00:00.000Z'),
      }),
      point('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', {
        sourceId: 'neso',
        retrievedAt: utc('2026-10-01T00:00:00.000Z'),
      }),
    ])
    await expect(
      store.purge('electricitymaps', utc('2026-11-01T00:00:00.000Z')),
    ).resolves.toBe(2)

    const remaining = await store.get(
      'electricitymaps',
      'GB',
      utc('2026-01-01T00:00:00.000Z'),
      utc('2026-03-01T00:00:00.000Z'),
      'hour',
    )
    expect(remaining.map((p) => p.periodStart.toISOString())).toEqual([
      '2026-01-01T01:00:00.000Z',
    ])
    // A file left with no points is removed.
    const files = await readdir(join(directory, 'electricitymaps', 'GB'))
    expect(files).toEqual(['2026-01.hour.json'])
    await expect(
      store.get(
        'neso',
        'GB',
        utc('2026-01-01T00:00:00.000Z'),
        utc('2026-01-01T01:00:00.000Z'),
        'hour',
      ),
    ).resolves.toHaveLength(1)
  })

  it('purges nothing for a source with no files', async () => {
    await expect(
      new LocalIntensityStore(directory).purge('neso', utc('2026-11-01')),
    ).resolves.toBe(0)
  })

  it('writes a versioned file format', async () => {
    const store = new LocalIntensityStore(directory)
    await store.put([
      point('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'),
    ])
    const content = JSON.parse(
      await readFile(
        join(directory, 'electricitymaps', 'GB', '2026-01.hour.json'),
        'utf8',
      ),
    )
    expect(content).toMatchObject({
      version: 1,
      sourceId: 'electricitymaps',
      zoneId: 'GB',
      granularity: 'hour',
    })
    expect(content.points[0]).toEqual({
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-01-01T01:00:00.000Z',
      gCO2ePerKWh: 100,
      basis: 'location-consumption',
      factorType: 'lifecycle',
      isEstimated: false,
      retrievedAt: '2026-11-01T00:00:00.000Z',
    })
  })
})
