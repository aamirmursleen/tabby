'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
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
    const service = new declarations.SSHKeyStorageService(config, platform)
    const provider = new declarations.SSHKeyFileProvider(service)
    return { ...declarations, config, saves, service, provider }
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

    assert.equal(config.store.ssh.keys.length, 1)
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
