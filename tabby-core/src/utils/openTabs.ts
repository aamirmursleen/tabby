export interface OpenTabLike {
    customTitle?: string|null
    title?: string|null
    color?: string|null
    profile?: {
        name?: string|null
    }|null
    getAllTabs?: () => OpenTabLike[]
}

export interface OpenTabItem<T extends OpenTabLike = OpenTabLike> {
    tab: T
    index: number
    label: string
    color: string|null
    active: boolean
}

export interface CloseTabConfirmationText {
    closeTab: string
    cancel: string
    areYouSure: string
}

function cleanLabel (value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
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

export function buildOpenTabItems<T extends OpenTabLike> (tabs: readonly T[], activeTab: T|null): OpenTabItem<T>[] {
    return tabs.map((tab, index) => ({
        tab,
        index,
        label: getOpenTabLabel(tab, index),
        color: cleanLabel(tab.color) || null,
        active: tab === activeTab,
    }))
}

export function filterOpenTabItems<T extends OpenTabLike> (items: OpenTabItem<T>[], query: string): OpenTabItem<T>[] {
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
