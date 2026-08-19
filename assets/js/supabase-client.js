import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const SUPABASE_URL = 'https://rwwwewiphcvukcpokpmu.supabase.co'
const SUPABASE_KEY = 'sb_publishable_qhA0__EUD2M-IUmuy37iEQ_waYsMZyD'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// UI consumers on a page share one local session read. This is deliberately a
// presentation convenience only; protected operations remain authenticated and
// authorized by Supabase or the server.
let sessionLookup = null

export const getCurrentSessionOnce = () => {
  if (!sessionLookup) {
    sessionLookup = supabase.auth.getSession()
    sessionLookup.catch(() => { sessionLookup = null })
  }
  return sessionLookup
}

supabase.auth.onAuthStateChange(() => { sessionLookup = null })
