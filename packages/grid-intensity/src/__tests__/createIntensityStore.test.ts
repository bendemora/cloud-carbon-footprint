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

  it.each([
    [
      'a malformed MONGODB_URI',
      'MongoParseError: Invalid scheme, expected connection string to start with "mongodb://" or "mongodb+srv://"',
    ],
    [
      'a missing MONGODB_CREDENTIALS file',
      "ENOENT: no such file or directory, open '/run/secrets/mongo.pem'",
    ],
  ])('falls back to memory, warning, for %s', (_case, message) => {
    // The 4.x driver parses the URI and reads the credentials file in the
    // MongoClient constructor, so these throw before any connection.
    ;(MongoClient as unknown as jest.Mock).mockImplementationOnce(() => {
      throw new Error(message)
    })
    const store = createIntensityStore(
      { STORE: 'MONGODB' },
      { URI: 'localhost:27017', CREDENTIALS: '/run/secrets/mongo.pem' },
      logger,
    )
    expect(store).toBeInstanceOf(InMemoryIntensityStore)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toContain(message)
    expect(logger.warn.mock.calls[0][0]).toContain('MONGODB_URI')
  })

  it('leaves credentials in MONGODB_URI out of the warning', () => {
    // mongodb-connection-string-url quotes the whole URI in some messages.
    ;(MongoClient as unknown as jest.Mock).mockImplementationOnce(() => {
      throw new Error(
        'Invalid connection string "mongodb+srv://ccf-user:s3cret-pass@/ccf"',
      )
    })
    createIntensityStore(
      { STORE: 'MONGODB' },
      { URI: 'mongodb+srv://ccf-user:s3cret-pass@/ccf' },
      logger,
    )
    const warning = logger.warn.mock.calls[0][0]
    expect(warning).not.toContain('s3cret-pass')
    expect(warning).not.toContain('ccf-user')
    expect(warning).toContain('mongodb+srv://<credentials>@/ccf')
  })

  it.each([
    [
      'a password with a double quote',
      'mongodb://ccf-user:s3cret"pass@/ccf',
      'Protocol and host list are required in "mongodb://ccf-user:s3cret"pass@/ccf"',
      ['s3cret"pass', 'ccf-user'],
    ],
    [
      'a user name with a space',
      'mongodb://ccf user:s3cret-pass@/ccf',
      'Protocol and host list are required in "mongodb://ccf user:s3cret-pass@/ccf"',
      ['s3cret-pass', 'ccf user'],
    ],
    [
      'a password with a malformed percent-encoding',
      'mongodb://ccf-user:pa%ZZss@/ccf',
      'Protocol and host list are required in "mongodb://ccf-user:pa%ZZss@/ccf"',
      ['pa%ZZss', 'ccf-user'],
    ],
    [
      'a message naming the user without the URI',
      'mongodb://ccf[user:s3cret-pass@db/ccf',
      'Username contains unescaped characters ccf[user',
      ['ccf[user'],
    ],
  ])('leaves out credentials for %s', (_case, uri, driverMessage, secrets) => {
    ;(MongoClient as unknown as jest.Mock).mockImplementationOnce(() => {
      throw Object.assign(new Error(driverMessage), {
        name: 'MongoParseError',
      })
    })
    createIntensityStore({ STORE: 'MONGODB' }, { URI: uri }, logger)
    const warning = logger.warn.mock.calls[0][0]
    for (const secret of secrets) expect(warning).not.toContain(secret)
    expect(warning).toContain('MONGODB_URI')
  })

  it('falls back to memory, warning, for an unknown store mode', () => {
    const store = createIntensityStore({ STORE: 'REDIS' }, {}, logger)
    expect(store).toBeInstanceOf(InMemoryIntensityStore)
    expect(logger.warn.mock.calls[0][0]).toContain("'REDIS'")
  })
})
