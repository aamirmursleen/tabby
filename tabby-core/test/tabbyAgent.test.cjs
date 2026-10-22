'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const {
    TABBY_AGENT_CWD,
    TABBY_AGENT_TITLE,
    buildTabbyAgentProfile,
} = loadDeclarations(
    'tabby-core/src/utils/tabbyAgent.ts',
    ['TABBY_AGENT_CWD', 'TABBY_AGENT_TITLE', 'buildTabbyAgentProfile'],
)

test('builds one visible Codex terminal rooted in the Tabby workspace', () => {
    const profile = buildTabbyAgentProfile()

    assert.equal(TABBY_AGENT_TITLE, 'AI Agent · Tabby')
    assert.equal(TABBY_AGENT_CWD, '/Users/m.aamirmursleen/tabby')
    assert.equal(profile.type, 'local')
    assert.equal(profile.name, TABBY_AGENT_TITLE)
    assert.equal(profile.disableDynamicTitle, true)
    assert.equal(profile.behaviorOnSessionEnd, 'keep')
    assert.equal(profile.options.command, '/bin/zsh')
    assert.equal(profile.options.cwd, TABBY_AGENT_CWD)
    assert.deepEqual(JSON.parse(JSON.stringify(profile.options.args)), [
        '-l', '-i', '-c',
        'exec codex --sandbox danger-full-access --ask-for-approval never --search --no-alt-screen -C /Users/m.aamirmursleen/tabby',
    ])
    assert.deepEqual(JSON.parse(JSON.stringify(profile.options.env)), {})
})

test('the agent launcher contains no prompt text or embedded credential', () => {
    const serialized = JSON.stringify(buildTabbyAgentProfile())
    assert.equal(serialized.includes('plane_api_'), false)
    assert.equal(serialized.includes('apiKey'), false)
    assert.equal(serialized.includes('PROMPT'), false)
})
