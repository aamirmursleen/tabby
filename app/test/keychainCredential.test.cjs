'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

test('macOS dashboard credentials use the signed security tool with bounded output and no secret arguments', async () => {
    let invocation
    const { readKeychainCredential } = loadDeclarations(
        'app/lib/keychainCredential.ts',
        ['KEYCHAIN_READ_TIMEOUT_MS', 'MAX_KEYCHAIN_OUTPUT_BYTES', 'readKeychainCredential'],
        {
            process: { platform: 'darwin' },
            execFile: async (file, args, options) => {
                invocation = { file, args, options }
                return [Buffer.from('test-dashboard-credential\n'), Buffer.alloc(0)]
            },
        },
    )

    const credential = await readKeychainCredential('dashboard-service', 'dashboard-account')
    assert.equal(credential, 'test-dashboard-credential')
    assert.equal(invocation.file, '/usr/bin/security')
    assert.deepEqual(Array.from(invocation.args), [
        'find-generic-password', '-w', '-a', 'dashboard-account', '-s', 'dashboard-service',
    ])
    assert.equal(invocation.args.includes(credential), false)
    assert.equal(invocation.options.timeout, 5_000)
    assert.equal(invocation.options.maxBuffer, 4 * 1024)
})

test('a missing macOS Keychain record is returned as null', async () => {
    const { readKeychainCredential } = loadDeclarations(
        'app/lib/keychainCredential.ts',
        ['KEYCHAIN_READ_TIMEOUT_MS', 'MAX_KEYCHAIN_OUTPUT_BYTES', 'readKeychainCredential'],
        {
            process: { platform: 'darwin' },
            execFile: async () => { throw Object.assign(new Error('not found'), { code: 44 }) },
        },
    )

    assert.equal(await readKeychainCredential('missing-service', 'missing-account'), null)
})
