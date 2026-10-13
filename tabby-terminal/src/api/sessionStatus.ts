import { BaseTabSessionStatus, Profile } from 'tabby-core'

export interface TerminalSessionStatusInput {
    frontendReady: boolean
    sessionOpen: boolean
    profile: Pick<Profile, 'type'|'name'|'options'>
    process?: string
    workingDirectory?: string|null
    homeDirectory?: string
}

export function formatSessionWorkingDirectory (input: TerminalSessionStatusInput): string|undefined {
    const workingDirectory = input.workingDirectory?.trim()
    if (!input.sessionOpen || !workingDirectory) {
        return undefined
    }

    const homes: string[] = []
    if (input.profile.type === 'local' && input.homeDirectory) {
        homes.push(input.homeDirectory.replace(/\/$/, ''))
    }
    if (input.profile.type === 'ssh') {
        const user = typeof input.profile.options?.user === 'string' ? input.profile.options.user.trim() : ''
        if (user === 'root') {
            homes.push('/root')
        } else if (user) {
            homes.push(`/home/${user}`, `/Users/${user}`)
        }
    }

    for (const home of homes) {
        if (workingDirectory === home) {
            return '~'
        }
        if (workingDirectory.startsWith(`${home}/`)) {
            return `~${workingDirectory.slice(home.length)}`
        }
    }
    return workingDirectory
}

export function buildTerminalSessionStatus (input: TerminalSessionStatusInput): BaseTabSessionStatus {
    const options = input.profile.options ?? {}
    let detail = input.profile.name?.trim() || 'Terminal'
    if (input.profile.type === 'ssh') {
        const host = typeof options.host === 'string' ? options.host.trim() : ''
        const user = typeof options.user === 'string' ? options.user.trim() : ''
        const port = typeof options.port === 'number' && options.port !== 22 ? `:${options.port}` : ''
        detail = `SSH${host ? ` · ${user ? `${user}@` : ''}${host}${port}` : ''}`
    } else if (input.profile.type === 'local') {
        detail = 'Local'
    }

    const status: BaseTabSessionStatus = {
        state: input.sessionOpen ? 'running' : input.frontendReady ? 'stopped' : 'starting',
        detail,
    }
    const process = input.process?.trim()
    if (input.sessionOpen && process) {
        status.process = process
    }
    const workingDirectory = formatSessionWorkingDirectory(input)
    if (workingDirectory) {
        status.workingDirectory = workingDirectory
    }
    return status
}
