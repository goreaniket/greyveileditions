import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createFeedbackEmailLink,
  feedbackEmailMailto,
  validFeedbackEmail,
} from '../assets/js/admin-feedback-email.js'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

const fakeDocument = {
  createElement(tagName) {
    return {
      tagName,
      className: '',
      textContent: '',
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value
      },
    }
  },
}

test('valid feedback email renders an accessible native mailto link for the correct recipient', () => {
  const link = createFeedbackEmailLink('reviewer+books@example.com', fakeDocument)

  assert.equal(link.tagName, 'a')
  assert.equal(link.textContent, 'reviewer+books@example.com')
  assert.equal(link.attributes.href, 'mailto:reviewer%2Bbooks@example.com')
  assert.equal(link.attributes.target, undefined)
})

test('feedback mailto contains only the recipient and cannot automatically send email', () => {
  const href = feedbackEmailMailto('reader@example.com')

  assert.equal(href, 'mailto:reader@example.com')
  assert.equal(new URL(href).search, '')
  assert.doesNotMatch(href, /(?:subject|body|bcc|cc)=/i)
})

test('invalid or missing feedback email never creates a mailto link', () => {
  for (const value of [
    null,
    undefined,
    '',
    'not-an-email',
    'https://example.com',
    'safe@example.com\r\nBcc:other@example.com',
    'first@example.com@evil.test',
    '.reader@example.com',
    'reader@-example.com',
  ]) {
    assert.equal(validFeedbackEmail(value), null)
    assert.equal(feedbackEmailMailto(value), null)
    assert.equal(createFeedbackEmailLink(value, fakeDocument), null)
  }
})

test('Admin Feedbacks reuses the existing detail drawer and preserves its plain-text fallback', async () => {
  const [admin, css] = await Promise.all([
    source('../assets/js/admin.js'),
    source('../assets/css/admin.css'),
  ])

  assert.match(admin, /const feedbackEmailDetailField = \(value\) =>/)
  assert.match(admin, /emailLink \|\| createNode\('strong', '', getText\(value\)\)/)
  assert.match(admin, /feedbackEmailDetailField\(feedback\.Email\)/)
  assert.match(admin, /feedbackDetailField\('Status', currentStatus\)/)
  assert.match(css, /\.feedback-detail-email:hover,[\s\S]*?\.feedback-detail-email:focus-visible/)
})
