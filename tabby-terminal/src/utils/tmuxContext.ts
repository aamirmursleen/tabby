import type { BaseTabSessionResumeContext } from 'tabby-core'

export interface TmuxClientContext {
    clientPID: number|null
    activity: number
    sessionName: string
    workingDirectory?: string
}

function cleanValue (value: unknown, maxLength: number): string|undefined {
    if (typeof value !== 'string' || /[\0\r\n]/.test(value)) { return undefined }
    const cleaned = value.trim()
    return cleaned.length && cleaned.length <= maxLength ? cleaned : undefined
}

export function sanitizeSessionResumeContext (value: unknown): BaseTabSessionResumeContext|null {
    if (!value || typeof value !== 'object') { return null }
    const candidate = value as BaseTabSessionResumeContext
    const tmuxSession = cleanValue(candidate.tmuxSession, 200)
    const workingDirectory = cleanValue(candidate.workingDirectory, 4096)
    if (!tmuxSession && !workingDirectory) { return null }
    return { tmuxSession, workingDirectory }
}

export function parseTmuxClientContexts (output: string): TmuxClientContext[] {
    return output.split(/\r?\n/).flatMap(line => {
        const [pidText, activityText, nameText, ...pathParts] = line.replace(/\\t/g, '\t').split('\t')
        const sessionName = cleanValue(nameText, 200)
        if (!sessionName) { return [] }
        const clientPID = Number(pidText)
        const activity = Number(activityText)
        const workingDirectory = cleanValue(pathParts.join('\t'), 4096)
        return [{
            clientPID: Number.isSafeInteger(clientPID) && clientPID > 0 ? clientPID : null,
            activity: Number.isFinite(activity) ? activity : 0,
            sessionName,
            workingDirectory,
        }]
    })
}

export function selectTmuxClientContext (
    contexts: readonly TmuxClientContext[],
    clientPIDs: ReadonlySet<number> = new Set(),
    workingDirectory?: string|null,
): BaseTabSessionResumeContext|null {
    const sorted = [...contexts].sort((a, b) => b.activity - a.activity)
    const match = sorted.find(context => context.clientPID !== null && clientPIDs.has(context.clientPID))
        ?? sorted.find(context => !!workingDirectory && context.workingDirectory === workingDirectory)
        ?? (clientPIDs.size === 0 ? sorted[0] : undefined)
    return match ? sanitizeSessionResumeContext({
        tmuxSession: match.sessionName,
        workingDirectory: match.workingDirectory ?? workingDirectory ?? undefined,
    }) : null
}

function quoteShellArgument (value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildTmuxResumeCommand (value: unknown): string|null {
    const context = sanitizeSessionResumeContext(value)
    if (!context?.tmuxSession) { return null }
    const directory = context.workingDirectory ? ` -c ${quoteShellArgument(context.workingDirectory)}` : ''
    return `tmux new-session -A -s ${quoteShellArgument(context.tmuxSession)}${directory}`
}

export function buildSessionResumeCommand (value: unknown): string|null {
    const context = sanitizeSessionResumeContext(value)
    if (!context) { return null }
    return buildTmuxResumeCommand(context)
        ?? (context.workingDirectory ? `cd -- ${quoteShellArgument(context.workingDirectory)}` : null)
}

export function buildShellTmuxResumeOptions<T extends { command: string, args: string[], cwd?: string|null }> (
    options: T,
    value: unknown,
): T|null {
    const command = buildTmuxResumeCommand(value)
    const context = sanitizeSessionResumeContext(value)
    const executable = options.command.trim().replace(/\\/g, '/').split('/').pop()?.toLocaleLowerCase()
    if (!command || !['zsh', 'bash', 'sh'].includes(executable ?? '')) { return null }
    if (options.args.some(arg => arg.startsWith('-') && !arg.startsWith('--') && arg.includes('c'))) { return null }
    const restartShell = [options.command, ...options.args].map(quoteShellArgument).join(' ')
    return {
        ...options,
        cwd: context?.workingDirectory ?? options.cwd,
        args: [...options.args, '-i', '-c', `${command}; exec ${restartShell}`],
    }
}
