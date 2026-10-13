import type { BaseTabSessionResumeContext, BaseTabSessionStatus } from '../components/baseTab.component'

export type ConnectionPriority = 1|2|3|4

export interface ConnectionGroupLike {
    id: string
    name: string
    priority?: number
    color?: string|null
    icon?: string|null
}

export interface ConnectionProfileLike {
    id?: string
    type: string
    name: string
    group?: string|null
    color?: string|null
    icon?: string|null
    isBuiltin?: boolean
    isTemplate?: boolean
    options?: { cwd?: string|null, [key: string]: unknown }
}

export interface LiveConnectionLike<T = any> {
    tab: T & { profile?: ConnectionProfileLike|null }
    topLevelTab: T
    tabIndex: number
    paneIndex: number
    label: string
    color: string|null
    active: boolean
    status: BaseTabSessionStatus
}

export interface ConnectionProjectItem<T = any> {
    key: string
    kind: 'live'|'saved'
    profile?: ConnectionProfileLike
    liveItem?: LiveConnectionLike<T>
    label: string
    color: string|null
    active: boolean
    status: BaseTabSessionStatus
    position?: string
}

export interface ConnectionProject<T = any> {
    id: string
    name: string
    priority: ConnectionPriority
    color: string|null
    icon: string|null
    liveCount: number
    connections: ConnectionProjectItem<T>[]
}

const importantProjectNames = new Set(['calendarjet', 'mamasign', 'wittyform'])

export function normalizeConnectionPriority (value: unknown, projectName = ''): ConnectionPriority {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4) {
        return value as ConnectionPriority
    }
    return importantProjectNames.has(projectName.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase()) ? 1 : 3
}

export function getConnectionPriorityLabel (priority: ConnectionPriority): string {
    switch (priority) {
        case 1: return 'P1 Critical'
        case 2: return 'P2 High'
        case 3: return 'P3 Normal'
        case 4: return 'P4 Low'
    }
}

function isSavedConnection (profile: ConnectionProfileLike): boolean {
    return !profile.isBuiltin && !profile.isTemplate && profile.type !== 'split-layout'
}

export function normalizeConnectionResumeContext (value: unknown): BaseTabSessionResumeContext|null {
    if (!value || typeof value !== 'object') { return null }
    const candidate = value as BaseTabSessionResumeContext
    const clean = (input: unknown, max: number): string|undefined => {
        if (typeof input !== 'string' || /[\0\r\n]/.test(input)) { return undefined }
        const result = input.trim()
        return result.length && result.length <= max ? result : undefined
    }
    const tmuxSession = clean(candidate.tmuxSession, 200)
    const workingDirectory = clean(candidate.workingDirectory, 4096)
    if (tmuxSession === undefined && workingDirectory === undefined) { return null }
    return { tmuxSession, workingDirectory }
}

function stoppedStatus (profile: ConnectionProfileLike, savedContext?: unknown): BaseTabSessionStatus {
    const resumeContext = normalizeConnectionResumeContext(savedContext)
    const workingDirectory = resumeContext?.workingDirectory ?? profile.options?.cwd?.trim()
    return {
        state: 'stopped',
        detail: `Saved ${profile.type.toLocaleUpperCase()}`,
        workingDirectory: workingDirectory?.length ? workingDirectory : undefined,
        tmuxSession: resumeContext?.tmuxSession,
        resumeContext: resumeContext ?? undefined,
    }
}

function cleanOptional (value: string|null|undefined): string|null {
    const cleaned = value?.trim()
    return cleaned?.length ? cleaned : null
}

function connectionSort<T> (a: ConnectionProjectItem<T>, b: ConnectionProjectItem<T>): number {
    if (a.active !== b.active) { return a.active ? -1 : 1 }
    const stateOrder = { running: 0, starting: 1, unknown: 2, stopped: 3 }
    const byState = stateOrder[a.status.state] - stateOrder[b.status.state]
    return byState !== 0 ? byState : a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })
}

export function buildConnectionProjects<T> (
    groups: readonly ConnectionGroupLike[],
    profiles: readonly ConnectionProfileLike[],
    liveItems: readonly LiveConnectionLike<T>[],
    savedContexts: Readonly<Record<string, unknown>> = {},
): ConnectionProject<T>[] {
    const projects = new Map<string, ConnectionProject<T>>()
    for (const group of groups) {
        const name = group.name.trim()
        projects.set(group.id, {
            id: group.id,
            name: name.length ? name : 'Unnamed project',
            priority: normalizeConnectionPriority(group.priority, group.name),
            color: cleanOptional(group.color),
            icon: cleanOptional(group.icon),
            liveCount: 0,
            connections: [],
        })
    }

    const savedProfiles = profiles.filter(isSavedConnection)
    const profilesByID = new Map(savedProfiles.filter(profile => profile.id).map(profile => [profile.id!, profile]))
    const profilesWithLiveSessions = new Set<string>()

    const projectFor = (groupID?: string|null): ConnectionProject<T> => {
        const known = groupID ? projects.get(groupID) : undefined
        if (known) { return known }
        let ungrouped = projects.get('ungrouped')
        if (!ungrouped) {
            ungrouped = {
                id: 'ungrouped', name: 'Ungrouped', priority: 3, color: null, icon: null,
                liveCount: 0, connections: [],
            }
            projects.set(ungrouped.id, ungrouped)
        }
        return ungrouped
    }

    liveItems.forEach((liveItem, index) => {
        const liveProfile = liveItem.tab.profile
        const profile = liveProfile?.id ? profilesByID.get(liveProfile.id) ?? liveProfile : liveProfile ?? undefined
        if (profile?.id) { profilesWithLiveSessions.add(profile.id) }
        const project = projectFor(profile?.group)
        project.liveCount++
        project.connections.push({
            key: `live:${liveItem.tabIndex}:${liveItem.paneIndex}:${profile?.id ?? index}`,
            kind: 'live',
            profile,
            liveItem,
            label: liveItem.label,
            color: liveItem.color,
            active: liveItem.active,
            status: liveItem.status,
            position: `${liveItem.tabIndex + 1}${liveItem.paneIndex ? `.${liveItem.paneIndex + 1}` : ''}`,
        })
    })

    savedProfiles.forEach((profile, index) => {
        if (profile.id && profilesWithLiveSessions.has(profile.id)) { return }
        projectFor(profile.group).connections.push({
            key: `saved:${profile.id ?? `${profile.type}:${profile.name}:${index}`}`,
            kind: 'saved',
            profile,
            label: profile.name.trim(),
            color: cleanOptional(profile.color),
            active: false,
            status: stoppedStatus(profile, profile.id ? savedContexts[profile.id] : undefined),
        })
    })

    for (const project of projects.values()) {
        project.connections.sort(connectionSort)
    }
    return [...projects.values()]
        .filter(project => project.id !== 'ungrouped' || project.connections.length > 0)
        .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}

export function filterConnectionProjects<T> (projects: readonly ConnectionProject<T>[], query: string): ConnectionProject<T>[] {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) { return [...projects] }
    return projects.flatMap(project => {
        if (terms.every(term => project.name.toLocaleLowerCase().includes(term))) { return [project] }
        const connections = project.connections.filter(connection => {
            const value = `${connection.label} ${connection.status.detail} ${connection.status.tmuxSession ?? ''} ${connection.status.workingDirectory ?? ''}`.toLocaleLowerCase()
            return terms.every(term => value.includes(term))
        })
        return connections.length ? [{ ...project, connections }] : []
    })
}
