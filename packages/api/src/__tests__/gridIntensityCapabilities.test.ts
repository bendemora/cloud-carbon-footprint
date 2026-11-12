/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import express from 'express'
import request from 'supertest'

import { setConfig } from '@cloud-carbon-footprint/common'
import { App } from '@cloud-carbon-footprint/app'
import { shutdownDefaultResolver } from '@cloud-carbon-footprint/grid-intensity'

import { createRouter } from '../api'

// The settings the report depends on. Each test starts with none of them
// set, which is the default configuration, and with the local estimates
// cache in a directory of its own, which is empty.
const SETTINGS = [
  'GRID_INTENSITY_SOURCES',
  'GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS',
  'GRID_INTENSITY_STORE',
  'AWS_INCLUDE_ESTIMATES',
  'GCP_INCLUDE_ESTIMATES',
  'AZURE_INCLUDE_ESTIMATES',
  'GCP_USE_CARBON_FREE_ENERGY_PERCENTAGE',
  'CACHE_MODE',
  'CCF_CACHE_PATH',
  'TEST_MODE',
]

describe('GET /grid-intensity/capabilities', () => {
  const saved: Record<string, string | undefined> = {}
  let cacheDirectory: string

  /** A server on the configuration the environment gives. */
  const server = () => express().use(createRouter())

  beforeEach(async () => {
    for (const name of SETTINGS) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    cacheDirectory = await mkdtemp(join(tmpdir(), 'capabilities-cache-'))
    process.env.CCF_CACHE_PATH = join(cacheDirectory, 'estimates.cache')
  })

  afterEach(async () => {
    await shutdownDefaultResolver()
    await rm(cacheDirectory, { recursive: true, force: true })
    for (const name of SETTINGS) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    setConfig()
  })

  it('returns as JSON the report that the doctor prints', async () => {
    const response = await request(server()).get('/grid-intensity/capabilities')
    const report = await new App().getGridIntensityCapabilities()

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    )
    expect(response.body.regions).toEqual(
      JSON.parse(JSON.stringify(report.regions)),
    )
    expect(response.body.regions[0]).toEqual({
      provider: 'AWS',
      region: 'us-east-1',
      gridZoneId: 'US-MIDA-PJM',
      sources: [
        {
          sourceId: 'static',
          zoneId: 'aws:us-east-1',
          licenceState: 'open',
          bestTier: { last24Hours: 'D', last30Days: 'D', last12Months: 'D' },
          coverage: { last24Hours: 1, last30Days: 1, last12Months: 1 },
          attribution: expect.stringContaining('Cloud Carbon Footprint'),
        },
      ],
    })
    expect(new Date(response.body.generatedAt).toISOString()).toBe(
      response.body.generatedAt,
    )
  })

  it('answers with a server error when the report cannot be built', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    const failing = jest
      .spyOn(App.prototype, 'getGridIntensityCapabilities')
      .mockRejectedValueOnce(new Error('no report'))

    const response = await request(server()).get('/grid-intensity/capabilities')

    expect(response.status).toBe(500)
    expect(response.text).toBe('Internal Server Error')
    failing.mockRestore()
    consoleError.mockRestore()
  })

  describe('the cachedEstimates parameter', () => {
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

    it.each([
      ['is not there', ''],
      ['is false', '?cachedEstimates=false'],
      ['is empty', '?cachedEstimates='],
      ['is something other than true', '?cachedEstimates=1'],
    ])(
      'leaves the cached periods out, and does not read the cache, when it %s',
      async (_what, query) => {
        await seedCache('day', [false, true])
        const report = jest.spyOn(App.prototype, 'getGridIntensityCapabilities')

        const response = await request(server()).get(
          `/grid-intensity/capabilities${query}`,
        )

        expect(response.status).toBe(200)
        expect(Object.keys(response.body).sort()).toEqual([
          'generatedAt',
          'regions',
        ])
        expect(report).toHaveBeenCalledWith({ cachedEstimates: false })
        report.mockRestore()
      },
    )

    it('adds the cached periods of each grouping, and the provisional ones among them, when it is true', async () => {
      await seedCache('day', [false, true, true])
      await seedCache('month', [false])
      const plain = await request(server()).get('/grid-intensity/capabilities')

      const response = await request(server()).get(
        '/grid-intensity/capabilities?cachedEstimates=true',
      )

      expect(response.status).toBe(200)
      expect(response.body.cachedEstimates).toEqual([
        { groupBy: 'day', cachedPeriods: 3, provisionalPeriods: 2 },
        { groupBy: 'month', cachedPeriods: 1, provisionalPeriods: 0 },
      ])
      expect(response.body.regions).toEqual(plain.body.regions)
      expect(Object.keys(response.body).sort()).toEqual([
        'cachedEstimates',
        'generatedAt',
        'regions',
      ])
    })

    it('answers with an empty list, and creates no cache file, when nothing is cached', async () => {
      const response = await request(server()).get(
        '/grid-intensity/capabilities?cachedEstimates=true',
      )

      expect(response.status).toBe(200)
      expect(response.body.cachedEstimates).toEqual([])
      expect(await readdir(cacheDirectory)).toEqual([])
    })

    it('answers with a server error when the cache cannot be read', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation()
      await writeFile(
        join(cacheDirectory, 'estimates.cache.day.json'),
        '[\n{"timestamp":"2026-11-01T00',
      )

      const response = await request(server()).get(
        '/grid-intensity/capabilities?cachedEstimates=true',
      )

      expect(response.status).toBe(500)
      expect(response.text).toBe('Internal Server Error')
      consoleError.mockRestore()
    })
  })
})
