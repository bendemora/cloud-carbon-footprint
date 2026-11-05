/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  mkdir,
  utimes,
} from 'fs/promises'
import fsPromises from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { LocalIntensityStore } from '../stores/LocalIntensityStore'
import { Granularity, IntensityPoint } from '../types'

const utc = (iso: string) => new Date(iso)
const HOUR_MS = 3600 * 1000

/** `hours` hourly points from `dayStart`, valued by hour of the month. */
const hourly = (dayStart: string, hours = 24): IntensityPoint[] =>
  Array.from({ length: hours }, (_, i) => {
    const start = new Date(utc(dayStart).getTime() + i * HOUR_MS)
    return point(
      start.toISOString(),
      new Date(start.getTime() + HOUR_MS).toISOString(),
      { gCO2ePerKWh: start.getUTCDate() * 100 + start.getUTCHours() },
    )
  })

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

  describe('overlapping writes', () => {
    const october = (store: LocalIntensityStore) =>
      store.get(
        'electricitymaps',
        'GB',
        utc('2026-10-01T00:00:00.000Z'),
        utc('2026-11-01T00:00:00.000Z'),
        'hour',
      )

    it('keeps every point when puts to the same file overlap', async () => {
      const store = new LocalIntensityStore(directory)
      const days = Array.from(
        { length: 10 },
        (_, d) => `2026-10-${String(d + 1).padStart(2, '0')}T00:00:00.000Z`,
      )
      await Promise.all(days.map((day) => store.put(hourly(day))))
      const points = await october(store)
      expect(points).toHaveLength(240)
      expect(points[239].gCO2ePerKWh).toBe(1023)
    })

    it('leaves a readable file when a large and a small put overlap', async () => {
      const store = new LocalIntensityStore(directory)
      const large = Array.from({ length: 25 }, (_, d) =>
        hourly(`2026-10-${String(d + 1).padStart(2, '0')}T00:00:00.000Z`),
      ).flat()
      await Promise.all([
        store.put(large),
        store.put(hourly('2026-10-30T00:00:00.000Z', 1)),
      ])
      await expect(october(store)).resolves.toHaveLength(601)
    })

    it('keeps every point when two stores on one directory write at once', async () => {
      const first = new LocalIntensityStore(directory)
      const second = new LocalIntensityStore(`${directory}/`)
      await Promise.all([
        first.put(hourly('2026-10-01T00:00:00.000Z')),
        second.put(hourly('2026-10-02T00:00:00.000Z')),
        first.put(hourly('2026-10-03T00:00:00.000Z')),
      ])
      await expect(october(first)).resolves.toHaveLength(72)
    })

    it('keeps every point when a purge and a put overlap', async () => {
      const store = new LocalIntensityStore(directory)
      await store.put(
        hourly('2026-10-01T00:00:00.000Z').map((p) => ({
          ...p,
          retrievedAt: utc('2026-09-01T00:00:00.000Z'),
        })),
      )
      const [removed] = await Promise.all([
        store.purge('electricitymaps', utc('2026-10-01T00:00:00.000Z')),
        store.put(hourly('2026-10-02T00:00:00.000Z')),
      ])
      expect(removed).toBe(24)
      await expect(october(store)).resolves.toHaveLength(24)
    })

    it('leaves no temporary files behind', async () => {
      const store = new LocalIntensityStore(directory)
      await Promise.all([
        store.put(hourly('2026-10-01T00:00:00.000Z')),
        store.put(hourly('2026-10-02T00:00:00.000Z')),
      ])
      expect(await readdir(join(directory, 'electricitymaps', 'GB'))).toEqual([
        '2026-10.hour.json',
      ])
    })

    it('removes its temporary file when a write fails', async () => {
      const store = new LocalIntensityStore(directory)
      await store.put(hourly('2026-10-01T00:00:00.000Z', 1))
      const rename = jest
        .spyOn(fsPromises, 'rename')
        .mockRejectedValueOnce(new Error('EXDEV: cross-device link'))
      try {
        await expect(
          store.put(hourly('2026-10-02T00:00:00.000Z', 1)),
        ).rejects.toThrow('EXDEV')
      } finally {
        rename.mockRestore()
      }
      expect(await readdir(join(directory, 'electricitymaps', 'GB'))).toEqual([
        '2026-10.hour.json',
      ])
      await expect(october(store)).resolves.toHaveLength(1)
    })
  })

  describe('ids that differ only in case', () => {
    // A case-insensitive file system (the macOS default) resolves the path of
    // zone 'gb' to the directory of zone 'GB'. Simulated here by writing
    // zone GB's file where zone gb's file would be, so the test behaves the
    // same on case-sensitive file systems.
    const collide = async () => {
      await new LocalIntensityStore(directory).put(
        hourly('2026-10-01T00:00:00.000Z', 1),
      )
      await mkdir(join(directory, 'electricitymaps', 'gb'), {
        recursive: true,
      })
      await writeFile(
        join(directory, 'electricitymaps', 'gb', '2026-10.hour.json'),
        await readFile(
          join(directory, 'electricitymaps', 'GB', '2026-10.hour.json'),
        ),
      )
    }

    it("does not return another zone's points", async () => {
      await collide()
      await expect(
        new LocalIntensityStore(directory).get(
          'electricitymaps',
          'gb',
          utc('2026-10-01T00:00:00.000Z'),
          utc('2026-10-02T00:00:00.000Z'),
          'hour',
        ),
      ).resolves.toEqual([])
    })

    it("refuses to write into another zone's file, naming both ids", async () => {
      await collide()
      await expect(
        new LocalIntensityStore(directory).put(
          hourly('2026-10-01T00:00:00.000Z', 1).map((p) => ({
            ...p,
            zoneId: 'gb',
          })),
        ),
      ).rejects.toThrow("holds zone 'GB', not 'gb'")
    })

    it('checks the source id the same way', async () => {
      await collide()
      const store = new LocalIntensityStore(directory)
      await writeFile(
        join(directory, 'electricitymaps', 'GB', '2026-10.hour.json'),
        JSON.stringify({
          version: 1,
          sourceId: 'ElectricityMaps',
          zoneId: 'GB',
          granularity: 'hour',
          points: [],
        }),
      )
      await expect(
        store.put(hourly('2026-10-01T00:00:00.000Z', 1)),
      ).rejects.toThrow("holds source 'ElectricityMaps', not 'electricitymaps'")
    })
  })

  describe('purge with files the store did not write', () => {
    const expired = (zoneId: string) =>
      hourly('2026-10-01T00:00:00.000Z', 1).map((p) => ({
        ...p,
        zoneId,
        retrievedAt: utc('2026-09-01T00:00:00.000Z'),
      }))
    const cutOff = utc('2026-10-01T00:00:00.000Z')

    it('skips files and directories that are not store files', async () => {
      const store = new LocalIntensityStore(directory)
      await store.put([...expired('DE'), ...expired('FR')])
      await writeFile(join(directory, 'electricitymaps', '.DS_Store'), 'x')
      await writeFile(
        join(directory, 'electricitymaps', 'DE', '.DS_Store'),
        'x',
      )
      await mkdir(join(directory, 'electricitymaps', 'DE', 'notes'))
      await expect(store.purge('electricitymaps', cutOff)).resolves.toBe(2)
      expect(
        (await readdir(join(directory, 'electricitymaps', 'DE'))).sort(),
      ).toEqual(['.DS_Store', 'notes'])
    })

    it('removes temporary files last changed before the cut-off and keeps newer ones', async () => {
      const store = new LocalIntensityStore(directory)
      await store.put(
        hourly('2026-10-01T00:00:00.000Z', 1).map((p) => ({
          ...p,
          zoneId: 'DE',
        })),
      )
      const zoneDirectory = join(directory, 'electricitymaps', 'DE')
      const stale = join(zoneDirectory, '2026-10.hour.json.4242-1.tmp')
      const inFlight = join(zoneDirectory, '2026-10.hour.json.4243-1.tmp')
      await writeFile(stale, '{"version":1,"poi')
      await writeFile(inFlight, '{"version":1,"poi')
      const longAgo = utc('2026-09-01T00:00:00.000Z')
      await utimes(stale, longAgo, longAgo)
      await expect(store.purge('electricitymaps', cutOff)).resolves.toBe(0)
      expect((await readdir(zoneDirectory)).sort()).toEqual([
        '2026-10.hour.json',
        '2026-10.hour.json.4243-1.tmp',
      ])
    })

    it('purges the other files when one is corrupt, then reports it', async () => {
      const store = new LocalIntensityStore(directory)
      await store.put([...expired('DE'), ...expired('FR')])
      const corrupt = join(
        directory,
        'electricitymaps',
        'DE',
        '2026-10.hour.json',
      )
      await writeFile(corrupt, '{ not json')
      await expect(store.purge('electricitymaps', cutOff)).rejects.toThrow(
        corrupt,
      )
      expect(await readdir(join(directory, 'electricitymaps', 'FR'))).toEqual(
        [],
      )
    })

    it('purges the other zones when a zone directory cannot be listed', async () => {
      const store = new LocalIntensityStore(directory)
      await store.put([...expired('DE'), ...expired('FR')])
      const unreadable = join(directory, 'electricitymaps', 'DE')
      const original = fsPromises.readdir
      const list = jest
        .spyOn(fsPromises, 'readdir')
        .mockImplementation(((path: string, options: never) =>
          path === unreadable
            ? Promise.reject(new Error(`EACCES: scandir '${path}'`))
            : original(path, options)) as never)
      try {
        await expect(store.purge('electricitymaps', cutOff)).rejects.toThrow(
          `could not purge 1 of the store's paths (points removed from the others: 1): EACCES: scandir '${unreadable}'`,
        )
      } finally {
        list.mockRestore()
      }
      expect(await readdir(join(directory, 'electricitymaps', 'FR'))).toEqual(
        [],
      )
    })
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
