import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

// Greyveil production project. Keep this publishable key in the browser;
// never place a service-role or secret key in client-side code.
const SUPABASE_URL = 'https://fanixwnyglkvkgsxxrtn.supabase.co'
const SUPABASE_KEY = 'sb_publishable__CASr_IBECt7_fJDhdYYOQ_W_zXRIFl'

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
