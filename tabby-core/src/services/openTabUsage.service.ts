import { Injectable } from '@angular/core'

import { BaseTabComponent } from '../components/baseTab.component'
import {
    OpenTabItem,
    OpenTabUsageEntry,
    RankedOpenTabItem,
    getDecayedOpenTabUsageScore,
    getOpenTabUsageKey,
    rankOpenTabItemsByUsage,
} from '../utils/openTabs'

const STORAGE_KEY = 'aamirOpenTabUsageV1'
const ACTIVATION_SCORE = 1000 * 60 * 5
const MAX_ACTIVE_INTERVAL = 1000 * 60 * 60 * 4
const MAX_ENTRIES = 128
const SAVE_DELAY = 1000

@Injectable({ providedIn: 'root' })
export class OpenTabUsageService {
    private entries: Record<string, OpenTabUsageEntry|undefined> = {}
    private activeKey: string|null = null
    private activeSince = 0
    private saveTimer: ReturnType<typeof setTimeout>|null = null
    private dirty = false

    constructor () {
        this.entries = this.loadEntries()
        if (!Object.keys(this.entries).length) {
            this.seedFromRecentProfiles()
        }
        window.addEventListener('beforeunload', () => {
            this.checkpoint()
            this.persistNow()
        })
    }

    activate (tab: BaseTabComponent|null, index: number, recordActivation: boolean): void {
        const now = Date.now()
        this.checkpoint(now)
        this.activeKey = tab ? getOpenTabUsageKey(tab, index) : null
        this.activeSince = now

        if (this.activeKey && recordActivation) {
            this.addScore(this.activeKey, ACTIVATION_SCORE, now)
        }
    }

    checkpoint (now = Date.now()): void {
        if (!this.activeKey || !this.activeSince) {
            return
        }
        const activeDuration = Math.min(Math.max(0, now - this.activeSince), MAX_ACTIVE_INTERVAL)
        this.activeSince = now
        if (activeDuration > 0) {
            this.addScore(this.activeKey, activeDuration, now)
        }
    }

    rank<T extends BaseTabComponent> (items: readonly OpenTabItem<T>[]): RankedOpenTabItem<T>[] {
        return rankOpenTabItemsByUsage(items, this.entries, Date.now())
    }

    private addScore (key: string, amount: number, now: number): void {
        const current = this.entries[key]
        this.entries[key] = {
            score: (current ? getDecayedOpenTabUsageScore(current, now) : 0) + amount,
            updatedAt: now,
            lastUsedAt: now,
        }
        this.dirty = true
        this.schedulePersist()
    }

    private loadEntries (): Record<string, OpenTabUsageEntry|undefined> {
        try {
            const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return {}
            }
            return Object.fromEntries(Object.entries(value)
                .filter((entry): entry is [string, OpenTabUsageEntry] => {
                    const stats = entry[1] as OpenTabUsageEntry|null
                    return stats !== null
                        && typeof stats === 'object'
                        && Number.isFinite(stats.score)
                        && Number.isFinite(stats.updatedAt)
                        && Number.isFinite(stats.lastUsedAt)
                })
                .slice(0, MAX_ENTRIES))
        } catch {
            return {}
        }
    }

    private seedFromRecentProfiles (): void {
        try {
            const profiles = JSON.parse(window.localStorage.getItem('recentProfiles') ?? '[]')
            if (!Array.isArray(profiles)) {
                return
            }
            const recentProfiles = profiles.slice(0, 20)
            const now = Date.now()
            recentProfiles.forEach((profile, index) => {
                const key = getOpenTabUsageKey({ profile }, index)
                const recencyWeight = (recentProfiles.length - index) / Math.max(recentProfiles.length, 1)
                this.entries[key] = {
                    score: ACTIVATION_SCORE * recencyWeight,
                    updatedAt: now,
                    lastUsedAt: now - index,
                }
            })
            if (recentProfiles.length) {
                this.dirty = true
                this.schedulePersist()
            }
        } catch {
            // A malformed old recent-profile entry should not affect the tab menu.
        }
    }

    private schedulePersist (): void {
        if (this.saveTimer !== null) {
            return
        }
        this.saveTimer = setTimeout(() => this.persistNow(), SAVE_DELAY)
    }

    private persistNow (): void {
        if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer)
            this.saveTimer = null
        }
        if (!this.dirty) {
            return
        }

        try {
            const now = Date.now()
            this.entries = Object.fromEntries(Object.entries(this.entries)
                .filter((entry): entry is [string, OpenTabUsageEntry] => entry[1] !== undefined)
                .sort((a, b) => getDecayedOpenTabUsageScore(b[1], now) - getDecayedOpenTabUsageScore(a[1], now))
                .slice(0, MAX_ENTRIES))
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries))
            this.dirty = false
        } catch {
            // Usage ranking is optional and must never interfere with terminal input.
        }
    }
}
