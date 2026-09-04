import { Component, ElementRef, EventEmitter, HostBinding, Input, Output, ViewChild } from '@angular/core'

import { ConfigService } from '../services/config.service'
import { AppService } from '../services/app.service'
import { OpenTabItem, buildOpenTabItems, filterOpenTabItems } from '../utils/openTabs'

import { BaseComponent } from './base.component'
import { BaseTabComponent } from './baseTab.component'

/** @hidden */
@Component({
    selector: 'open-tabs-menu',
    templateUrl: './openTabsMenu.component.pug',
    styleUrls: ['./openTabsMenu.component.scss'],
})
export class OpenTabsMenuComponent extends BaseComponent {
    @Input() open = false
    @Output() tabSelected = new EventEmitter<BaseTabComponent>()
    @Output() dismissed = new EventEmitter<void>()
    @ViewChild('searchInput') searchInput: ElementRef<HTMLInputElement>
    @ViewChild('tabList') tabList: ElementRef<HTMLElement>

    query = ''
    items: OpenTabItem<BaseTabComponent>[] = []
    filteredItems: OpenTabItem<BaseTabComponent>[] = []
    highlightedIndex = 0

    @HostBinding('class.vibrant') get isVibrant (): boolean {
        return this.config.store.appearance.vibrancy
    }

    constructor (
        private config: ConfigService,
        private app: AppService,
    ) {
        super()
        this.refreshItems()
        this.subscribeUntilDestroyed(this.app.tabsChanged$, () => this.refreshItems())
        this.subscribeUntilDestroyed(this.app.activeTabChange$, () => this.refreshItems())
    }

    ngOnChanges (): void {
        if (!this.open) {
            return
        }
        this.query = ''
        this.refreshItems()
        this.highlightedIndex = Math.max(0, this.filteredItems.findIndex(item => item.active))
        setTimeout(() => {
            this.searchInput.nativeElement.focus()
            this.searchInput.nativeElement.select()
            this.scrollHighlightedItemIntoView()
        })
    }

    onQueryChange (query: string): void {
        this.query = query
        this.applyFilter()
        this.highlightedIndex = 0
    }

    onKeyDown (event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            this.dismissed.emit()
            return
        }
        if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            if (this.filteredItems.length) {
                this.selectItem(this.filteredItems[this.highlightedIndex])
            }
            return
        }

        let nextIndex = this.highlightedIndex
        if (event.key === 'ArrowDown') {
            nextIndex++
        } else if (event.key === 'ArrowUp') {
            nextIndex--
        } else if (event.key === 'Home') {
            nextIndex = 0
        } else if (event.key === 'End') {
            nextIndex = this.filteredItems.length - 1
        } else {
            return
        }

        event.preventDefault()
        event.stopPropagation()
        this.highlightedIndex = Math.max(0, Math.min(nextIndex, this.filteredItems.length - 1))
        this.scrollHighlightedItemIntoView()
    }

    selectItem (item: OpenTabItem<BaseTabComponent>): void {
        if (this.app.tabs.includes(item.tab)) {
            this.tabSelected.emit(item.tab)
        }
    }

    trackByTab (_index: number, item: OpenTabItem<BaseTabComponent>): BaseTabComponent {
        return item.tab
    }

    getItemID (item: OpenTabItem<BaseTabComponent>): string {
        return `open-tab-item-${item.index}`
    }

    private refreshItems (): void {
        this.items = buildOpenTabItems(this.app.tabs, this.app.activeTab)
        this.applyFilter()
    }

    private applyFilter (): void {
        this.filteredItems = filterOpenTabItems(this.items, this.query)
        this.highlightedIndex = Math.max(0, Math.min(this.highlightedIndex, this.filteredItems.length - 1))
    }

    private scrollHighlightedItemIntoView (): void {
        setTimeout(() => {
            if (!this.filteredItems.length) {
                return
            }
            const highlightedItem = this.filteredItems[this.highlightedIndex]
            const item = this.tabList.nativeElement.querySelector<HTMLElement>(
                `#${this.getItemID(highlightedItem)}`,
            )
            item?.scrollIntoView({ block: 'nearest' })
        })
    }
}
