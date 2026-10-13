import { BaseTabSessionStatus, Profile } from 'tabby-core'

export interface TerminalSessionStatusInput {
    frontendReady: boolean
    sessionOpen: boolean
    profile: Pick<Profile, 'type'|'name'|'options'>
    process?: string
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
    return status
}
