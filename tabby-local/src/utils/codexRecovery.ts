interface TerminalProcess {
    command: string
}

export const CODEX_RECOVERY_COMMAND =
    'codex --sandbox danger-full-access --ask-for-approval never resume'

function getExecutableName (command: string): string {
    return command.trim().replace(/\\/g, '/').split('/').pop()?.toLocaleLowerCase() ?? ''
}

export function isCodexProcess (command: string): boolean {
    return ['codex', 'codex.exe', 'codex-code-mode-host'].includes(getExecutableName(command))
}

export function getValidatedCodexRecoveryCommand (command: unknown): string|null {
    if (command === CODEX_RECOVERY_COMMAND || command === `${CODEX_RECOVERY_COMMAND} --last`) {
        // Old tokens did not identify a session. Let the user choose rather
        // than silently resuming a different tab's latest same-folder session.
        return CODEX_RECOVERY_COMMAND
    }
    if (typeof command !== 'string' || !command.startsWith(`${CODEX_RECOVERY_COMMAND} `)) {
        return null
    }
    const id = command.substring(CODEX_RECOVERY_COMMAND.length + 1)
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? command : null
}

export function getCodexRecoveryCommand (processes: readonly TerminalProcess[], sessionID?: string): string|null {
    if (!processes.some(process => isCodexProcess(process.command))) {
        return null
    }
    return getValidatedCodexRecoveryCommand(`${CODEX_RECOVERY_COMMAND} ${sessionID ?? ''}`) ?? CODEX_RECOVERY_COMMAND
}

/** Start after interactive shell initialization; never race a prompt with timers. */
export function buildCodexRecoveryOptions<T extends { command: string, args: string[] }> (options: T, command: unknown): T|null {
    const validated = getValidatedCodexRecoveryCommand(command)
    if (!validated || !['zsh', 'bash', 'sh'].includes(getExecutableName(options.command))) {
        return null
    }
    if (options.args.some(arg => arg.startsWith('-') && !arg.startsWith('--') && arg.includes('c'))) {
        return null
    }
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    const restartShell = [options.command, ...options.args].map(quote).join(' ')
    return {
        ...options,
        args: [...options.args, '-i', '-c', `${validated}; exec ${restartShell}`],
    }
}
