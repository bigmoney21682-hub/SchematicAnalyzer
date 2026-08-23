import { useEffect, useState } from 'react'
import type { Quota as QuotaState } from '../lib/proxy'
import { quotaStore } from '../lib/proxy'

/**
 * The shared service's daily allowance, on the homescreen.
 *
 * Only meaningful for someone running on the shared pool — a viewer with their
 * own key is spending their own Google quota, which this app has no way to
 * count and no business guessing at. So: nothing renders unless the proxy
 * reports a cap.
 *
 * The number comes from the Worker rather than a local tally, because a local
 * one would be wrong in every case that matters — a second device, a cleared
 * browser, a reload mid-session.
 */
export function Quota({ hasOwnKey }: { hasOwnKey: boolean }) {
  const [quota, setQuota] = useState<QuotaState | null>(quotaStore.get())

  useEffect(() => {
    const stop = quotaStore.subscribe(setQuota)
    // Ask once on mount; every proxied response refreshes it after that.
    void quotaStore.refresh()
    return stop
  }, [])

  if (!quota?.enabled) return null

  const { used, limit, remaining } = quota
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const spent = remaining === 0

  return (
    <div className={`quota${spent ? ' quota--spent' : ''}`}>
      <div className="quota__line">
        <span className="quota__label">
          {hasOwnKey ? 'Shared service (backup)' : 'Free daily analyses'}
        </span>
        <span className="quota__count">
          <strong>{remaining}</strong> of {limit} left
        </span>
      </div>

      <div
        className="quota__bar"
        role="progressbar"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-label={`${used} of ${limit} shared analyses used today`}
      >
        <div className="quota__fill" style={{ width: `${pct}%` }} />
      </div>

      <p className="quota__note">
        {spent ? (
          <>
            Today's shared allowance is gone. Add your own key in Settings to keep going — it is
            free from{' '}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              aistudio.google.com/apikey
            </a>
            , and it also keeps your sheets off our server.
          </>
        ) : hasOwnKey ? (
          'Your own key runs first. This is what is left of the shared pool if yours runs out.'
        ) : (
          'Resets at midnight UTC. Add your own key in Settings for no limit.'
        )}
      </p>
    </div>
  )
}
