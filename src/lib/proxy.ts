/**
 * Optional proxy settings.
 *
 * Empty by default, and that default matters: with no proxy configured the app
 * talks straight to Google with the user's own key, and no schematic ever
 * touches a server we run. Filling this in trades that property for a link that
 * works without each visitor supplying a key. See worker/README.md.
 */

const KEY_URL = 'schem.proxy.url'
const KEY_TOKEN = 'schem.proxy.token'

export interface ProxyConfig {
  /** Worker base URL, no trailing slash. Empty means "go direct to Google". */
  url: string
  /** Shared passphrase the Worker checks. Useless without the URL. */
  token: string
}

export const proxyStore = {
  get(): ProxyConfig {
    return {
      // Trailing slashes would produce "//models" once we append a path, which
      // Google 404s in a way that reads like the model is missing.
      url: (localStorage.getItem(KEY_URL) ?? '').trim().replace(/\/+$/, ''),
      token: (localStorage.getItem(KEY_TOKEN) ?? '').trim(),
    }
  },

  set(config: ProxyConfig) {
    const url = config.url.trim().replace(/\/+$/, '')
    if (url) localStorage.setItem(KEY_URL, url)
    else localStorage.removeItem(KEY_URL)

    const token = config.token.trim()
    if (token) localStorage.setItem(KEY_TOKEN, token)
    else localStorage.removeItem(KEY_TOKEN)
  },
}

/** True when a proxy is supplying the key, so the app needn't hold one. */
export function usingProxy(): boolean {
  return Boolean(proxyStore.get().url)
}
