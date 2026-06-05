#!/usr/bin/env node

const https = require('https')

const baseUrl = (process.env.VALIDATE_BASE_URL || process.argv[2] || 'https://poliprod.uber.space').replace(/\/+$/, '')
const paths = [
  '/',
  '/polarity-res/',
  '/polarity-md/',
  '/polarity-sc/',
  '/spectrogram/',
  '/spectrum/',
  '/vectorscope/',
  '/dispenser/',
  '/dispenser/login.php',
  '/dispenser/bandcamp-codes.php',
  '/dispenser/admin/'
]

function checkUrl (url) {
  return new Promise((resolve) => {
    const request = https.request(url, { method: 'GET', timeout: 15000 }, (response) => {
      response.resume()
      response.on('end', () => resolve({
        url,
        statusCode: response.statusCode || 0,
        location: response.headers.location || ''
      }))
    })
    request.on('timeout', () => {
      request.destroy(new Error('timeout'))
    })
    request.on('error', (err) => resolve({ url, statusCode: 0, error: err.message }))
    request.end()
  })
}

function isAcceptable (result) {
  if (result.url.endsWith('/dispenser/admin/')) {
    return result.statusCode === 401 || result.statusCode === 200
  }
  return result.statusCode >= 200 && result.statusCode < 400
}

async function main () {
  let failed = 0
  for (const path of paths) {
    const result = await checkUrl(baseUrl + path)
    const ok = isAcceptable(result)
    if (!ok) failed++
    const suffix = result.location ? ` -> ${result.location}` : (result.error ? ` ${result.error}` : '')
    console.log(`${ok ? 'ok' : 'fail'} ${result.statusCode} ${path}${suffix}`)
  }
  if (failed) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err?.message || String(err))
  process.exit(1)
})
