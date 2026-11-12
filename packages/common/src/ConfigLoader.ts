/*
 * © 2021 Thoughtworks, Inc.
 */

import getConfig, { CCFConfig, withRemovedSettingWarnings } from './Config'

let _config: CCFConfig = getConfig()

export const setConfig = (ccfConfig: CCFConfig = getConfig()) => {
  return (_config = withRemovedSettingWarnings(ccfConfig))
}

export default function config(): CCFConfig {
  return _config
}
