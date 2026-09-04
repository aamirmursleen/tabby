interface TerminalProcess {
    command: string
}

export const CODEX_RECOVERY_COMMAND =
    'codex --sandbox danger-full-access --ask-for-approval never resume --last'

function getExecutableName (command: string): string {
    return command.trim().replace(/\\/g, '/').split('/').pop()?.toLocaleLowerCase() ?? ''
}

export function getCodexRecoveryCommand (processes: readonly TerminalProcess[]): string|null {
    const codexRunning = processes.some(process => {
        const executable = getExecutableName(process.command)
        return executable === 'codex' || executable === 'codex.exe' || executable.startsWith('codex-')
    })
    return codexRunning ? CODEX_RECOVERY_COMMAND : null
}
