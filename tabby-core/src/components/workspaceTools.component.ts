import { Component, EventEmitter, Output, HostListener } from '@angular/core'
import { v4 as uuid } from 'uuid'
import { AppService } from '../services/app.service'
import { WorkspaceEntry, WorkspaceSnippetGroup, WorkspaceTerminal, WorkspaceToolsService } from '../services/workspaceTools.service'
import { BaseTabComponent } from './baseTab.component'
import { SplitTabComponent } from './splitTab.component'
import { getOpenTabLabel } from '../utils/openTabs'

interface SnippetSection {
    id: string
    name: string
    entries: WorkspaceEntry[]
}

@Component({
    selector: 'workspace-tools',
    templateUrl: './workspaceTools.component.pug',
    styleUrls: ['./workspaceTools.component.scss'],
})
export class WorkspaceToolsComponent {
    @Output() closed = new EventEmitter<void>()
    query = ''
    sort: 'name-asc'|'name-desc'|'updated'|'newest' = 'name-asc'
    editorTitle = 'New snippet'
    draft: WorkspaceEntry|null = null
    groupDraft: WorkspaceSnippetGroup|null = null
    deleting: string|null = null
    deletingGroup: string|null = null
    busy = false
    error = ''
    status = ''
    private collapsed = new Set<string>()

    constructor (public tools: WorkspaceToolsService, private app: AppService) { }

    @HostListener('keydown', ['$event'])
    @HostListener('keyup', ['$event'])
    protectEditorKeys (event: KeyboardEvent): void {
        // Keep native editor shortcuts from also reaching the active terminal.
        event.stopPropagation()
    }

    close (): void {
        this.closed.emit()
        this.target?.emitFocused()
    }

    get groups (): WorkspaceSnippetGroup[] {
        return [...this.tools.groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    }

    get snippetCount (): number { return this.tools.entries.filter(x => x.kind === 'snippet').length }

    get entries (): WorkspaceEntry[] {
        const terms = this.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
        const names = new Map(this.tools.groups.map(x => [x.id, x.name]))
        return this.tools.entries.filter(x => x.kind === 'snippet' && terms.every(term =>
            `${x.title}\n${x.body}\n${names.get(x.groupId ?? '') ?? ''}`.toLocaleLowerCase().includes(term),
        )).sort((a, b) => {
            const byName = a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
            switch (this.sort) {
                case 'name-desc': return -byName
                case 'newest': return (b.createdAt ?? 0) - (a.createdAt ?? 0) || byName
                case 'updated': return (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || byName
                default: return byName
            }
        })
    }

    get sections (): SnippetSection[] {
        const entries = this.entries
        const groups = this.groups
        const ids = new Set(groups.map(x => x.id))
        const ungrouped = entries.filter(x => !x.groupId || !ids.has(x.groupId))
        const sections: SnippetSection[] = groups.map(g => ({ ...g, entries: entries.filter(x => x.groupId === g.id) }))
        if (ungrouped.length) {
            sections.push({ id: '', name: 'Ungrouped', entries: ungrouped })
        }
        return this.query.trim() ? sections.filter(x => x.entries.length) : sections
    }

    get sortLabel (): string {
        return { 'name-asc': 'Name: A–Z', 'name-desc': 'Name: Z–A', updated: 'Recently updated', newest: 'Newest first' }[this.sort]
    }

    get target (): (BaseTabComponent & WorkspaceTerminal)|null {
        const active = this.app.activeTab
        const tab = active instanceof SplitTabComponent ? active.getFocusedTab() : active
        return tab && typeof (tab as Partial<WorkspaceTerminal>).sendInput === 'function'
            ? tab as BaseTabComponent & WorkspaceTerminal : null
    }

    get targetName (): string { return this.target ? getOpenTabLabel(this.target, 0) : 'Select a terminal' }

    trackByID (_index: number, item: { id: string }): string { return item.id }

    toggleGroup (id: string): void {
        if (this.collapsed.has(id)) {
            this.collapsed.delete(id)
        } else {
            this.collapsed.add(id)
        }
    }

    isExpanded (id: string): boolean { return !!this.query.trim() || !this.collapsed.has(id) }

    edit (entry?: WorkspaceEntry, groupID = ''): void {
        if (this.busy || this.groupDraft) { return }
        this.editorTitle = entry ? 'Edit snippet' : 'New snippet'
        this.draft = entry ? { ...entry, groupId: entry.groupId ?? '' }
            : { id: uuid(), kind: 'snippet', title: '', body: '', groupId: groupID }
        this.error = ''
        this.status = ''
        this.deleting = null
        this.deletingGroup = null
    }

    async save (): Promise<void> {
        if (!this.draft || this.busy) { return }
        this.busy = true
        this.error = ''
        try {
            await this.tools.saveEntry(this.draft)
            this.collapsed.delete(this.draft.groupId ?? '')
            this.draft = null
            this.query = ''
            this.status = 'Snippet saved'
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not save. Please retry.'
        } finally { this.busy = false }
    }

    async remove (entry: WorkspaceEntry): Promise<void> {
        if (this.busy) { return }
        this.busy = true
        this.error = ''
        try {
            await this.tools.deleteEntry(entry.id)
            this.deleting = null
            this.status = 'Snippet deleted'
        } catch {
            this.error = 'Could not delete. Please retry.'
        } finally { this.busy = false }
    }

    editGroup (group?: WorkspaceSnippetGroup): void {
        if (this.busy || this.draft) { return }
        this.groupDraft = group ? { id: group.id, name: group.name } : { id: uuid(), name: '' }
        this.error = ''
        this.status = ''
        this.deletingGroup = null
    }

    async saveGroup (): Promise<void> {
        if (!this.groupDraft || this.busy) { return }
        this.busy = true
        this.error = ''
        try {
            await this.tools.saveGroup(this.groupDraft)
            this.collapsed.delete(this.groupDraft.id)
            this.groupDraft = null
            this.query = ''
            this.status = 'Group saved'
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not save group. Please retry.'
        } finally { this.busy = false }
    }

    async removeGroup (id: string): Promise<void> {
        if (this.busy) { return }
        this.busy = true
        this.error = ''
        try {
            await this.tools.deleteGroup(id)
            this.deletingGroup = null
            this.collapsed.delete('')
            this.status = 'Group deleted. Snippets moved to Ungrouped.'
        } catch {
            this.error = 'Could not delete group. Please retry.'
        } finally { this.busy = false }
    }

    run (entry: WorkspaceEntry): void { this.send(entry, true) }

    paste (entry: WorkspaceEntry): void { this.send(entry, false) }

    private send (entry: WorkspaceEntry, execute: boolean): void {
        this.error = ''
        this.status = ''
        const target = this.target
        try {
            if (execute) {
                this.tools.run(entry, target)
            } else {
                this.tools.paste(entry, target)
            }
            this.status = `${execute ? 'Sent' : 'Pasted'} to ${this.targetName}`
            target?.emitFocused()
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not send command.'
        }
    }
}
