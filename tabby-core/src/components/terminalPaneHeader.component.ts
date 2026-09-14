import { Component, Input, ViewChild, ElementRef } from '@angular/core'
import { BaseTabComponent } from './baseTab.component'
import { SplitTabComponent } from './splitTab.component'
import { AppService } from '../services/app.service'
import { getOpenTabLabel } from '../utils/openTabs'

@Component({
    selector: 'terminal-pane-header',
    template: `
        <div class="pane-name-bar" [class.focused]="tab.hasFocus" [style.border-left-color]="tab.color">
            <button *ngIf="!editing" class="pane-name" (click)="startRename(); $event.stopPropagation()"
                [title]="label + ' — click to rename'" aria-label="Rename pane">
                <i class="fas fa-terminal"></i><span>{{label}}</span><i class="fas fa-pencil-alt edit-icon"></i>
            </button>
            <input *ngIf="editing" #nameInput class="form-control form-control-sm" aria-label="Pane name"
                [(ngModel)]="draft" (keydown.enter)="save(); $event.stopPropagation()"
                (keydown.escape)="cancel(); $event.stopPropagation()" (blur)="save()"
                (click)="$event.stopPropagation()" maxlength="120">
            <button *ngIf="canMaximize" type="button" class="pane-expand" [class.expanded]="maximized"
                (click)="toggleMaximize(); $event.stopPropagation()" [attr.aria-pressed]="maximized"
                [attr.aria-label]="maximized ? 'Restore split layout' : 'Expand pane'"
                [title]="maximized ? 'Restore split layout (Esc)' : 'Expand pane'">
                <i class="fas" [class.fa-expand]="!maximized" [class.fa-compress]="maximized" aria-hidden="true"></i>
                <span *ngIf="maximized" aria-hidden="true">Esc</span>
            </button>
        </div>
    `,
    styleUrls: ['./terminalPaneHeader.component.scss'],
})
export class TerminalPaneHeaderComponent {
    @Input() tab: BaseTabComponent
    @ViewChild('nameInput') set nameInput (input: ElementRef<HTMLInputElement>|undefined) {
        input?.nativeElement.focus()
        input?.nativeElement.select()
    }

    editing = false
    draft = ''

    constructor (private app: AppService) { }

    get label (): string { return getOpenTabLabel(this.tab, 0) }

    get canMaximize (): boolean {
        return this.tab.parent instanceof SplitTabComponent && this.tab.parent.getAllTabs().length > 1
    }

    get maximized (): boolean {
        return this.tab.parent instanceof SplitTabComponent && this.tab.parent.getMaximizedTab() === this.tab
    }

    toggleMaximize (): void {
        const parent = this.tab.parent
        if (!(parent instanceof SplitTabComponent) || !this.canMaximize) {
            return
        }
        const restore = this.maximized
        parent.focus(this.tab)
        parent.maximize(restore ? null : this.tab)
    }

    startRename (): void {
        this.draft = this.label
        this.editing = true
    }

    save (): void {
        if (!this.editing) {
            return
        }
        this.tab.customTitle = this.draft.trim()
        this.editing = false
        this.app.emitTabsChanged()
    }

    cancel (): void { this.editing = false }
}
