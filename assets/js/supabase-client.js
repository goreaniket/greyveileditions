import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

// Greyveil Editions production project. Browser-safe publishable key only.
const SUPABASE_URL = 'https://fanixwnyglkvkgsxxrtn.supabase.co'
const SUPABASE_KEY = 'sb_publishable__CASr_IBECt7_fJDhdYYOQ_W_zXRIFl'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Share one session read across UI consumers; authorization remains server/database-side.
let sessionLookup = null

export const getCurrentSessionOnce = () => {
  if (!sessionLookup) {
    sessionLookup = supabase.auth.getSession()
    sessionLookup.catch(() => { sessionLookup = null })
  }
  return sessionLookup
}

supabase.auth.onAuthStateChange(() => { sessionLookup = null })
