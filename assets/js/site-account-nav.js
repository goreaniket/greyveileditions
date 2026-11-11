import { supabase } from './supabase-client.js'

const accountLink = document.querySelector('.nav-account, .gv-global-account')
if (accountLink) {
  const setIdentity = (label, href, role = '') => {
    const textNode = [...accountLink.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)
    if (textNode) textNode.nodeValue = ` ${label} `
    else accountLink.prepend(document.createTextNode(`${label} `))
    accountLink.href = href
    accountLink.title = role ? `${label} · ${role}` : label
    accountLink.setAttribute('aria-label', role ? `${label}, ${role}` : label)
  }

  const syncIdentity = async (session = null) => {
    const user = session?.user || (await supabase.auth.getUser()).data?.user || null
    if (!user) {
      setIdentity('Sign in / My Space', '/auth/login/?next=%2Faccount%2F')
      return
    }

    let profile = null
    const { data } = await supabase
      .from('profiles')
      .select('display_name, role')
      .eq('id', user.id)
      .maybeSingle()
    profile = data || null

    const name = profile?.display_name
      || user.user_metadata?.display_name
      || user.email?.split('@')[0]
      || 'My Space'
    const isAdmin = ['admin', 'super_admin'].includes(profile?.role)
    setIdentity(name, isAdmin ? '/admin/' : '/account/', isAdmin ? 'Admin' : 'Member')
  }

  syncIdentity().catch((error) => {
    console.error('Greyveil account navigation could not load:', error)
    setIdentity('My Space', '/account/')
  })

  supabase.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => {
      syncIdentity(session).catch((error) => {
        console.error('Greyveil account identity refresh failed:', error)
      })
    }, 0)
  })
}
