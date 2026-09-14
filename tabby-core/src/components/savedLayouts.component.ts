import { Component, EventEmitter, HostListener, Output } from '@angular/core'
import { SavedLayoutProfile, SplitLayoutProfilesService } from '../profiles'
import { AppService } from '../services/app.service'
import { BaseTabComponent } from './baseTab.component'
import { RecoveryToken } from '../api/tabRecovery'

interface LayoutPreviewPane {
    name: string
    x: number
    y: number
    width: number
    height: number
}

interface LayoutEditor {
    name: string
    id?: string
    sourceTab?: BaseTabComponent
}

@Component({
    selector: 'saved-layouts',
    templateUrl: './savedLayouts.component.pug',
    styleUrls: ['./workspaceTools.component.scss', './savedLayouts.component.scss'],
})
export class SavedLayoutsComponent {
    @Output() closed = new EventEmitter<void>()
    query = ''
    editor: LayoutEditor|null = null
    deleting: SavedLayoutProfile|null = null
    busy = false
    error = ''
    status = ''

    constructor (public layouts: SplitLayoutProfilesService, public app: AppService) { }

    @HostListener('keydown', ['$event'])
    @HostListener('keyup', ['$event'])
    protectEditorKeys (event: KeyboardEvent): void { event.stopPropagation() }

    get entries (): SavedLayoutProfile[] {
        const query = this.query.trim().toLocaleLowerCase()
        return this.layouts.savedLayouts.filter(layout => `${layout.name} ${this.preview(layout).map(x => x.name).join(' ')}`.toLocaleLowerCase().includes(query))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    }

    get currentTabName (): string {
        const tab = this.app.activeTab
        if (tab?.customTitle) { return tab.customTitle }
        if (tab?.title) { return tab.title }
        return 'Current tab'
    }

    trackByID (_index: number, layout: SavedLayoutProfile): string { return layout.id }

    trackPane (index: number): number { return index }

    close (): void {
        this.closed.emit()
        this.app.activeTab?.emitFocused()
    }

    startSave (replace?: SavedLayoutProfile): void {
        if (this.busy || !this.app.activeTab) { return }
        this.editor = { name: replace?.name ?? this.currentTabName.slice(0, 100), id: replace?.id, sourceTab: this.app.activeTab }
        this.deleting = null
        this.error = ''
        this.status = ''
    }

    rename (layout: SavedLayoutProfile): void {
        if (this.busy) { return }
        this.editor = { name: layout.name, id: layout.id }
        this.deleting = null
        this.error = ''
    }

    async save (): Promise<void> {
        const draft = this.editor
        if (!draft || this.busy) { return }
        await this.perform(async () => {
            if (draft.sourceTab) {
                if (!this.app.tabs.includes(draft.sourceTab)) {
                    throw new Error('The tab selected for saving has closed. Select another tab and try again.')
                }
                await this.layouts.createProfile(draft.sourceTab, draft.name, draft.id)
            } else if (draft.id) {
                await this.layouts.renameLayout(draft.id, draft.name)
            }
            this.editor = null
            this.query = ''
            this.status = 'Layout saved'
        })
    }

    async open (layout: SavedLayoutProfile): Promise<void> {
        if (this.busy) { return }
        await this.perform(async () => {
            const params = await this.layouts.getNewTabParameters(layout)
            this.app.openNewTab(params)
            this.status = `Opened ${layout.name}`
        })
    }

    async remove (): Promise<void> {
        const layout = this.deleting
        if (!layout || this.busy) { return }
        await this.perform(async () => {
            await this.layouts.deleteLayout(layout.id)
            this.deleting = null
            this.status = 'Layout deleted'
        })
    }

    preview (layout: SavedLayoutProfile): LayoutPreviewPane[] {
        const panes: LayoutPreviewPane[] = []
        const walk = (token: RecoveryToken, x: number, y: number, width: number, height: number): void => {
            if (token.type !== 'app:split-tab') {
                panes.push({ name: token.tabCustomTitle || token.profile?.name || token.tabTitle || 'Terminal', x, y, width, height })
                return
            }
            const total = token.ratios.reduce((sum: number, ratio: number) => sum + ratio, 0)
            let offset = 0
            token.children.forEach((child: RecoveryToken, index: number) => {
                const ratio = token.ratios[index] / total
                if (token.orientation === 'h') {
                    walk(child, x + width * offset, y, width * ratio, height)
                } else {
                    walk(child, x, y + height * offset, width, height * ratio)
                }
                offset += ratio
            })
        }
        walk(layout.options.recoveryToken, 0, 0, 100, 100)
        return panes
    }

    private async perform (operation: () => Promise<void>): Promise<void> {
        this.busy = true
        this.error = ''
        this.status = ''
        try { await operation() } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not complete this action. Please retry.'
        } finally { this.busy = false }
    }
}
