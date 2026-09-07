'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')
const id = '019f7131-37d8-7763-b3c2-ab47f40276b7'
const other = '019f7131-37d8-7763-b3c2-ab47f40276b8'

function helpers () {
    return loadDeclarations('tabby-local/src/utils/codexSession.ts', ['parseCodexSessionHeader', 'parseCodexOpenFiles', 'selectCodexSession'], {
        isCodexProcess: command => command === 'codex',
    })
}

test('reads only bounded metadata before instructions, not conversation content', () => {
    const { parseCodexSessionHeader } = helpers()
    const prefix = JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/project="a"', source: 'cli', base_instructions: { text: 'private' } } })
    assert.deepEqual(JSON.parse(JSON.stringify(parseCodexSessionHeader(prefix))), { id, cwd: '/project="a"' })
    assert.equal(parseCodexSessionHeader(prefix.replace('"cli"', '{"subagent":{}}')), null)
    assert.equal(parseCodexSessionHeader('{"type":"response_item","payload":{"id":"fake"}}'), null)
})

test('maps rollout filenames to process IDs without accepting unrelated open files', () => {
    const { parseCodexOpenFiles } = helpers()
    const result = parseCodexOpenFiles(`p10\nn/tmp/rollout-2026-09-07T01-02-03-${id}.jsonl\nn/tmp/config.json\np20\nn/tmp/rollout-bad.jsonl\n`)
    assert.equal(result.length, 1)
    assert.equal(result[0].pid, 10)
    assert.equal(result[0].id, id)
})

test('two tabs in the same directory retain separate process-bound sessions', () => {
    const { selectCodexSession } = helpers()
    const sessions = [{ pid: 10, id, cwd: '/same' }, { pid: 20, id: other, cwd: '/same' }]
    assert.equal(selectCodexSession([{ pid: 10, command: 'codex' }], sessions).id, id)
    assert.equal(selectCodexSession([{ pid: 20, command: 'codex' }], sessions).id, other)
    assert.equal(selectCodexSession([{ pid: 10, command: 'vim' }], sessions), null)
    assert.equal(selectCodexSession([{ pid: 10, command: 'codex' }], [...sessions, { pid: 10, id: other, cwd: '/same' }]), null)
})
