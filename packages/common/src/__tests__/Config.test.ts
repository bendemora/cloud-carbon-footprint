/*
 * © 2022 Thoughtworks, Inc.
 */

import fs from 'fs'
import getConfig, { CCFConfig } from '../Config'
import configLoader, { setConfig } from '../ConfigLoader'
import { AccountDetails } from '../Types'

describe('Config', () => {
  const withEnvironment = (name: string, value: string, test: () => void) => {
    const existingValue = process.env[name]
    process.env[name] = value

    try {
      test()
    } finally {
      if (!existingValue) {
        delete process.env[name]
      } else {
        process.env[name] = existingValue
      }
    }
  }

  it('get environment variable from `process.env`', () => {
    const fsSpy = jest.spyOn(fs, 'readFileSync')
    const billingId = 'ezb1'

    withEnvironment('AWS_BILLING_ACCOUNT_ID', billingId, () => {
      const config = getConfig()
      expect(fsSpy).toBeCalled()
      expect(config.AWS.BILLING_ACCOUNT_ID).toBe(billingId)
    })

    jest.clearAllMocks()
  })

  describe('AWS', () => {
    it('loads list of AWS accounts with names and ids from environment variables', () => {
      const id = 'b47m4n'
      const name = 'Bruce Wayne'

      withEnvironment(
        'AWS_ACCOUNTS',
        `[{"id": "${id}", "name": "${name}"}]`,
        () => {
          const config = getConfig()
          expect(config.AWS.accounts[0].id).toBe(id)
          expect(config.AWS.accounts[0].name).toBe(name)
        },
      )
    })

    it('loads list of AWS accounts with only ids from the environment variables', () => {
      const id = 'b47m4n'
      const idTwo = 'cl4rk'

      withEnvironment('AWS_ACCOUNTS', `["${id}", "${idTwo}"]`, () => {
        const config = getConfig()
        expect(config.AWS.accounts[0]).toBe(id)
        expect(config.AWS.accounts[1]).toBe(idTwo)
      })
    })

    it('loads AWS resource tags from environment variables', () => {
      withEnvironment('AWS_RESOURCE_TAG_NAMES', `["Environment"]`, () => {
        const config = getConfig()
        expect(config.AWS.RESOURCE_TAG_NAMES).toEqual(['Environment'])
      })
    })
  })

  describe('Google Cloud', () => {
    it('loads list of GCP Projects with names and ids from environment variables', () => {
      const id = 'id'
      const secondId = 'id2'
      const name = 'project'

      withEnvironment(
        'GCP_PROJECTS',
        `[{"id": "${id}", "name": "${name}"}, {"id": "${secondId}"}]`,
        () => {
          const configuredProjects = getConfig().GCP
            .projects as AccountDetails[]
          expect(configuredProjects[0].id).toBe(id)
          expect(configuredProjects[0].name).toBe(name)
          expect(configuredProjects[1].id).toBe(secondId)
          expect(configuredProjects[1].name).toBeUndefined()
        },
      )
    })

    it('loads list of GCP Projects with only ids from the environment variables', () => {
      const id = 'id'
      const secondId = 'id2'

      withEnvironment('GCP_PROJECTS', `["${id}", "${secondId}"]`, () => {
        const configuredProjects = getConfig().GCP.projects as string[]
        expect(configuredProjects[0]).toBe(id)
        expect(configuredProjects[1]).toBe(secondId)
      })
    })

    it('loads Google Cloud tags from environment variables', () => {
      withEnvironment('GCP_RESOURCE_TAG_NAMES', `["Environment"]`, () => {
        const config = getConfig()
        expect(config.GCP.RESOURCE_TAG_NAMES).toEqual(['Environment'])
      })
    })
  })

  describe('Azure', () => {
    it('loads Azure tags from environment variables', () => {
      withEnvironment('AZURE_RESOURCE_TAG_NAMES', `["Environment"]`, () => {
        const config = getConfig()
        expect(config.AZURE.RESOURCE_TAG_NAMES).toEqual(['Environment'])
      })
    })

    it('loads list of Azure subscriptions from environment variables', () => {
      withEnvironment('AZURE_SUBSCRIPTIONS', `["sub-1", "sub-2"]`, () => {
        const config = getConfig()
        expect(config.AZURE.SUBSCRIPTIONS).toEqual(['sub-1', 'sub-2'])
      })
    })
  })

  describe('GRID_INTENSITY', () => {
    it('defaults to the static source, no acknowledgements, a 24 hour TTL and the LOCAL store', () => {
      const config = getConfig()
      expect(config.GRID_INTENSITY).toEqual({
        SOURCES: ['static'],
        LICENCE_ACKNOWLEDGEMENTS: [],
        CAPABILITY_TTL_HOURS: 24,
        STORE: 'LOCAL',
        STORE_PATH: '.ccf/grid-intensity',
      })
    })

    it('reads comma-separated source and acknowledgement lists, trimming blanks', () => {
      withEnvironment('GRID_INTENSITY_SOURCES', ' neso, ,static ', () => {
        withEnvironment(
          'GRID_INTENSITY_LICENCE_ACKNOWLEDGEMENTS',
          'neso',
          () => {
            const config = getConfig()
            expect(config.GRID_INTENSITY.SOURCES).toEqual(['neso', 'static'])
            expect(config.GRID_INTENSITY.LICENCE_ACKNOWLEDGEMENTS).toEqual([
              'neso',
            ])
          },
        )
      })
    })

    it('reads the store mode, in any case, and the store path', () => {
      withEnvironment('GRID_INTENSITY_STORE', 'mongodb', () => {
        withEnvironment('GRID_INTENSITY_STORE_PATH', '/var/lib/ccf', () => {
          const config = getConfig()
          expect(config.GRID_INTENSITY.STORE).toBe('MONGODB')
          expect(config.GRID_INTENSITY.STORE_PATH).toBe('/var/lib/ccf')
        })
      })
    })

    it.each([
      ['6', 6],
      ['0.5', 0.5],
      ['0', 24],
      ['-3', 24],
      ['soon', 24],
    ])(
      'reads GRID_INTENSITY_CAPABILITY_TTL_HOURS=%s as %s',
      (value, expected) => {
        withEnvironment('GRID_INTENSITY_CAPABILITY_TTL_HOURS', value, () => {
          expect(getConfig().GRID_INTENSITY.CAPABILITY_TTL_HOURS).toBe(expected)
        })
      },
    )
  })

  describe('removed settings', () => {
    it('has no warning when none of them is set', () => {
      withEnvironment('ELECTRICITY_MAPS_TOKEN', '', () => {
        expect(getConfig().REMOVED_SETTING_WARNINGS).toEqual([])
      })
    })

    it('warns that ELECTRICITY_MAPS_TOKEN is no longer read and names what is used instead, without the value', () => {
      withEnvironment('ELECTRICITY_MAPS_TOKEN', 'a-token', () => {
        const warnings = getConfig().REMOVED_SETTING_WARNINGS
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain(
          'ELECTRICITY_MAPS_TOKEN is set but is no longer read.',
        )
        expect(warnings[0]).toContain('GRID_INTENSITY_SOURCES')
        expect(warnings[0]).not.toContain('a-token')
      })
    })

    describe('in a configuration object given to setConfig', () => {
      // A deployment that builds its own configuration, in JavaScript or
      // loosely typed, can still carry the property the type no longer has.
      const withToken = (config: CCFConfig, token: unknown): CCFConfig =>
        ({ ...config, ELECTRICITY_MAPS_TOKEN: token }) as CCFConfig
      const base = (): CCFConfig => ({
        ...getConfig(),
        REMOVED_SETTING_WARNINGS: [],
      })

      afterEach(() => {
        setConfig()
      })

      it('adds the warning, without the value, and leaves the given object alone', () => {
        const given = withToken(base(), 'a-token')
        const stored = setConfig(given)
        expect(stored).not.toBe(given)
        expect(given.REMOVED_SETTING_WARNINGS).toEqual([])
        expect(configLoader()).toBe(stored)
        expect(stored.REMOVED_SETTING_WARNINGS).toHaveLength(1)
        expect(stored.REMOVED_SETTING_WARNINGS[0]).toContain(
          'ELECTRICITY_MAPS_TOKEN is set but is no longer read.',
        )
        expect(stored.REMOVED_SETTING_WARNINGS[0]).not.toContain('a-token')
      })

      it('keeps the warnings the object already has, each once', () => {
        withEnvironment(
          'ELECTRICITY_MAPS_TOKEN',
          'from-the-environment',
          () => {
            const fromEnvironment = getConfig()
            const stored = setConfig(
              withToken(
                {
                  ...fromEnvironment,
                  REMOVED_SETTING_WARNINGS: [
                    'OLD_SETTING is set but is no longer read.',
                    ...fromEnvironment.REMOVED_SETTING_WARNINGS,
                  ],
                },
                'a-token',
              ),
            )
            expect(stored.REMOVED_SETTING_WARNINGS).toHaveLength(2)
            expect(stored.REMOVED_SETTING_WARNINGS[0]).toBe(
              'OLD_SETTING is set but is no longer read.',
            )
          },
        )
      })

      it.each([
        ['has no such property', undefined],
        ['has the property with no value', ''],
      ])('stores the object itself when it %s', (_case, token) => {
        const given = token === undefined ? base() : withToken(base(), token)
        expect(setConfig(given)).toBe(given)
        expect(configLoader().REMOVED_SETTING_WARNINGS).toEqual([])
      })

      it('gives the warning for a configuration that has no list of warnings', () => {
        const { REMOVED_SETTING_WARNINGS: _none, ...withoutList } = base()
        const stored = setConfig(withToken(withoutList as CCFConfig, 'a-token'))
        expect(stored.REMOVED_SETTING_WARNINGS).toHaveLength(1)
      })
    })
  })

  describe('INCLUDE_ESTIMATES', () => {
    const cloudProviders = ['AWS', 'GCP', 'AZURE', 'ALI'] as const
    cloudProviders.forEach((provider) => {
      it.each([
        [true, 'true'],
        [false, 'false'],
        [true, ''],
      ])(
        `sets ${provider}_INCLUDE_ESTIMATES to %s for INCLUDE_ESTIMATES=%s`,
        (expected: boolean, value: string) => {
          withEnvironment(`${provider}_INCLUDE_ESTIMATES`, value, () => {
            const config = getConfig()
            expect(config[provider].INCLUDE_ESTIMATES).toBe(expected)
          })
        },
      )
    })
  })
})
