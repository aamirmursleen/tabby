import { Component, OnDestroy, OnInit } from '@angular/core'

import { AppService } from '../services/app.service'
import { ActiveSessionItem, buildActiveSessionItems } from '../utils/openTabs'
import { BaseComponent } from './base.component'
import { BaseTabComponent, BaseTabSessionState } from './baseTab.component'
import { SplitTabComponent } from './splitTab.component'

/** @hidden */
@Component({
    selector: 'active-sessions',
    templateUrl: './activeSessions.component.pug',
    styleUrls: ['./activeSessions.component.scss'],
})
export class ActiveSessionsComponent extends BaseComponent implements OnInit, OnDestroy {
    items: ActiveSessionItem<BaseTabComponent>[] = []
    private refreshTimer: number|null = null
    private refreshGeneration = 0

    constructor (private app: AppService) {
        super()
        this.subscribeUntilDestroyed(this.app.tabsChanged$, () => this.refreshItems())
        this.subscribeUntilDestroyed(this.app.activeTabChange$, () => this.refreshItems())
    }

    ngOnInit (): void {
        this.refreshItems()
        this.refreshTimer = window.setInterval(() => this.refreshItems(), 2500)
    }

    ngOnDestroy (): void {
        if (this.refreshTimer !== null) {
            window.clearInterval(this.refreshTimer)
        }
        this.refreshGeneration++
        super.ngOnDestroy()
    }

    select (item: ActiveSessionItem<BaseTabComponent>): void {
        if (!this.app.tabs.includes(item.topLevelTab)) {
            this.refreshItems()
            return
        }
        this.app.selectTab(item.topLevelTab)
        if (item.topLevelTab instanceof SplitTabComponent && item.topLevelTab.getAllTabs().includes(item.tab)) {
            item.topLevelTab.focus(item.tab)
        } else {
            item.tab.emitFocused()
        }
        this.refreshItems()
    }

    trackByTab (_index: number, item: ActiveSessionItem<BaseTabComponent>): BaseTabComponent {
        return item.tab
    }

    statusLabel (state: BaseTabSessionState): string {
        switch (state) {
            case 'running': return 'Running'
            case 'starting': return 'Starting'
            case 'stopped': return 'Stopped'
            default: return 'Unknown'
        }
    }

    itemAriaLabel (item: ActiveSessionItem<BaseTabComponent>): string {
        return `${item.label}, ${this.statusLabel(item.status.state)}`
    }

    private async refreshItems (): Promise<void> {
        const generation = ++this.refreshGeneration
        const items = await buildActiveSessionItems(this.app.tabs, this.app.activeTab)
        if (generation === this.refreshGeneration) {
            this.items = items
        }
    }
}
