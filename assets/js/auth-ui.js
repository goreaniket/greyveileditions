export const RESET_PASSWORD_STATES = Object.freeze(['checking', 'valid', 'invalid', 'success'])

export const createExclusiveStateController = (nodes, initialState = 'checking') => {
  const entries = RESET_PASSWORD_STATES.map((state) => [state, nodes?.[state]])
  if (entries.some(([, node]) => !node)) {
    throw new TypeError('Every reset-password state requires a panel.')
  }

  let currentState = ''
  const show = (nextState) => {
    if (!RESET_PASSWORD_STATES.includes(nextState)) {
      throw new TypeError(`Unknown reset-password state: ${nextState}`)
    }

    entries.forEach(([state, node]) => {
      node.hidden = state !== nextState
    })
    currentState = nextState
    return currentState
  }

  show(initialState)
  return {
    get state() {
      return currentState
    },
    show,
  }
}

export const selectPasswordRecoverySession = ({
  urlState,
  resolvedSession = null,
  currentSession = null,
  rememberedSession = false,
}) => {
  if (urlState?.hasError) return null
  if (resolvedSession) return resolvedSession
  if (urlState?.hasImplicitRecovery
    && currentSession?.access_token === urlState.implicitAccessToken) {
    return currentSession
  }
  if (!urlState?.isRecovery && rememberedSession) return currentSession
  return null
}

export const initPasswordVisibilityToggles = (root = document) => {
  let initialized = 0

  root.querySelectorAll('[data-password-toggle]').forEach((button) => {
    if (button.dataset.passwordToggleReady === 'true') return

    const inputId = button.getAttribute('aria-controls') || ''
    const input = root.getElementById?.(inputId)
    if (!input) return

    const render = () => {
      const visible = input.type === 'text'
      button.textContent = visible ? 'Hide' : 'Show'
      button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password')
      button.setAttribute('aria-pressed', String(visible))
    }

    button.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password'
      render()
    })

    button.dataset.passwordToggleReady = 'true'
    render()
    initialized += 1
  })

  return initialized
}
