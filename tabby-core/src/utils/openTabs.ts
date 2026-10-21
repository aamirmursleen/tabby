import type { BaseTabSessionStatus } from '../components/baseTab.component'

export interface OpenTabLike {
    customTitle?: string|null
    title?: string|null
    color?: string|null
    profile?: {
        id?: string|null
        type?: string|null
        name?: string|null
    }|null
    getAllTabs?: () => OpenTabLike[]
    getSessionStatus?: () => Promise<BaseTabSessionStatus|null>
    hasFocus?: boolean
}

export interface OpenTabItem<T extends OpenTabLike = OpenTabLike> {
    tab: T
    index: number
    label: string
    color: string|null
    active: boolean
}

export interface OpenTabUsageEntry {
    score: number
    updatedAt: number
    lastUsedAt: number
}

export interface RankedOpenTabItem<T extends OpenTabLike = OpenTabLike> extends OpenTabItem<T> {
    usageScore: number
    usageLastUsedAt: number
}

export interface ActiveSessionItem<T extends OpenTabLike = OpenTabLike> {
    tab: T
    topLevelTab: T
    tabIndex: number
    paneIndex: number
    label: string
    color: string|null
    active: boolean
    status: BaseTabSessionStatus
}

export interface CloseTabConfirmationText {
    closeTab: string
    cancel: string
    areYouSure: string
}

function cleanLabel (value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function getProfileUsageKey (tab: OpenTabLike): string {
    const profileID = cleanLabel(tab.profile?.id)
    if (profileID) {
        return `${cleanLabel(tab.profile?.type) || 'profile'}:${profileID}`
    }
    const profileName = cleanLabel(tab.profile?.name)
    return profileName ? `name:${profileName.toLocaleLowerCase()}` : ''
}

export function getOpenTabLabel (tab: OpenTabLike, index: number): string {
    const customTitle = cleanLabel(tab.customTitle)
    if (customTitle) {
        return customTitle
    }

    let profileTabs: OpenTabLike[] = [tab]
    if (tab.getAllTabs) {
        const nestedTabs = tab.getAllTabs()
        if (nestedTabs.length) {
            profileTabs = nestedTabs
        }
    }

    const profileNames = profileTabs
        .map(profileTab => cleanLabel(profileTab.customTitle) || cleanLabel(profileTab.profile?.name))
        .filter((name, nameIndex, names) => name && names.indexOf(name) === nameIndex)
    if (profileNames.length) {
        return profileNames.join(' | ')
    }

    return cleanLabel(tab.title) || `Tab ${index + 1}`
}

export function getOpenTabUsageKey (tab: OpenTabLike, index: number): string {
    let profileTabs: OpenTabLike[] = [tab]
    if (tab.getAllTabs) {
        const nestedTabs = tab.getAllTabs()
        if (nestedTabs.length) {
            profileTabs = nestedTabs
        }
    }

    const profileKeys = profileTabs
        .map(getProfileUsageKey)
        .filter((key, keyIndex, keys) => key && keys.indexOf(key) === keyIndex)
    if (profileKeys.length) {
        return `profiles:${profileKeys.join('|')}`
    }

    return `title:${getOpenTabLabel(tab, index).toLocaleLowerCase()}`
}

export function getDecayedOpenTabUsageScore (
    entry: OpenTabUsageEntry,
    now: number,
    halfLifeMs = 1000 * 60 * 60 * 24 * 30,
): number {
    if (!Number.isFinite(entry.score) || entry.score <= 0) {
        return 0
    }
    const age = Math.max(0, now - entry.updatedAt)
    return entry.score * Math.pow(0.5, age / halfLifeMs)
}

export function buildOpenTabItems<T extends OpenTabLike> (tabs: readonly T[], activeTab: T|null): OpenTabItem<T>[] {
    return tabs.map((tab, index) => ({
        tab,
        index,
        label: getOpenTabLabel(tab, index),
        color: cleanLabel(tab.color) || null,
        active: tab === activeTab,
    }))
}

export function rankOpenTabItemsByUsage<T extends OpenTabLike> (
    items: readonly OpenTabItem<T>[],
    usage: Readonly<Record<string, OpenTabUsageEntry|undefined>>,
    now: number,
): RankedOpenTabItem<T>[] {
    return items
        .map(item => {
            const entry = usage[getOpenTabUsageKey(item.tab, item.index)]
            return {
                ...item,
                usageScore: entry ? getDecayedOpenTabUsageScore(entry, now) : 0,
                usageLastUsedAt: entry?.lastUsedAt ?? 0,
            }
        })
        .sort((a, b) => b.usageScore - a.usageScore
            || b.usageLastUsedAt - a.usageLastUsedAt
            || a.index - b.index)
}

export function filterOpenTabItems<T extends OpenTabLike, I extends OpenTabItem<T>> (items: I[], query: string): I[] {
    const terms = query
        .trim()
        .toLocaleLowerCase()
        .split(/\s+/)
        .filter(Boolean)
    if (!terms.length) {
        return items
    }
    return items.filter(item => {
        const label = item.label.toLocaleLowerCase()
        return terms.every(term => label.includes(term))
    })
}

export async function buildActiveSessionItems<T extends OpenTabLike> (
    tabs: readonly T[],
    activeTab: T|null,
): Promise<ActiveSessionItem<T>[]> {
    const candidates: Omit<ActiveSessionItem<T>, 'status'>[] = []
    tabs.forEach((topLevelTab, tabIndex) => {
        const panes = topLevelTab.getAllTabs?.() as T[]|undefined
        const sessionTabs = panes?.length ? panes : [topLevelTab]
        sessionTabs.forEach((tab, paneIndex) => {
            if (!tab.getSessionStatus) {
                return
            }
            candidates.push({
                tab,
                topLevelTab,
                tabIndex,
                paneIndex,
                label: getOpenTabLabel(tab, paneIndex),
                color: cleanLabel(tab.color) || null,
                active: topLevelTab === activeTab && (sessionTabs.length === 1 || !!tab.hasFocus),
            })
        })
    })

    const resolved = await Promise.all(candidates.map(async item => {
        try {
            const status = await item.tab.getSessionStatus!()
            if (!status) {
                return null
            }
            return {
                ...item,
                status,
            }
        } catch {
            return {
                ...item,
                status: { state: 'unknown', detail: 'Status unavailable' } as BaseTabSessionStatus,
            }
        }
    }))
    return resolved.filter((item): item is ActiveSessionItem<T> => item !== null)
}

export function buildCloseTabConfirmation (
    tab: OpenTabLike,
    index: number,
    text: CloseTabConfirmationText,
): {
        type: 'warning'
        message: string
        detail: string
        buttons: string[]
        defaultId: number
        cancelId: number
    } {
    return {
        type: 'warning',
        message: `${text.closeTab} “${getOpenTabLabel(tab, index)}”?`,
        detail: text.areYouSure,
        buttons: [text.closeTab, text.cancel],
        defaultId: 1,
        cancelId: 1,
    }
}
