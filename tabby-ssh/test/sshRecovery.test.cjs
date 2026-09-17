'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const ProfilesService = class {}
const { RecoveryProvider } = loadDeclarations('tabby-ssh/src/recoveryProvider.ts', ['RecoveryProvider'], {
    Injectable: () => target => target,
    TabRecoveryProvider: class {},
    ProfilesService,
    SSHTabComponent: class {},
})

test('restoring an SSH tab uses the current profile instead of stale saved credentials', async () => {
    const savedProfile = { id: 'ssh:server', type: 'ssh', name: 'Server', options: { host: 'old.test', privateKeys: ['file:///old-key'] } }
    const currentProfile = { id: 'ssh:server', type: 'ssh', name: 'Server', options: { host: 'new.test', privateKeys: ['ssh-key://11111111-1111-4111-8111-111111111111'] } }
    const profiles = { getConfigProxyForProfile: profile => profile }
    const injector = { get: token => token === ProfilesService ? profiles : assert.fail('Unexpected injection') }
    const provider = new RecoveryProvider(injector, { store: { profiles: [currentProfile] } })

    const result = await provider.recover({ type: 'app:ssh-tab', profile: savedProfile, savedState: { history: 'kept' } })

    assert.equal(result.inputs.profile, currentProfile)
    assert.deepEqual(result.inputs.savedState, { history: 'kept' })
    assert.equal(savedProfile.options.host, 'old.test')
})

test('restoring an SSH tab without an existing profile keeps its saved connection', async () => {
    const savedProfile = { id: 'ssh:removed', type: 'ssh', name: 'Old server', options: { host: 'old.test' } }
    const profiles = { getConfigProxyForProfile: profile => profile }
    const injector = { get: token => token === ProfilesService ? profiles : assert.fail('Unexpected injection') }
    const provider = new RecoveryProvider(injector, { store: { profiles: [] } })

    const result = await provider.recover({ type: 'app:ssh-tab', profile: savedProfile })

    assert.equal(result.inputs.profile, savedProfile)
})
