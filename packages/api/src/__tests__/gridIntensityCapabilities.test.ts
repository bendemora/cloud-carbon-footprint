/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express'
import request from 'supertest'

import { setConfig } from '@cloud-carbon-footprint/common'
import { App } from '@cloud-carbon-footprint/app'
import { shutdownDefaultResolver } from '@cloud-carbon-footprint/grid-intensity'

import { createRouter } from '../api'

// The settings the report depends on. Each test starts with none of them
// set, which is the default configuration.
const SETTINGS = [
  'GRID_INTENSITY_SOURCES',
  'GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS',
  'GRID_INTENSITY_STORE',
  'AWS_INCLUDE_ESTIMATES',
  'GCP_INCLUDE_ESTIMATES',
  'AZURE_INCLUDE_ESTIMATES',
  'GCP_USE_CARBON_FREE_ENERGY_PERCENTAGE',
]

describe('GET /grid-intensity/capabilities', () => {
  const saved: Record<string, string | undefined> = {}

  /** A server on the configuration the environment gives. */
  const server = () => express().use(createRouter())

  beforeEach(() => {
    for (const name of SETTINGS) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
  })

  afterEach(async () => {
    await shutdownDefaultResolver()
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
})
