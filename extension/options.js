(function initializeOptions() {
  'use strict'

  const DEFAULT_BACKEND_URL = 'http://localhost:4400'
  const form = document.getElementById('options-form')
  const input = document.getElementById('backend-url')
  const status = document.getElementById('status')

  chrome.storage.sync.get({ backendUrl: DEFAULT_BACKEND_URL }, (stored) => {
    input.value = stored.backendUrl
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const backendUrl = input.value.trim().replace(/\/+$/, '') || DEFAULT_BACKEND_URL
    chrome.storage.sync.set({ backendUrl }, () => {
      input.value = backendUrl
      status.textContent = 'Saved'
      globalThis.setTimeout(() => { status.textContent = '' }, 1800)
    })
  })
})()
