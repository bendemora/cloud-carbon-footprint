/*
 * © 2026 Ben de Mora
 * SPDX-License-Identifier: Apache-2.0
 */

import { MongoClient } from 'mongodb'
import { createIntensityStore } from '../stores/createIntensityStore'
import { InMemoryIntensityStore } from '../stores/InMemoryIntensityStore'
import { LocalIntensityStore } from '../stores/LocalIntensityStore'
import { MongoDbIntensityStore } from '../stores/MongoDbIntensityStore'

jest.mock('mongodb', () => ({
  MongoClient: jest.fn(),
  ServerApiVersion: { v1: '1' },
}))

describe('createIntensityStore', () => {
  const logger = { warn: jest.fn() }
  afterEach(() => jest.clearAllMocks())

  it('creates the LOCAL store at the configured path', () => {
    const store = createIntensityStore(
      { STORE: 'LOCAL', STORE_PATH: '/tmp/ccf-intensity' },
      {},
      logger,
    )
    expect(store).toBeInstanceOf(LocalIntensityStore)
    expect(store).toEqual(new LocalIntensityStore('/tmp/ccf-intensity'))
  })

  it('defaults to the LOCAL store at .ccf/grid-intensity', () => {
    expect(createIntensityStore(undefined, undefined, logger)).toEqual(
      new LocalIntensityStore('.ccf/grid-intensity'),
    )
  })

  it('creates the MONGODB store from MONGODB_URI and MONGODB_CREDENTIALS', () => {
    const store = createIntensityStore(
      { STORE: 'MONGODB' },
      { URI: 'mongodb://db:27017', CREDENTIALS: '/run/secrets/mongo.pem' },
      logger,
    )
    expect(store).toBeInstanceOf(MongoDbIntensityStore)
    expect(MongoClient).toHaveBeenCalledWith('mongodb://db:27017', {
      sslKey: '/run/secrets/mongo.pem',
      sslCert: '/run/secrets/mongo.pem',
      serverApi: '1',
    })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('falls back to memory, warning, when MONGODB has no URI', () => {
    const store = createIntensityStore(
      { STORE: 'MONGODB' },
      { URI: '' },
      logger,
    )
    expect(store).toBeInstanceOf(InMemoryIntensityStore)
    expect(logger.warn.mock.calls[0][0]).toContain('MONGODB_URI')
  })

  it('falls back to memory, warning, for an unknown store mode', () => {
    const store = createIntensityStore({ STORE: 'REDIS' }, {}, logger)
    expect(store).toBeInstanceOf(InMemoryIntensityStore)
    expect(logger.warn.mock.calls[0][0]).toContain("'REDIS'")
  })
})
