import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createExclusiveStateController,
  initPasswordVisibilityToggles,
  RESET_PASSWORD_STATES,
  selectPasswordRecoverySession,
} from '../assets/js/auth-ui.js'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

const visibleStates = (nodes) => Object.entries(nodes)
  .filter(([, node]) => !node.hidden)
  .map(([state]) => state)

test('reset-password scenarios always render exactly one state panel', () => {
  const scenarios = new Map([
    ['valid recovery link', ['checking', 'valid']],
    ['invalid recovery link', ['checking', 'invalid']],
    ['expired recovery link', ['checking', 'invalid']],
    ['successful password update', ['checking', 'valid', 'success']],
    ['direct reset page without a recovery token', ['checking', 'invalid']],
    ['browser refresh during recovery', ['checking', 'valid']],
  ])

  for (const [scenario, transitions] of scenarios) {
    const nodes = Object.fromEntries(RESET_PASSWORD_STATES.map((state) => [state, { hidden: false }]))
    const controller = createExclusiveStateController(nodes)

    for (const state of transitions) {
      controller.show(state)
      assert.deepEqual(visibleStates(nodes), [state], `${scenario}: ${state}`)
      assert.equal(controller.state, state, `${scenario}: controller state`)
    }
  }
})

test('reset-password markup and CSS preserve the native hidden contract', async () => {
  const [html, css, auth] = await Promise.all([
    source('../reset-password/index.html'),
    source('../assets/css/style.css'),
    source('../assets/js/auth.js'),
  ])

  const panels = [...html.matchAll(/<(?:article|form)\b[^>]*data-reset-state="([^"]+)"[^>]*>/g)]
  assert.deepEqual(panels.map((match) => match[1]), RESET_PASSWORD_STATES)

  for (const [index, panel] of panels.entries()) {
    assert.equal(/\shidden(?:\s|>)/.test(panel[0]), index !== 0, `${panel[1]} initial visibility`)
  }

  assert.match(css, /\[data-reset-state\]\[hidden\]\s*{\s*display:\s*none\s*!important;/)
  assert.match(auth, /createExclusiveStateController\(\{[\s\S]*checking:\s*loading,[\s\S]*valid:\s*form,[\s\S]*invalid,[\s\S]*success/)
  assert.doesNotMatch(auth, /Promise\.race/)
  assert.match(auth, /selectPasswordRecoverySession\(\{/)
  assert.match(auth, /isRememberedPasswordRecoverySession\(currentSession\)/)
})

test('recovery-session selection handles implicit, PKCE, invalid, expired, direct, and refresh cases', () => {
  const implicitSession = { access_token: 'implicit-token', user: { id: 'reader-1' } }
  const pkceSession = { access_token: 'pkce-token', user: { id: 'reader-1' } }
  const ordinarySession = { access_token: 'ordinary-token', user: { id: 'reader-1' } }

  assert.equal(selectPasswordRecoverySession({
    urlState: { hasImplicitRecovery: true, implicitAccessToken: 'implicit-token', isRecovery: true },
    currentSession: implicitSession,
  }), implicitSession)

  assert.equal(selectPasswordRecoverySession({
    urlState: { hasPkceRecovery: true, isRecovery: true },
    resolvedSession: pkceSession,
  }), pkceSession)

  assert.equal(selectPasswordRecoverySession({
    urlState: { hasError: true, isRecovery: true },
    resolvedSession: pkceSession,
  }), null)

  assert.equal(selectPasswordRecoverySession({
    urlState: { hasImplicitRecovery: true, implicitAccessToken: 'expired-token', isRecovery: true },
    currentSession: ordinarySession,
  }), null)

  assert.equal(selectPasswordRecoverySession({
    urlState: { isRecovery: false },
    currentSession: ordinarySession,
    rememberedSession: false,
  }), null)

  assert.equal(selectPasswordRecoverySession({
    urlState: { isRecovery: false },
    currentSession: ordinarySession,
    rememberedSession: true,
  }), ordinarySession)
})

test('password visibility toggle switches type and accessible state without replacing the input', () => {
  const input = { type: 'password' }
  const attributes = new Map([['aria-controls', 'test-password']])
  let clickHandler = null
  const button = {
    dataset: {},
    textContent: 'Show',
    getAttribute: (name) => attributes.get(name) || null,
    setAttribute: (name, value) => attributes.set(name, value),
    addEventListener: (event, handler) => {
      if (event === 'click') clickHandler = handler
    },
  }
  const root = {
    querySelectorAll: () => [button],
    getElementById: (id) => id === 'test-password' ? input : null,
  }

  assert.equal(initPasswordVisibilityToggles(root), 1)
  assert.equal(button.textContent, 'Show')
  assert.equal(attributes.get('aria-label'), 'Show password')
  assert.equal(attributes.get('aria-pressed'), 'false')

  clickHandler()
  assert.equal(input.type, 'text')
  assert.equal(button.textContent, 'Hide')
  assert.equal(attributes.get('aria-label'), 'Hide password')
  assert.equal(attributes.get('aria-pressed'), 'true')

  clickHandler()
  assert.equal(input.type, 'password')
  assert.equal(button.textContent, 'Show')
  assert.equal(attributes.get('aria-pressed'), 'false')
})

test('every requested auth password field has a non-submitting accessible toggle', async () => {
  const pages = new Map([
    ['../auth/login/index.html', 1],
    ['../auth/signup/index.html', 2],
    ['../reset-password/index.html', 2],
  ])

  for (const [path, expectedCount] of pages) {
    const html = await source(path)
    const buttons = [...html.matchAll(/<button\b[^>]*data-password-toggle[^>]*>/g)].map((match) => match[0])
    assert.equal(buttons.length, expectedCount, path)

    for (const button of buttons) {
      assert.match(button, /\stype="button"/)
      assert.match(button, /\saria-label="Show password"/)
      assert.match(button, /\saria-pressed="false"/)
      const inputId = button.match(/\saria-controls="([^"]+)"/)?.[1]
      assert.ok(inputId, `${path}: toggle controls an input`)
      assert.match(html, new RegExp(`<input\\b[^>]*id="${inputId}"[^>]*type="password"[^>]*autocomplete="(?:current|new)-password"`))
    }
  }
})
