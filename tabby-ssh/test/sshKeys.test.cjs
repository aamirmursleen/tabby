'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const russh = require('../../app/node_modules/russh')
const savedKeyID = '11111111-1111-4111-8111-111111111111'

function setup () {
    const directory = os.tmpdir()
    const saves = []
    const savedPassphrases = []
    const passwordStorage = {
        async savePrivateKeyPassword (hash, passphrase) {
            savedPassphrases.push([hash, passphrase])
        },
    }
    const config = {
        store: { ssh: { keys: [] } },
        save: async () => saves.push(JSON.parse(JSON.stringify(config.store))),
    }
    const configPath = path.join(directory, `aamir-ssh-keys-${crypto.randomUUID()}`, 'config.yaml')
    const platform = {
        getConfigPath: () => configPath,
    }
    const declarations = loadDeclarations('tabby-ssh/src/services/sshKeys.service.ts', [
        'SSH_KEY_REF_PREFIX',
        'SSHKeyStorageService',
        'SSHKeyFileProvider',
    ], {
        crypto,
        fs,
        path,
        russh,
        Buffer,
        Error,
        FileProvider: class {},
    })
    const service = new declarations.SSHKeyStorageService(config, platform, passwordStorage)
    const provider = new declarations.SSHKeyFileProvider(service)
    return { ...declarations, config, saves, savedPassphrases, passwordStorage, service, provider }
}

async function testKeyPair () {
    const privateKey = crypto.generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey
    const keyPair = await russh.KeyPair.parse(privateKey)
    const publicKey = keyPair.inner.publicKey()
    return {
        privateKey,
        publicKey: `${publicKey.algorithm()} ${publicKey.base64()} test-only`,
    }
}

test('pasted private keys are validated, stored as 0600 files, and never copied into config', async () => {
    const { SSH_KEY_REF_PREFIX, config, saves, service } = setup()
    const { privateKey } = await testKeyPair()

    const saved = await service.savePrivateKey('  Production API  ', privateKey)

    assert.ok(saved.ref.startsWith(SSH_KEY_REF_PREFIX))
    assert.equal(saved.key.label, 'Production API')
    assert.equal(saved.key.type, 'ssh-ed25519')
    assert.match(saved.key.fingerprint, /^SHA256:/)
    assert.match(saved.key.publicKey, /^ssh-ed25519 /)
    assert.doesNotMatch(JSON.stringify(config.store), /BEGIN PRIVATE KEY/)
    assert.equal((await service.retrievePrivateKey(saved.ref)).toString(), privateKey)

    const stat = await fs.stat(service.getKeyPathForTest(saved.key.id))
    assert.equal(stat.mode & 0o777, 0o600)
    assert.equal(saves.length, 1)
})

test('saved key labels are unique and public keys are rejected before anything is written', async () => {
    const { config, service } = setup()
    const { privateKey, publicKey } = await testKeyPair()

    await service.savePrivateKey('Production API', privateKey)
    await assert.rejects(
        service.savePrivateKey(' production api ', privateKey),
        /already exists/i,
    )
    await assert.rejects(
        service.savePrivateKey('Public only', publicKey),
        /private key/i,
    )
    await assert.rejects(
        service.savePrivateKey('No encryption', privateKey, 'unneeded'),
        /not encrypted/i,
    )

    assert.equal(config.store.ssh.keys.length, 1)
})

test('an encrypted pasted key validates and saves its passphrase in credential storage', async () => {
    const { config, savedPassphrases, service } = setup()
    const passphrase = 'test-only-passphrase'
    const privateKey = crypto.generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey

    const saved = await service.savePrivateKey('Encrypted deploy', privateKey, passphrase)
    const normalizedKey = (await service.retrievePrivateKey(saved.ref)).toString()
    const keyHash = crypto.createHash('sha512').update(normalizedKey).digest('hex')

    assert.equal(saved.key.type, 'ssh-ed25519')
    assert.match(saved.key.publicKey, /^ssh-ed25519 /)
    assert.deepEqual(savedPassphrases, [[keyHash, passphrase]])
    assert.doesNotMatch(JSON.stringify(config.store), /test-only-passphrase/)
    assert.doesNotMatch(JSON.stringify(config.store), /BEGIN ENCRYPTED PRIVATE KEY/)
    await assert.rejects(service.savePrivateKey('Wrong passphrase', privateKey, 'wrong'), /passphrase/i)
    assert.equal(config.store.ssh.keys.length, 1)
})

test('an encrypted OpenSSH key can be pasted with its passphrase', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aamir-encrypted-ssh-key-'))
    try {
        const filename = path.join(directory, 'id_ed25519')
        const passphrase = 'test-only-passphrase'
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-a', '4', '-N', passphrase, '-C', 'test-only', '-f', filename], { timeout: 10000 })
        const privateKey = await fs.readFile(filename, 'utf8')
        const { savedPassphrases, service } = setup()

        const saved = await service.savePrivateKey('OpenSSH encrypted', privateKey, passphrase)

        assert.equal(saved.key.type, 'ssh-ed25519')
        assert.match(saved.key.publicKey, /^ssh-ed25519 /)
        assert.equal(savedPassphrases.length, 1)
        await assert.rejects(service.savePrivateKey('Wrong OpenSSH passphrase', privateKey, 'wrong'), /passphrase/i)
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})

test('a credential storage failure does not attach an unusable new key', async () => {
    const { config, passwordStorage, service } = setup()
    const passphrase = 'test-only-passphrase'
    const privateKey = crypto.generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey
    passwordStorage.savePrivateKeyPassword = async () => { throw new Error('credential storage unavailable') }

    await assert.rejects(service.savePrivateKey('Encrypted deploy', privateKey, passphrase), /credential storage unavailable/)
    assert.deepEqual(Array.from(config.store.ssh.keys), [])
    const keyDirectory = path.dirname(service.getPrivateKeyPath(savedKeyID))
    assert.deepEqual(await fs.readdir(keyDirectory), [])
})

test('generating a key with a passphrase produces an encrypted reusable key', async () => {
    const { savedPassphrases, service } = setup()
    const passphrase = 'test-only-passphrase'

    const saved = await service.generateKey('Generated encrypted', 'ed25519', passphrase)
    const privateKey = (await service.retrievePrivateKey(saved.ref)).toString()

    assert.match(privateKey, /BEGIN ENCRYPTED PRIVATE KEY/)
    assert.equal((await russh.KeyPair.parse(privateKey, passphrase)).algorithm, 'ssh-ed25519')
    assert.equal(savedPassphrases.length, 1)
})

test('renaming and deleting saved keys update metadata and remove the private key file', async () => {
    const { config, service } = setup()
    const { privateKey } = await testKeyPair()
    const saved = await service.savePrivateKey('Old name', privateKey)
    const keyPath = service.getKeyPathForTest(saved.key.id)

    await service.renameKey(saved.key.id, 'New name')
    assert.equal(config.store.ssh.keys[0].label, 'New name')
    assert.equal((await service.retrievePrivateKey(saved.ref)).toString(), privateKey)

    await service.deleteKey(saved.key.id)
    assert.equal(config.store.ssh.keys.length, 0)
    await assert.rejects(fs.stat(keyPath), /ENOENT/)
    await assert.rejects(service.retrievePrivateKey(saved.ref), /not found/i)
})

test('failed metadata saves remove newly written private key files', async () => {
    const { config, service } = setup()
    const { privateKey } = await testKeyPair()

    config.save = async () => { throw new Error('config unavailable') }
    await assert.rejects(service.savePrivateKey('Rollback key', privateKey), /config unavailable/)

    assert.equal(config.store.ssh.keys.length, 0)
    const keyDirectory = path.dirname(service.getPrivateKeyPath(savedKeyID))
    const entries = await fs.readdir(keyDirectory).catch(error => {
        if (error.code === 'ENOENT') {
            return []
        }
        throw error
    })
    assert.deepEqual(entries, [])
})

test('generated keys are immediately usable by SSH auth and can be resolved through a file provider', async () => {
    const { provider, service } = setup()

    const saved = await service.generateKey('Generated ED25519', 'ed25519')
    const contents = await provider.retrieveFile(saved.ref)
    const parsed = await russh.KeyPair.parse(contents.toString())

    assert.equal(parsed.algorithm, 'ssh-ed25519')
    assert.equal(await provider.isAvailable(), false)
    await assert.rejects(provider.retrieveFile('file:///tmp/id_ed25519'), /Incorrect type/)
})

test('SSH profile settings can attach saved keys by label while preserving old file refs', () => {
    const { SSHProfileSettingsComponent } = loadDeclarations('tabby-ssh/src/components/sshProfileSettings.component.ts', [
        'SSHProfileSettingsComponent',
    ], {
        Component: () => target => target,
        ViewChild: () => () => {},
        Platform: {},
        SSHAlgorithmType: {},
        supportedAlgorithms: {},
        firstBy: () => () => 0,
        LoginScriptsSettingsComponent: class {},
    })
    const keyRef = `ssh-key://${savedKeyID}`
    const sshKeys = {
        keys: [{ id: savedKeyID, label: 'Deploy key', type: 'ssh-ed25519' }],
        makeRef: key => `ssh-key://${key}`,
        getLabel: ref => ref === keyRef ? 'Deploy key (ssh-ed25519)' : ref,
    }
    const component = new SSHProfileSettingsComponent({}, {}, {}, {}, {}, sshKeys)
    component.profile = { options: { auth: null, privateKeys: ['file:///Users/test/.ssh/legacy'] } }
    component.savedKeys = sshKeys.keys
    component.selectedSavedKeyRef = keyRef

    component.addSavedPrivateKey()
    component.addSavedPrivateKey()

    assert.deepEqual(Array.from(component.profile.options.privateKeys), ['file:///Users/test/.ssh/legacy', keyRef])
    assert.equal(component.profile.options.auth, 'publicKey')
    assert.equal(component.getPrivateKeyLabel(keyRef), 'Deploy key (ssh-ed25519)')
})

test('SSH profile settings can paste and save a key directly onto the profile', async () => {
    const { SSHProfileSettingsComponent } = loadDeclarations('tabby-ssh/src/components/sshProfileSettings.component.ts', [
        'SSHProfileSettingsComponent',
    ], {
        Component: () => target => target,
        ViewChild: () => () => {},
        Platform: {},
        SSHAlgorithmType: {},
        supportedAlgorithms: {},
        firstBy: () => () => 0,
        LoginScriptsSettingsComponent: class {},
    })
    const keyRef = `ssh-key://${savedKeyID}`
    const savedCalls = []
    const notices = []
    const sshKeys = {
        keys: [],
        makeRef: key => `ssh-key://${key}`,
        getLabel: ref => ref,
        savePrivateKey: async (label, contents, passphrase) => {
            savedCalls.push([label, contents, passphrase])
            sshKeys.keys = [{ id: savedKeyID, label, type: 'ssh-ed25519' }]
            return { ref: keyRef, key: sshKeys.keys[0] }
        },
    }
    const notifications = {
        notice: message => notices.push(message),
        error: () => assert.fail('Saving a valid pasted key must not show an error'),
    }
    const component = new SSHProfileSettingsComponent({}, {}, {}, {}, {}, sshKeys, notifications)
    component.profile = { name: 'MoonPush Sami', options: { auth: null, privateKeys: [] } }
    component.pastedPrivateKey = 'test-only-private-key'
    component.pastedPrivateKeyPassphrase = 'test-only-passphrase'

    await component.savePastedPrivateKey()
    await component.savePastedPrivateKey()

    assert.deepEqual(savedCalls, [['MoonPush Sami', 'test-only-private-key', 'test-only-passphrase']])
    assert.deepEqual(Array.from(component.profile.options.privateKeys), [keyRef])
    assert.equal(component.profile.options.auth, 'publicKey')
    assert.equal(component.showPastePrivateKeyForm, false)
    assert.equal(component.pastedPrivateKey, '')
    assert.equal(component.pastedPrivateKeyPassphrase, '')
    assert.equal(component.selectedSavedKeyRef, keyRef)
    assert.deepEqual(notices, ['SSH key saved'])
})

test('SSH key library uses an optional passphrase for pasted, imported, and generated keys', async () => {
    const { SSHSettingsTabComponent } = loadDeclarations('tabby-ssh/src/components/sshSettingsTab.component.ts', [
        'SSHSettingsTabComponent',
    ], {
        Component: () => target => target,
        HostBinding: () => () => {},
        Platform: {},
        X11Socket: { resolveDisplaySpec: () => ({ host: 'localhost', port: 6000 }) },
    })
    const calls = []
    const sshKeys = {
        keys: [],
        savePrivateKey: async (...args) => { calls.push(['paste', ...args]) },
        importPrivateKeyFromUpload: async (...args) => {
            calls.push(['import', ...args])
            return { ref: `ssh-key://${savedKeyID}` }
        },
        generateKey: async (...args) => { calls.push(['generate', ...args]) },
    }
    const component = new SSHSettingsTabComponent({}, {}, sshKeys, { notice: () => {} }, {}, {})

    component.newKeyName = 'Pasted key'
    component.newPrivateKey = 'test-only-private-key'
    component.newPrivateKeyPassphrase = 'paste-passphrase'
    await component.savePastedKey()
    assert.equal(component.newPrivateKeyPassphrase, '')

    component.newKeyName = 'Imported key'
    component.newPrivateKeyPassphrase = 'import-passphrase'
    await component.importKey()
    assert.equal(component.newPrivateKeyPassphrase, '')

    component.newKeyName = 'Generated key'
    component.newPrivateKeyPassphrase = 'generate-passphrase'
    await component.generateKey()
    assert.equal(component.newPrivateKeyPassphrase, '')

    assert.deepEqual(calls, [
        ['paste', 'Pasted key', 'test-only-private-key', 'paste-passphrase'],
        ['import', 'Imported key', 'import-passphrase'],
        ['generate', 'Generated key', 'ed25519', 'generate-passphrase'],
    ])
})
