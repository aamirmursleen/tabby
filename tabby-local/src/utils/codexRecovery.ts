interface TerminalProcess {
    command: string
}

function getExecutableName (command: string): string {
    return command.trim().replace(/\\/g, '/').split('/').pop()?.toLocaleLowerCase() ?? ''
}

export function getCodexRecoveryCommand (processes: readonly TerminalProcess[]): string|null {
    const codexRunning = processes.some(process => {
        const executable = getExecutableName(process.command)
        return executable === 'codex' || executable === 'codex.exe' || executable.startsWith('codex-')
    })
    return codexRunning ? 'codex' : null
}
