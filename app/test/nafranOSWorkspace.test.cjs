'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const encoder = new TextEncoder()

function loadReader (fetchImpl) {
    return loadDeclarations(
        'app/lib/nafranOSWorkspace.ts',
        ['NAFRAN_OS_ORIGIN', 'MAX_RESPONSE_BYTES', 'REQUEST_TIMEOUT_MS', 'ALLOWED_PATHS', 'readNafranJSON'],
        { URL, AbortController, fetch: fetchImpl },
    ).readNafranJSON
}

test('Nafran OS workspace API uses only allowlisted HTTPS routes and Cloudflare service headers', async () => {
    let request
    const readNafranJSON = loadReader(async (url, options) => {
        request = { url, options }
        return {
            ok: true,
            status: 200,
            url,
            headers: { get: () => null },
            arrayBuffer: async () => encoder.encode('{"ok":true}').buffer,
        }
    })
    const credential = { clientId: 'client-id-long-enough', clientSecret: 'client-secret-long-enough' }

    assert.equal((await readNafranJSON('/api/agent-control/shopify', credential)).ok, true)
    assert.equal(request.url, 'https://os.nafran.com/api/agent-control/shopify')
    assert.equal(request.options.redirect, 'error')
    assert.equal(request.options.headers['CF-Access-Client-Id'], credential.clientId)
    assert.equal(request.options.headers['CF-Access-Client-Secret'], credential.clientSecret)
    await assert.rejects(() => readNafranJSON('/api/admin', credential), /unexpected Nafran OS API path/)
})

test('Nafran OS workspace API rejects oversized and cross-origin responses', async () => {
    const credential = { clientId: 'client-id-long-enough', clientSecret: 'client-secret-long-enough' }
    const oversized = loadReader(async url => ({
        ok: true,
        status: 200,
        url,
        headers: { get: () => String(3 * 1024 * 1024) },
        arrayBuffer: async () => encoder.encode('{}').buffer,
    }))
    await assert.rejects(() => oversized('/api/agent-control/snapshot', credential), /safe size limit/)

    const redirected = loadReader(async () => ({
        ok: true,
        status: 200,
        url: 'https://example.com/data',
        headers: { get: () => null },
        arrayBuffer: async () => encoder.encode('{}').buffer,
    }))
    await assert.rejects(() => redirected('/data/operator-profile.json', credential), /unexpected origin/)
})
