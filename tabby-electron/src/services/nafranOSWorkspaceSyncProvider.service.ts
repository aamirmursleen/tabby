import { ipcRenderer } from 'electron'
import { Injectable } from '@angular/core'
import { buildNafranOSWorkspaceSnapshot, MasterWorkspaceSyncProvider } from 'tabby-core'

interface NafranOSWorkspaceFeeds {
    snapshot: unknown
    shopify: unknown
    profile: unknown
}

@Injectable()
export class NafranOSWorkspaceSyncProvider extends MasterWorkspaceSyncProvider {
    async loadSnapshot (force = false): Promise<unknown> {
        const feedsValue = await ipcRenderer.invoke('app:load-nafran-os-workspace-feeds', force) as unknown
        if (!feedsValue || typeof feedsValue !== 'object'
            || !('snapshot' in feedsValue) || !('shopify' in feedsValue) || !('profile' in feedsValue)) {
            throw new Error('Nafran OS API returned an incomplete workspace response.')
        }
        const feeds = feedsValue as NafranOSWorkspaceFeeds
        return buildNafranOSWorkspaceSnapshot(feeds.snapshot, feeds.shopify, feeds.profile)
    }

    async loadWorkItems (workspaceSlug: string, force = false, projectId = ''): Promise<unknown> {
        return ipcRenderer.invoke('app:load-plane-work-items', workspaceSlug, force, projectId)
    }

    async runFounderBriefing (request: unknown): Promise<unknown> {
        return ipcRenderer.invoke('app:run-founder-briefing', request)
    }
}
