'use strict'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')
const { loadDeclarations, deferred } = require('../../test/helpers/source.cjs')

const keyID = key => crypto.createHash('sha512').update(key).digest('hex')
const storageID = key => `ssh-private-key:${keyID(key)}`
const tick = () => new Promise(resolve => setImmediate(resolve))

function setup (options = {}) {
    const records = options.records ?? new Map()
    const events = []
    const prompts = []
    const notifications = []
    const parsed = new Map()
    const keytar = {
        async getPassword (service, account) {
            events.push(['read', service, account])
            if (options.readError) { throw options.readError }
            return records.get(service) ?? null
        },
        async setPassword (service, account, value) {
            events.push(['write', service, account, value])
            await options.beforeWrite?.()
            records.set(service, value)
        },
        async deletePassword (service, account) {
            events.push(['delete', service, account])
            records.delete(service)
        },
    }
    const { PasswordStorageService } = loadDeclarations('tabby-ssh/src/services/passwordStorage.service.ts', [
        'VAULT_SECRET_TYPE_PASSWORD', 'VAULT_SECRET_TYPE_PASSPHRASE', 'PasswordStorageService',
    ], { keytar })
    const vault = options.vault ?? { isEnabled: () => false }
    const storage = new PasswordStorageService(vault)
    const russh = options.russh ?? {
        KeyPair: {
            async parse (key, passphrase) {
                events.push(['parse', key, passphrase])
                if (key === 'corrupt') { throw new Error('Keys(CouldNotReadKey)') }
                if (key !== 'unencrypted' && passphrase !== `unlock-${key}`) {
                    throw new Error(passphrase === undefined ? 'Keys(KeyIsEncrypted)' : 'Keys(SshKey(Crypto))')
                }
                if (!parsed.has(key)) { parsed.set(key, { key }) }
                return parsed.get(key)
            },
        },
    }
    const { SSHSession } = loadDeclarations('tabby-ssh/src/session/ssh.ts', ['SSHSession'], {
        crypto, russh, Error, PromptModalComponent: class {},
    })
    function session () {
        const instance = Object.create(SSHSession.prototype)
        instance.passwordStorage = storage
        instance.notifications = { error: (...args) => notifications.push(args) }
        instance.ngbModal = {
            open () {
                const prompt = { componentInstance: {} }
                const index = prompts.push(prompt) - 1
                assert.ok(index < 8, 'Unlock must not reopen a cancelled prompt indefinitely')
                assert.ok(options.prompt, 'Unexpected private key prompt')
                prompt.result = Promise.resolve().then(() => options.prompt(index, prompt))
                return prompt
            },
        }
        return instance
    }
    return { records, events, prompts, notifications, storage, session, PasswordStorageService }
}

test('an existing saved passphrase unlocks the same key in different sessions without prompting', async () => {
    const records = new Map([[storageID('first'), 'unlock-first']])
    const h = setup({ records })
    await h.session().loadPrivateKeyWithPassphraseMaybe('first')
    await h.session().loadPrivateKeyWithPassphraseMaybe('first')
    assert.equal(h.prompts.length, 0)
    assert.equal(h.events.filter(event => event[0] === 'write' || event[0] === 'delete').length, 0)
})

test('four servers sharing a key use one prompt and reuse the saved passphrase after restart', async () => {
    const reply = deferred()
    const h = setup({ prompt: () => reply.promise })
    const opening = Array.from({ length: 4 }, () => h.session().loadPrivateKeyWithPassphraseMaybe('first'))
    await tick()
    const promptCount = h.prompts.length
    reply.resolve({ value: 'unlock-first', remember: true })
    await Promise.all(opening)
    assert.equal(promptCount, 1)
    assert.equal(h.events.filter(event => event[0] === 'write').length, 1)
    assert.equal(h.events.filter(event => event[0] === 'delete').length, 0)
    const restarted = setup({ records: h.records })
    await restarted.session().loadPrivateKeyWithPassphraseMaybe('first')
    assert.equal(restarted.prompts.length, 0)
})

test('remember waits for successful key validation and for credential persistence to finish', async () => {
    const writeStarted = deferred()
    const finishWrite = deferred()
    const h = setup({
        prompt: () => ({ value: 'unlock-first', remember: true }),
        beforeWrite: () => { writeStarted.resolve(); return finishWrite.promise },
    })
    let finished = false
    const opening = h.session().loadPrivateKeyWithPassphraseMaybe('first').then(value => { finished = true; return value })
    await writeStarted.promise
    await tick()
    const finishedBeforeSave = finished
    const writeIndex = h.events.findIndex(event => event[0] === 'write')
    const validParseIndex = h.events.findIndex(event => event[0] === 'parse' && event[2] === 'unlock-first')
    finishWrite.resolve()
    await opening
    assert.equal(finishedBeforeSave, false)
    assert.ok(validParseIndex >= 0 && validParseIndex < writeIndex)
})

test('incorrect input is never saved and cancelling preserves the previous saved record', async () => {
    const records = new Map([[storageID('first'), 'previous-value']])
    const h = setup({ records, prompt: index => index === 0 ? { value: 'wrong', remember: true } : null })
    await assert.rejects(h.session().loadPrivateKeyWithPassphraseMaybe('first'), /Passphrase prompt cancelled/)
    await tick()
    assert.equal(records.get(storageID('first')), 'previous-value')
    assert.equal(h.events.filter(event => event[0] === 'write' || event[0] === 'delete').length, 0)
})

test('one cancellation settles all concurrent callers and a later retry can open a new prompt', async () => {
    const reply = deferred()
    const h = setup({ prompt: index => index === 0 ? reply.promise : { value: 'unlock-first', remember: true } })
    const opening = Array.from({ length: 3 }, () => h.session().loadPrivateKeyWithPassphraseMaybe('first'))
    const settled = Promise.allSettled(opening)
    await tick()
    reply.resolve(null)
    const results = await settled
    assert.ok(results.every(result => result.status === 'rejected' && /Passphrase prompt cancelled/.test(result.reason.message)))
    assert.equal(h.prompts.length, 1)
    await h.session().loadPrivateKeyWithPassphraseMaybe('first')
    assert.equal(h.prompts.length, 2)
})

test('closing the passphrase dialog rejects the unlock cleanly', async () => {
    const h = setup({ prompt: () => Promise.reject(new Error('dismissed')) })
    await assert.rejects(h.session().loadPrivateKeyWithPassphraseMaybe('first'), /Passphrase prompt cancelled/)
    assert.equal(h.records.size, 0)
    assert.equal(h.events.filter(event => event[0] === 'delete').length, 0)
})

test('leaving Remember unchecked does not persist the passphrase', async () => {
    const h = setup({ prompt: () => ({ value: 'unlock-first', remember: false }) })
    await h.session().loadPrivateKeyWithPassphraseMaybe('first')
    await h.session().loadPrivateKeyWithPassphraseMaybe('first')
    assert.equal(h.records.size, 0)
    assert.equal(h.prompts.length, 2)
    assert.equal(h.events.filter(event => event[0] === 'write' || event[0] === 'delete').length, 0)
})

test('different keys keep separate unlock requests and credentials', async () => {
    const h = setup({ prompt: index => ({ value: index === 0 ? 'unlock-first' : 'unlock-second', remember: true }) })
    await Promise.all([
        h.session().loadPrivateKeyWithPassphraseMaybe('first'),
        h.session().loadPrivateKeyWithPassphraseMaybe('second'),
    ])
    assert.equal(h.prompts.length, 2)
    assert.equal(h.records.get(storageID('first')), 'unlock-first')
    assert.equal(h.records.get(storageID('second')), 'unlock-second')
})

test('unencrypted or malformed keys never read or delete saved passphrases', async () => {
    const h = setup()
    await h.session().loadPrivateKeyWithPassphraseMaybe('unencrypted')
    await assert.rejects(h.session().loadPrivateKeyWithPassphraseMaybe('corrupt'), /CouldNotReadKey/)
    assert.equal(h.events.filter(event => event[0] === 'read' || event[0] === 'delete').length, 0)
    assert.equal(h.prompts.length, 0)
})

test('credential access failure is reported and manual unlocking still works without deleting the stored record', async () => {
    const records = new Map([[storageID('first'), 'unlock-first']])
    const h = setup({ records, readError: new Error('access denied'), prompt: () => ({ value: 'unlock-first', remember: false }) })
    await h.session().loadPrivateKeyWithPassphraseMaybe('first')
    assert.equal(records.get(storageID('first')), 'unlock-first')
    assert.equal(h.notifications.length, 1)
    assert.match(h.notifications[0][0], /saved.*passphrase/i)
    assert.equal(h.events.filter(event => event[0] === 'delete').length, 0)
})

test('failed persistence is reported while preserving the successfully unlocked connection', async () => {
    const h = setup({
        prompt: () => ({ value: 'unlock-first', remember: true }),
        beforeWrite: () => { throw new Error('storage unavailable') },
    })
    const result = await h.session().loadPrivateKeyWithPassphraseMaybe('first')
    assert.ok(result)
    assert.equal(h.records.size, 0)
    assert.equal(h.notifications.length, 1)
    assert.match(h.notifications[0][0], /save.*passphrase/i)
})

test('private key passphrase saves await the encrypted vault and propagate storage failures', async () => {
    const saveStarted = deferred()
    const saveFinished = deferred()
    const vault = {
        isEnabled: () => true,
        addSecret: () => { saveStarted.resolve(); return saveFinished.promise },
    }
    const h = setup({ vault })
    let finished = false
    const saving = h.storage.savePrivateKeyPassword('test-id', 'test-only-passphrase')
    const observed = saving.then(() => { finished = true }, () => { finished = true })
    const rejected = assert.rejects(saving, /vault unavailable/)
    rejected.catch(() => {})
    await saveStarted.promise
    await tick()
    const finishedBeforeWrite = finished
    saveFinished.reject(new Error('vault unavailable'))
    await observed
    await rejected
    assert.equal(finishedBeforeWrite, false)
})

test('real encrypted PKCS8 keys reuse saved credentials and recover from a wrong passphrase', async () => {
    const russh = require('../../app/node_modules/russh')
    const passphrase = 'test-only-passphrase'
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const stored = setup({ russh, records: new Map([[storageID(privateKey), passphrase]]) })
    assert.equal((await stored.session().loadPrivateKeyWithPassphraseMaybe(privateKey)).algorithm, 'ssh-rsa')
    assert.equal(stored.prompts.length, 0)

    const h = setup({
        russh,
        prompt: index => ({ value: index === 0 ? 'wrong' : passphrase, remember: true }),
    })
    const results = await Promise.all(Array.from({ length: 4 }, () => h.session().loadPrivateKeyWithPassphraseMaybe(privateKey)))
    assert.ok(results.every(result => result.algorithm === 'ssh-rsa'))
    assert.equal(h.prompts.length, 2)
    assert.equal(h.events.filter(event => event[0] === 'write').length, 1)
    assert.equal(h.records.get(storageID(privateKey)), passphrase)
    const restarted = setup({ russh, records: h.records })
    assert.equal((await restarted.session().loadPrivateKeyWithPassphraseMaybe(privateKey)).algorithm, 'ssh-rsa')
    assert.equal(restarted.prompts.length, 0)
})

test('real encrypted OpenSSH keys share an unlock and remain usable after credential reload', async () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const os = require('node:os')
    const { execFileSync } = require('node:child_process')
    const russh = require('../../app/node_modules/russh')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aamir-passphrase-test-'))
    const passphrase = 'test-only-passphrase'
    try {
        const filename = path.join(directory, 'id_ed25519')
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-a', '4', '-N', passphrase, '-C', 'test-only', '-f', filename], { timeout: 10000 })
        const privateKey = fs.readFileSync(filename, 'utf8')
        const h = setup({ russh, prompt: index => ({ value: index === 0 ? 'wrong' : passphrase, remember: true }) })
        const results = await Promise.all(Array.from({ length: 4 }, () => h.session().loadPrivateKeyWithPassphraseMaybe(privateKey)))
        assert.ok(results.every(result => result.algorithm === 'ssh-ed25519'))
        assert.equal(h.prompts.length, 2)
        assert.equal(h.events.filter(event => event[0] === 'write').length, 1)
        const restarted = setup({ russh, records: h.records })
        assert.equal((await restarted.session().loadPrivateKeyWithPassphraseMaybe(privateKey)).algorithm, 'ssh-ed25519')
        assert.equal(restarted.prompts.length, 0)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('SSH-key and agent authentication do not request unrelated server passwords from Keychain', async () => {
    for (const auth of ['publicKey', 'agent']) {
        const h = setup()
        const instance = h.session()
        instance.profile = { options: { host: 'test.invalid', port: 22, user: 'test-user', auth } }
        instance.authUsername = 'test-user'
        instance.allAuthMethods = []
        await instance.populateStoredPasswordsForResolvedUsername()
        assert.equal(h.events.filter(event => event[0] === 'read').length, 0)
    }
})

test('password-capable authentication still loads the saved server password', async () => {
    for (const auth of [null, 'password', 'keyboardInteractive']) {
        const records = new Map([['ssh@test.invalid:22', 'test-only-password']])
        const h = setup({ records })
        const instance = h.session()
        instance.profile = { options: { host: 'test.invalid', port: 22, user: 'test-user', auth } }
        instance.authUsername = 'test-user'
        instance.allAuthMethods = [{ type: 'prompt-password' }, { type: 'keyboard-interactive' }]
        await instance.populateStoredPasswordsForResolvedUsername()
        assert.equal(h.events.filter(event => event[0] === 'read').length, 1)
        assert.ok(instance.allAuthMethods.some(method => method.password === 'test-only-password' || method.savedPassword === 'test-only-password'))
    }
})
