import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import slugify from 'slugify'
import { v4 as uuidv4 } from 'uuid'
import { Injectable } from '@angular/core'
import { NewTabParameters, PartialProfile, Profile, ProfileProvider } from './api'
import { ConfigService, configMerge } from './services/config.service'
import { SplitTabComponent } from './components/splitTab.component'
import { BaseTabComponent } from './components/baseTab.component'
import { TabRecoveryService } from './services/tabRecovery.service'
import { RecoveryToken } from './api/tabRecovery'

export interface SplitLayoutProfileOptions {
    recoveryToken: any
    updatedAt?: number
}

export interface SplitLayoutProfile extends Profile {
    options: SplitLayoutProfileOptions
}

export interface SavedLayoutProfile extends PartialProfile<SplitLayoutProfile> {
    id: string
    options: SplitLayoutProfileOptions
}

@Injectable({ providedIn: 'root' })
export class SplitLayoutProfilesService extends ProfileProvider<SplitLayoutProfile> {
    private mutationQueue: Promise<void> = Promise.resolve()
    id = 'split-layout'
    name = _('Saved layout')
    configDefaults = {
        options: {
            recoveryToken: null,
        },
    }

    constructor (
        private config: ConfigService,
        private tabRecovery: TabRecoveryService,
    ) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<SplitLayoutProfile>[]> {
        return []
    }

    async getNewTabParameters (profile: SavedLayoutProfile): Promise<NewTabParameters<SplitTabComponent>> {
        if (!this.isLayout(profile)) {
            throw new Error('This saved layout contains invalid pane data.')
        }
        const token = this.cloneLayoutToken(profile.options.recoveryToken)
        for (const pane of this.getPaneTokens(token)) {
            // A saved layout keeps its pane geometry, while the current
            // connection profile supplies all SSH settings and credentials.
            const current = this.config.store.profiles.find(x => x.id === pane.profile.id && x.type === pane.profile.type)
            if (current) {
                pane.profile = configMerge({}, current)
            }
            // A reusable layout must start its own terminal, even if an old
            // connection profile contains a transient PTY recovery identifier.
            delete pane.profile.options?.restoreFromPTYID
            if (!await this.tabRecovery.recoverTab(pane)) {
                throw new Error('A pane profile is no longer available. Enable its terminal plugin before opening this layout.')
            }
        }
        const recovered = await this.tabRecovery.recoverTab(token)
        if (!recovered) {
            throw new Error('The saved layout could not be opened.')
        }
        return recovered as NewTabParameters<SplitTabComponent>
    }

    getDescription (): string {
        return ''
    }

    get savedLayouts (): SavedLayoutProfile[] {
        const profiles: unknown = this.config.store.profiles
        return Array.isArray(profiles) ? profiles.filter((profile): profile is SavedLayoutProfile => this.isLayout(profile)) : []
    }

    get validationError (): string {
        const profiles: unknown = this.config.store.profiles
        return !Array.isArray(profiles) || profiles.some(profile => profile?.type === this.id && !this.isLayout(profile))
            ? 'Some saved layouts contain invalid data. Repair the saved layout profiles in Settings before making changes. Your saved data is preserved.' : ''
    }

    getPaneCount (profile: SavedLayoutProfile): number {
        return this.getPaneTokens(profile.options.recoveryToken).length
    }

    async createProfile (tab: BaseTabComponent, name: string, replaceID?: string): Promise<SavedLayoutProfile> {
        const raw = await this.tabRecovery.getFullRecoveryToken(tab, { includeState: false })
        if (!this.isToken(raw)) {
            throw new Error('Select a terminal tab with recoverable panes before saving a layout.')
        }
        const token = this.cloneLayoutToken(raw)
        const root = token.type === 'app:split-tab' ? token : {
            type: 'app:split-tab', orientation: 'h', ratios: [1], children: [token], focusedTabIndex: 0,
        }
        return this.enqueue(async () => {
            this.validateName(name, replaceID)
            const previous = replaceID ? this.savedLayouts.find(x => x.id === replaceID) : undefined
            if (replaceID && !previous) {
                throw new Error('This saved layout no longer exists.')
            }
            const profile: SavedLayoutProfile = {
                ...previous,
                id: replaceID ?? `${this.id}:custom:${slugify(name.trim())}:${uuidv4()}`,
                type: this.id,
                name: name.trim(),
                options: { recoveryToken: root, updatedAt: Date.now() },
            }
            const profiles = [...this.config.store.profiles]
            const index = profiles.findIndex(x => x.id === profile.id)
            if (index < 0) { profiles.push(profile) } else { profiles[index] = profile }
            await this.persist(profiles)
            return profile
        })
    }

    async renameLayout (id: string, name: string): Promise<void> {
        await this.enqueue(async () => {
            this.validateName(name, id)
            if (!this.savedLayouts.some(x => x.id === id)) {
                throw new Error('This saved layout no longer exists.')
            }
            await this.persist(this.config.store.profiles.map(profile => profile.id === id ? { ...profile, name: name.trim() } : profile))
        })
    }

    async deleteLayout (id: string): Promise<void> {
        await this.enqueue(() => this.persist(this.config.store.profiles.filter(profile => profile.type !== this.id || profile.id !== id)))
    }

    private validateName (name: string, id?: string): void {
        if (!name.trim() || name.trim().length > 100) {
            throw new Error('Enter a layout name of 1–100 characters.')
        }
        if (this.savedLayouts.some(x => x.id !== id && x.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())) {
            throw new Error('A layout with this name already exists.')
        }
    }

    private isLayout (value: any): value is SavedLayoutProfile {
        return !!value && value.type === this.id && typeof value.id === 'string'
            && typeof value.name === 'string' && !!value.name.trim()
            && this.isToken(value.options?.recoveryToken)
    }

    private isToken (value: any, depth = 0, budget = { remaining: 128 }): value is RecoveryToken {
        if (!value || typeof value !== 'object' || depth > 20 || --budget.remaining < 0) { return false }
        if (value.type !== 'app:split-tab') {
            return typeof value.type === 'string' && !!value.profile && typeof value.profile === 'object'
                && typeof value.profile.type === 'string'
        }
        return (value.orientation === 'h' || value.orientation === 'v')
            && Array.isArray(value.children) && value.children.length > 0
            && Array.isArray(value.ratios) && value.ratios.length === value.children.length
            && value.ratios.every(ratio => typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0)
            && Number.isFinite(value.ratios.reduce((sum, ratio) => sum + ratio, 0))
            && value.children.every(child => this.isToken(child, depth + 1, budget))
    }

    private getPaneTokens (token: RecoveryToken): RecoveryToken[] {
        return token.type === 'app:split-tab' ? token.children.flatMap(child => this.getPaneTokens(child)) : [token]
    }

    private cloneLayoutToken (token: RecoveryToken): RecoveryToken {
        const omitted = new Set(['savedstate', 'recoverycommand', 'restorefromptyid', 'password', 'passphrase', 'privatekey'])
        return JSON.parse(JSON.stringify(token, (key, value) => omitted.has(key.toLowerCase()) ? undefined : value))
    }

    private enqueue<T> (operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(async () => {
            if (this.validationError) { throw new Error(this.validationError) }
            return operation()
        })
        this.mutationQueue = result.then(() => undefined, () => undefined)
        return result
    }

    private async persist (profiles: PartialProfile<Profile>[]): Promise<void> {
        const store = this.config.store
        const previous = store.profiles
        store.profiles = profiles
        try {
            await this.config.save()
        } catch (error) {
            if (store.profiles === profiles) { store.profiles = previous }
            throw error
        }
    }
}
