import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const SUPABASE_URL = 'https://rwwwewiphcvukcpokpmu.supabase.co'
const SUPABASE_KEY = 'sb_publishable_qhA0__EUD2M-IUmuy37iEQ_waYsMZyD'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
