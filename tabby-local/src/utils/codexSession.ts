import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { promisify } from 'util'
import { isCodexProcess } from './codexRecovery'

interface CodexSession {
    id: string
    cwd: string
}

interface ProcessSession extends CodexSession {
    pid: number
}

export function parseCodexSessionHeader (prefix: string): CodexSession|null {
    // The metadata preamble precedes potentially huge embedded instructions.
    // Do not read transcripts or parse arbitrary conversation text for commands.
    const boundary = prefix.indexOf('"base_instructions"')
    const header = boundary < 0 ? prefix : prefix.substring(0, boundary)
    if (!/"type"\s*:\s*"session_meta"/.test(header) || !/"source"\s*:\s*"cli"/.test(header)) {
        return null
    }
    const id = /"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i.exec(header)?.[1]
    const cwdJSON = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(header)?.[1]
    if (!id || !cwdJSON) {
        return null
    }
    try {
        const cwd: string = JSON.parse(cwdJSON)
        return cwd.startsWith('/') && !cwd.includes('\0') ? { id, cwd } : null
    } catch {
        return null
    }
}

export function parseCodexOpenFiles (output: string): { pid: number, path: string, id: string }[] {
    const files: { pid: number, path: string, id: string }[] = []
    let pid = 0
    for (const line of output.split('\n')) {
        if (/^p\d+$/.test(line)) {
            pid = Number(line.substring(1))
        } else if (pid && line.startsWith('n/')) {
            const id = /\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(line)?.[1]
            if (id) {
                files.push({ pid, path: line.substring(1), id })
            }
        }
    }
    return files
}

export function selectCodexSession (processes: readonly { pid: number, command: string }[], sessions: readonly ProcessSession[]): CodexSession|null {
    const pids = new Set(processes.filter(p => isCodexProcess(p.command)).map(p => p.pid))
    const matches = new Map(sessions.filter(session => pids.has(session.pid)).map(session => [session.id, session]))
    // Multiple independent CLI sessions in one terminal cannot be disambiguated
    // safely. Fall back to Codex's picker instead of guessing by recency.
    return matches.size === 1 ? [...matches.values()][0] : null
}

let cachedSessions: Promise<ProcessSession[]>|null = null
let cacheExpiresAt = 0

async function inspectCodexSessions (): Promise<ProcessSession[]> {
    const { stdout } = await promisify(execFile)('/usr/sbin/lsof', ['-n', '-P', '-c', 'codex', '-Fpn'], {
        timeout: 2000,
        maxBuffer: 8 * 1024 * 1024,
    })
    const sessions: ProcessSession[] = []
    const seen = new Set<string>()
    for (const file of parseCodexOpenFiles(stdout)) {
        const key = `${file.pid}:${file.id}`
        if (seen.has(key)) {
            continue
        }
        seen.add(key)
        const handle = await fs.open(file.path, 'r').catch(() => null)
        if (!handle) {
            continue
        }
        try {
            const buffer = Buffer.alloc(4096)
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
            const session = parseCodexSessionHeader(buffer.subarray(0, bytesRead).toString())
            if (session?.id === file.id) {
                sessions.push({ ...session, pid: file.pid })
            }
        } finally {
            await handle.close()
        }
    }
    return sessions
}

export async function findCodexSession (processes: readonly { pid: number, command: string }[]): Promise<CodexSession|null> {
    if (process.platform !== 'darwin' || !processes.some(p => isCodexProcess(p.command))) {
        return null
    }
    if (!cachedSessions || Date.now() >= cacheExpiresAt) {
        cacheExpiresAt = Infinity
        cachedSessions = inspectCodexSessions().then(result => {
            cacheExpiresAt = Date.now() + 250
            return result
        }, error => {
            cachedSessions = null
            throw error
        })
    }
    return selectCodexSession(processes, await cachedSessions)
}
