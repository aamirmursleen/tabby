import deepClone from 'clone-deep'
import { BehaviorSubject } from 'rxjs'
import { Injectable } from '@angular/core'

import { PartialProfile, Profile } from '../api/profileProvider'
import { PlatformService } from '../api/platform'
import { BaseTabComponent } from '../components/baseTab.component'
import { SplitTabComponent } from '../components/splitTab.component'
import { buildActiveSessionItems, ActiveSessionItem } from '../utils/openTabs'
import {
    buildConnectionProjects,
    ConnectionProfileLike,
    ConnectionProjectItem,
    normalizeConnectionResumeContext,
} from '../utils/connectionProjects'
import {
    buildMasterWorkspaceProjects,
    MasterWorkspaceProject,
    MasterWorkspaceProjectMetadata,
    normalizeMasterWorkspaceMetadata,
    organizeFounderProjects,
} from '../utils/masterWorkspace'
import { AppService } from './app.service'
import { ConfigService } from './config.service'
import { ProfilesService } from './profiles.service'

export interface MasterWorkspaceSettings {
    relayUrl: string
    workspaceSlug: string
}

@Injectable({ providedIn: 'root' })
export class MasterWorkspaceService {
    projects: MasterWorkspaceProject<BaseTabComponent>[] = []
    loading = true
    error = ''
    readonly changed$ = new BehaviorSubject<void>(undefined)
    private refreshGeneration = 0

    constructor (
        private app: AppService,
        private config: ConfigService,
        private profiles: ProfilesService,
        private platform: PlatformService,
    ) {
        this.app.activeTabChange$.subscribe(() => this.refresh())
        this.app.tabStateChanged$.subscribe(() => this.refresh())
        this.config.changed$.subscribe(() => this.refresh())
        this.config.ready$.toPromise().then(() => this.refresh())
    }

    get settings (): MasterWorkspaceSettings {
        return {
            relayUrl: this.config.store?.masterWorkspace?.relay?.url ?? '',
            workspaceSlug: this.config.store?.masterWorkspace?.relay?.workspaceSlug ?? '',
        }
    }

    async refresh (): Promise<void> {
        if (!this.config.store) { return }
        const generation = ++this.refreshGeneration
        try {
            const liveItems = await buildActiveSessionItems(this.app.tabs, this.app.activeTab)
            if (generation !== this.refreshGeneration) { return }
            const connectionProjects = organizeFounderProjects(buildConnectionProjects(
                this.config.store.groups ?? [],
                (this.config.store.profiles ?? []) as ConnectionProfileLike[],
                liveItems,
                this.config.store.connectionResumeContexts ?? {},
            ))
            this.projects = buildMasterWorkspaceProjects(
                connectionProjects,
                this.config.store.masterWorkspace?.projects ?? {},
                Date.now(),
            )
            this.error = ''
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not load the Master Workspace.'
        } finally {
            if (generation === this.refreshGeneration) {
                this.loading = false
                this.changed$.next()
            }
        }
    }

    async activateConnection (item: ConnectionProjectItem<BaseTabComponent>): Promise<void> {
        if (item.liveItem) {
            this.selectLiveConnection(item.liveItem)
            return
        }
        if (!item.profile) { return }
        const profile = deepClone(item.profile) as PartialProfile<Profile>
        const savedContext = profile.id
            ? normalizeConnectionResumeContext(this.config.store.connectionResumeContexts?.[profile.id])
            : null
        if (savedContext) {
            profile.options ??= {}
            profile.options['aamirResumeContext'] = savedContext
            if (profile.type === 'local' && savedContext.workingDirectory) {
                profile.options['cwd'] = savedContext.workingDirectory
            }
        }
        await this.profiles.launchProfile(profile)
    }

    async launchFreshConnection (item: ConnectionProjectItem<BaseTabComponent>): Promise<void> {
        if (!item.profile) {
            if (item.liveItem) { this.selectLiveConnection(item.liveItem) }
            return
        }
        const profile = deepClone(item.profile) as PartialProfile<Profile>
        const savedContext = profile.id
            ? normalizeConnectionResumeContext(this.config.store.connectionResumeContexts?.[profile.id])
            : null
        if (savedContext) {
            profile.options ??= {}
            profile.options['aamirResumeContext'] = savedContext
            if (profile.type === 'local' && savedContext.workingDirectory) {
                profile.options['cwd'] = savedContext.workingDirectory
            }
        }
        await this.profiles.launchProfile(profile)
    }

    async saveProject (
        project: MasterWorkspaceProject<BaseTabComponent>,
        metadata: MasterWorkspaceProjectMetadata,
        priority: number,
    ): Promise<void> {
        const previousProjects = deepClone(this.config.store.masterWorkspace.projects ?? {})
        const projectName = project.name.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase()
        const group = this.config.store.groups.find(value => value.id === project.id
            || value.name.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase() === projectName)
        const previousPriority = group?.priority
        const nextPriority = Math.min(4, Math.max(1, Math.floor(Number(priority))))
        this.config.store.masterWorkspace.projects = {
            ...previousProjects,
            [project.id]: normalizeMasterWorkspaceMetadata({ ...metadata, priority: nextPriority }),
        }
        if (group) { group.priority = nextPriority }
        try {
            await this.config.save()
            await this.refresh()
        } catch (error) {
            this.config.store.masterWorkspace.projects = previousProjects
            if (group) { group.priority = previousPriority }
            throw error
        }
    }

    async saveSettings (value: MasterWorkspaceSettings): Promise<void> {
        const relayUrl = value.relayUrl.trim()
        if (relayUrl && !/^https:\/\/[^\s]+$/i.test(relayUrl)) {
            throw new Error('Relay URL must use HTTPS.')
        }
        const workspaceSlug = value.workspaceSlug.trim().slice(0, 120)
        const previous = deepClone(this.config.store.masterWorkspace.relay)
        this.config.store.masterWorkspace.relay = { url: relayUrl, workspaceSlug }
        try {
            await this.config.save()
        } catch (error) {
            this.config.store.masterWorkspace.relay = previous
            throw error
        }
    }

    async openLink (url: string): Promise<void> {
        if (!/^https?:\/\/[^\s]+$/i.test(url)) { return }
        await this.platform.openExternal(url)
    }

    private selectLiveConnection (item: ActiveSessionItem<BaseTabComponent>): void {
        if (!this.app.tabs.includes(item.topLevelTab)) {
            this.refresh()
            return
        }
        this.app.selectTab(item.topLevelTab)
        if (item.topLevelTab instanceof SplitTabComponent && item.topLevelTab.getAllTabs().includes(item.tab)) {
            item.topLevelTab.focus(item.tab)
        } else {
            item.tab.emitFocused()
        }
    }
}
