import { supabase } from './supabase-client.js'
import { getCurrentUser, signOut } from './auth.js'

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector))
const ADMIN_ROLES = new Set(['admin', 'super_admin'])
const state = { invoices: [], user: null }

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]))

const money = (paise) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2,
}).format((Number(paise) || 0) / 100)

const rupeesToPaise = (value) => {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Enter valid non-negative amounts.')
  return Math.round((amount + Number.EPSILON) * 100)
}

const setStatus = (message, isError = false) => {
  const node = $('[data-billing-form-status]')
  if (node) {
    node.textContent = message
    node.dataset.status = isError ? 'error' : 'success'
  }
}

const showLocked = (message) => {
  $('[data-billing-loading]').hidden = true
  $('[data-billing-locked]').hidden = false
  $('[data-billing-locked-message]').textContent = message
}

const guard = async () => {
  const user = await getCurrentUser()
  if (!user) {
    window.location.replace('/auth/login/')
    return false
  }
  const { data: profile, error } = await supabase
    .from('profiles').select('id, role').eq('id', user.id).maybeSingle()
  if (error) {
    showLocked('Could not verify your admin role. Please try again.')
    return false
  }
  if (!ADMIN_ROLES.has(profile?.role)) {
    window.location.replace('/account/')
    return false
  }
  state.user = user
  $('[data-billing-loading]').hidden = true
  $('[data-billing-app]').hidden = false
  return true
}

const itemRows = () => $$('[data-billing-item]')
const updateTotals = () => {
  try {
    const subtotal = itemRows().reduce((sum, row) => {
      const qty = Number($('[name="item_qty"]', row).value)
      const price = rupeesToPaise($('[name="item_price"]', row).value)
      if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new Error('Quantity must be between 1 and 999.')
      return sum + qty * price
    }, 0)
    const shipping = rupeesToPaise($('[name="shipping"]').value)
    const discount = rupeesToPaise($('[name="discount"]').value)
    const total = subtotal + shipping - discount
    if (total < 0) throw new Error('Discount cannot exceed subtotal plus shipping.')
    $('[data-billing-total]').textContent = money(total)
    return { subtotal, shipping, discount, total }
  } catch (error) {
    $('[data-billing-total]').textContent = 'Check amounts'
    return null
  }
}

const updateRemoveButtons = () => {
  itemRows().forEach((row) => {
    const button = $('[data-billing-remove]', row)
    if (button) button.disabled = itemRows().length === 1
  })
}

const addItemRow = () => {
  const row = document.createElement('div')
  row.className = 'billing-item-row'
  row.dataset.billingItem = ''
  row.innerHTML = `
    <label><span>Book / description *</span><input name="item_name" required maxlength="240" placeholder="Book title"></label>
    <label><span>Qty</span><input name="item_qty" type="number" min="1" max="999" value="1" required></label>
    <label><span>Unit price (₹)</span><input name="item_price" type="number" min="0" step="0.01" value="0.00" required></label>
    <button class="billing-remove-item" type="button" data-billing-remove aria-label="Remove item">×</button>`
  $('[data-billing-items]').append(row)
  updateRemoveButtons()
  updateTotals()
}

const buildInvoiceDocument = (invoice) => {
  const rows = (invoice.items || []).map((item, index) => `
    <tr><td>${index + 1}</td><td>${escapeHtml(item.name)}</td><td>${item.quantity}</td><td>${money(item.unit_price_paise)}</td><td>${money(item.line_total_paise)}</td></tr>`).join('')
  const invoiceDate = new Date(invoice.invoice_date + 'T00:00:00')
  const dateText = Number.isNaN(invoiceDate.getTime()) ? invoice.invoice_date : new Intl.DateTimeFormat('en-IN', { dateStyle: 'long' }).format(invoiceDate)
  const customerAddress = escapeHtml(invoice.customer_address).replace(/\n/g, '<br>')
  const paymentText = invoice.payment_status === 'paid' ? 'Paid' : invoice.payment_status === 'pending' ? 'Payment pending' : invoice.payment_status === 'partial' ? 'Partially paid' : 'Refunded'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(invoice.invoice_number)} | Greyveil Editions</title><style>
  *{box-sizing:border-box}body{margin:0;background:#efeee9;color:#202832;font:14px/1.55 Inter,Arial,sans-serif;padding:32px 16px}.paper{max-width:820px;margin:auto;background:#fff;padding:48px;border:1px solid #dedbd4}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.brand{font:600 32px Georgia,serif;letter-spacing:.02em}.sub,.muted{color:#6e747b}.kind{text-align:right;color:#8c7659;font-size:11px;letter-spacing:.16em;font-weight:700}.kind strong{display:block;color:#202832;font:500 26px Georgia,serif;letter-spacing:0;margin-top:8px}.rule{height:1px;background:#e5e2dc;margin:26px 0}.meta{display:flex;justify-content:space-between;gap:20px}.addresses{display:grid;grid-template-columns:1fr 1fr;gap:28px}.label{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8c7659;font-weight:700}.addresses p{margin:6px 0}.addresses strong{font-size:16px}.items{width:100%;border-collapse:collapse;margin-top:28px}.items th,.items td{text-align:left;padding:12px 8px;border-bottom:1px solid #e9e6e0}.items th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#6e747b}.items td:nth-child(n+3),.items th:nth-child(n+3){text-align:right}.totals{width:min(330px,100%);margin:22px 0 0 auto}.totals div{display:flex;justify-content:space-between;padding:7px 0}.grand{border-top:1px solid #d9d5cd;margin-top:8px;padding-top:14px!important;font-size:18px;font-weight:700}.payment{margin-top:20px;padding:13px 16px;background:#f5f4f0}.note{font-size:11px;color:#6e747b;margin-top:28px}.footer{margin-top:40px;padding-top:16px;border-top:1px solid #e5e2dc;color:#6e747b;font-size:12px}.actions{max-width:820px;margin:16px auto;text-align:right}.actions button{background:#26313d;color:#fff;border:0;padding:12px 20px;font:inherit;cursor:pointer}@media(max-width:600px){.paper{padding:24px 18px}.top,.meta{flex-direction:column}.kind{text-align:left}.addresses{grid-template-columns:1fr}.items th,.items td{padding:9px 4px;font-size:11px}}@media print{body{padding:0;background:#fff}.paper{border:0;padding:18px;max-width:none}.actions{display:none}}
  </style></head><body><main class="paper">
    <div class="top"><div><div class="brand">Greyveil Editions</div><div class="sub">Independent Publishing House</div><p class="muted">Vapi, Gujarat, India</p></div><div class="kind">NON-GST DOCUMENT<strong>Sales Invoice</strong></div></div>
    <div class="rule"></div><div class="meta"><div><span class="label">Invoice number</span><br><strong>${escapeHtml(invoice.invoice_number)}</strong></div><div><span class="label">Invoice date</span><br><strong>${escapeHtml(dateText)}</strong></div></div>
    <div class="rule"></div><div class="addresses"><div><span class="label">Seller</span><p><strong>Greyveil Editions</strong></p><p class="muted">Vapi, Gujarat, India</p></div><div><span class="label">Bill to</span><p><strong>${escapeHtml(invoice.customer_name)}</strong></p><p>${escapeHtml(invoice.customer_phone)}</p><p>${escapeHtml(invoice.customer_email)}</p><p>${customerAddress}</p></div></div>
    <table class="items"><thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totals"><div><span>Subtotal</span><strong>${money(invoice.subtotal_paise)}</strong></div><div><span>Shipping</span><strong>${money(invoice.shipping_paise)}</strong></div><div><span>Discount</span><strong>− ${money(invoice.discount_paise)}</strong></div><div class="grand"><span>Total</span><strong>${money(invoice.total_paise)}</strong></div></div>
    <div class="payment"><strong>Payment status: ${paymentText}</strong>${invoice.payment_method ? ' · ' + escapeHtml(invoice.payment_method) : ''}</div>
    <p class="note">This is a commercial sales invoice issued by a seller not registered under GST. No GST has been charged or collected on this document.</p>
    <div class="footer">Thank you for choosing Greyveil Editions.<br>Stories That Stay Within.</div>
  </main><div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div></body></html>`
}

const openCustomerCopy = (invoice) => {
  const popup = window.open('', '_blank')
  if (!popup) {
    window.alert('Allow pop-ups to open the customer invoice copy.')
    return
  }
  popup.document.open()
  popup.document.write(buildInvoiceDocument(invoice))
  popup.document.close()
}

const renderStats = () => {
  const issued = state.invoices.filter((invoice) => invoice.status === 'issued')
  $('[data-billing-count]').textContent = String(state.invoices.length)
  $('[data-billing-sales]').textContent = money(issued.reduce((sum, invoice) => sum + Number(invoice.total_paise || 0), 0))
  $('[data-billing-pending]').textContent = money(issued.filter((invoice) => invoice.payment_status === 'pending' || invoice.payment_status === 'partial').reduce((sum, invoice) => sum + Number(invoice.total_paise || 0), 0))
}

const renderTable = () => {
  const table = $('[data-billing-table]')
  table.replaceChildren()
  const query = $('[data-billing-search]').value.trim().toLowerCase()
  const rows = state.invoices.filter((invoice) => [invoice.invoice_number, invoice.customer_name, invoice.customer_email, ...(invoice.items || []).map((item) => item.name)].join(' ').toLowerCase().includes(query))
  rows.forEach((invoice) => {
    const tr = document.createElement('tr')
    const values = [invoice.invoice_number, invoice.invoice_date, invoice.customer_name, money(invoice.total_paise), invoice.payment_status, invoice.status]
    values.forEach((value) => {
      const td = document.createElement('td')
      td.textContent = value || '—'
      tr.append(td)
    })
    const action = document.createElement('td')
    const button = document.createElement('button')
    button.className = 'admin-action'
    button.type = 'button'
    button.textContent = 'View / Print'
    button.addEventListener('click', () => openCustomerCopy(invoice))
    action.append(button)
    tr.append(action)
    table.append(tr)
  })
  $('[data-billing-empty]').hidden = Boolean(rows.length)
  renderStats()
}

const loadInvoices = async () => {
  const { data, error } = await supabase.from('sales_invoices')
    .select('id, invoice_number, invoice_date, customer_name, customer_email, customer_phone, customer_address, items, subtotal_paise, shipping_paise, discount_paise, total_paise, payment_status, payment_method, notes, status, created_at')
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) {
    setStatus(error.message.includes('sales_invoices') ? 'Billing database is not set up yet. Run the SQL file linked in the setup note.' : error.message, true)
    return
  }
  state.invoices = data || []
  renderTable()
}

const handleSubmit = async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const submit = $('[data-billing-submit]')
  submit.disabled = true
  submit.textContent = 'Saving invoice…'
  try {
    const totals = updateTotals()
    if (!totals) throw new Error('Check item quantities, prices, shipping and discount.')
    const items = itemRows().map((row) => {
      const name = $('[name="item_name"]', row).value.trim()
      const quantity = Number($('[name="item_qty"]', row).value)
      const unitPrice = rupeesToPaise($('[name="item_price"]', row).value)
      if (!name || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new Error('Complete each item name and quantity.')
      return { name, quantity, unit_price_paise: unitPrice, line_total_paise: quantity * unitPrice }
    })
    if (!items.length) throw new Error('Add at least one item.')
    const values = Object.fromEntries(new FormData(form).entries())
    const { data: invoiceNumber, error: numberError } = await supabase.rpc('greyveil_next_sales_invoice_number')
    if (numberError) throw numberError
    const payload = {
      invoice_number: invoiceNumber,
      customer_name: values.customer_name.trim(),
      customer_email: values.customer_email.trim() || null,
      customer_phone: values.customer_phone.trim() || null,
      customer_address: values.customer_address.trim() || null,
      items,
      subtotal_paise: totals.subtotal,
      shipping_paise: totals.shipping,
      discount_paise: totals.discount,
      total_paise: totals.total,
      payment_status: values.payment_status,
      payment_method: values.payment_method || null,
      notes: values.notes.trim() || null,
      created_by: state.user.id,
    }
    const { data, error } = await supabase.from('sales_invoices').insert(payload)
      .select('id, invoice_number, invoice_date, customer_name, customer_email, customer_phone, customer_address, items, subtotal_paise, shipping_paise, discount_paise, total_paise, payment_status, payment_method, notes, status, created_at')
      .single()
    if (error) throw error
    state.invoices.unshift(data)
    renderTable()
    form.reset()
    $('[data-billing-items]').innerHTML = ''
    addItemRow()
    setStatus('Invoice saved to Greyveil records. Customer copy opened in a new tab.')
    openCustomerCopy(data)
  } catch (error) {
    setStatus(error.message || 'Could not save invoice.', true)
  } finally {
    submit.disabled = false
    submit.textContent = 'Save invoice & create customer copy'
  }
}

const init = async () => {
  $('[data-billing-logout]').addEventListener('click', () => signOut())
  $('[data-billing-add-item]').addEventListener('click', addItemRow)
  $('[data-billing-items]').addEventListener('input', updateTotals)
  $('[data-billing-items]').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-billing-remove]')
    if (!remove || itemRows().length <= 1) return
    remove.closest('[data-billing-item]').remove()
    updateRemoveButtons()
    updateTotals()
  })
  $('[data-billing-form]').addEventListener('input', updateTotals)
  $('[data-billing-form]').addEventListener('submit', handleSubmit)
  $('[data-billing-search]').addEventListener('input', renderTable)
  $('[data-billing-refresh]').addEventListener('click', loadInvoices)
  if (await guard()) {
    updateTotals()
    await loadInvoices()
  }
}
init()
