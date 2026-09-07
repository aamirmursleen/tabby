import { Injectable, Inject } from '@angular/core'
import { TabRecoveryProvider, RecoveryToken } from '../api/tabRecovery'
import { BaseTabComponent, GetRecoveryTokenOptions } from '../components/baseTab.component'
import { Logger, LogService } from './log.service'
import { ConfigService } from './config.service'
import { NewTabParameters } from './tabs.service'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class TabRecoveryService {
    logger: Logger
    enabled = false
    private pendingSave: BaseTabComponent[]|null = null
    private saveInProgress: Promise<void>|null = null
    private lastGoodTokens = new WeakMap<BaseTabComponent, RecoveryToken>()

    private constructor (
        @Inject(TabRecoveryProvider) private tabRecoveryProviders: TabRecoveryProvider<BaseTabComponent>[]|null,
        private config: ConfigService,
        log: LogService,
    ) {
        this.logger = log.create('tabRecovery')
    }

    async saveTabs (tabs: BaseTabComponent[]): Promise<void> {
        if (!this.enabled || !this.config.store.recoverTabs) {
            return
        }
        // Coalesce bursts and serialize snapshots so a slow, older save cannot
        // overwrite a newer workspace. Do not retain the caller's mutable array.
        this.pendingSave = [...tabs]
        this.saveInProgress ??= this.flushPendingSaves().finally(() => {
            this.saveInProgress = null
        })
        await this.saveInProgress
    }

    private async flushPendingSaves (): Promise<void> {
        while (this.pendingSave) {
            const tabs = this.pendingSave
            this.pendingSave = null
            const tokens = await Promise.all(tabs.map(async tab => {
                try {
                    const token = await this.getFullRecoveryToken(tab, { includeState: true })
                    if (token) {
                        this.lastGoodTokens.set(tab, token)
                    } else {
                        this.lastGoodTokens.delete(tab)
                    }
                    return token
                } catch (error) {
                    this.logger.warn('Could not snapshot a tab; retaining its last good recovery state:', error)
                    return this.lastGoodTokens.get(tab) ?? null
                }
            }))
            window.localStorage.tabsRecovery = JSON.stringify(tokens.filter(token => !!token))
        }
    }

    async getFullRecoveryToken (tab: BaseTabComponent, options?: GetRecoveryTokenOptions): Promise<RecoveryToken|null> {
        const token = await tab.getRecoveryToken(options)
        if (token) {
            token.tabTitle = tab.title
            token.tabCustomTitle = tab.customTitle
            token.tabPinned = tab.pinned
            if (tab.icon) {
                token.tabIcon = tab.icon
            }
            if (tab.color) {
                token.tabColor = tab.color
            }
            token.disableDynamicTitle = tab['disableDynamicTitle']
        }
        return token
    }

    async recoverTab (token: RecoveryToken): Promise<NewTabParameters<BaseTabComponent>|null> {
        for (const provider of this.config.enabledServices(this.tabRecoveryProviders ?? [])) {
            try {
                if (!await provider.applicableTo(token)) {
                    continue
                }
                const tab = await provider.recover(token)
                tab.inputs = tab.inputs ?? {}
                tab.inputs.icon = token.tabIcon ?? null
                tab.inputs.color = token.tabColor ?? null
                tab.inputs.title = token.tabTitle || ''
                tab.inputs.customTitle = token.tabCustomTitle || ''
                tab.inputs.pinned = token.tabPinned ?? false
                tab.inputs.disableDynamicTitle = token.disableDynamicTitle
                return tab
            } catch (error) {
                this.logger.warn('Tab recovery crashed:', token, provider, error)
            }
        }
        return null
    }

    async recoverTabs (): Promise<NewTabParameters<BaseTabComponent>[]> {
        if (window.localStorage.tabsRecovery) {
            const tabs: NewTabParameters<BaseTabComponent>[] = []
            for (const token of JSON.parse(window.localStorage.tabsRecovery)) {
                const tab = await this.recoverTab(token)
                if (tab) {
                    tabs.push(tab)
                }
            }
            return tabs
        }
        return []
    }
}
