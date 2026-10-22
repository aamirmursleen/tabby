/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Input, HostListener, HostBinding, ViewChildren, ViewChild, ElementRef } from '@angular/core'
import { trigger, style, animate, transition, state } from '@angular/animations'
import { NgbDropdown, NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { CdkDragDrop } from '@angular/cdk/drag-drop'

import { HostAppService, Platform } from '../api/hostApp'
import { HotkeysService } from '../services/hotkeys.service'
import { Logger, LogService } from '../services/log.service'
import { ConfigService } from '../services/config.service'
import { ThemesService } from '../services/themes.service'
import { UpdaterService } from '../services/updater.service'
import { CommandService } from '../services/commands.service'

import { BaseTabComponent } from './baseTab.component'
import { SafeModeModalComponent } from './safeModeModal.component'
import { TabBodyComponent } from './tabBody.component'
import { SplitTabComponent } from './splitTab.component'
import { getOpenTabLabel } from '../utils/openTabs'
import { AppService, Command, CommandLocation, FileTransfer, HostWindowService, PlatformService } from '../api'

function makeTabAnimation (dimension: string, size: number) {
    return [
        state('in', style({
            'flex-basis': '{{size}}',
            [dimension]: '{{size}}',
        }), {
            params: { size: `${size}px` },
        }),
        transition(':enter', [
            style({
                'flex-basis': '1px',
                [dimension]: '1px',
            }),
            animate('250ms ease-out', style({
                'flex-basis': '{{size}}',
                [dimension]: '{{size}}',
            })),
        ]),
        transition(':leave', [
            style({
                'flex-basis': 'auto',
                'padding-left': '*',
                'padding-right': '*',
                [dimension]: '*',
            }),
            animate('250ms ease-in-out', style({
                'padding-left': 0,
                'padding-right': 0,
                [dimension]: '0',
            })),
        ]),
    ]
}

export function getTabStripWheelDelta (deltaX: number, deltaY: number, deltaMode: number, pageWidth: number): number {
    let delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY
    if (deltaMode === 1) {
        delta *= 60
    } else if (deltaMode === 2) {
        delta *= pageWidth
    } else {
        delta *= 2.5
    }
    return delta
}

export function getTabStripPageStep (pageWidth: number): number {
    return Math.max(600, Math.floor(pageWidth * 0.9))
}

export function getTabRevealDelays (animationsEnabled: boolean): number[] {
    return animationsEnabled ? [0, 300] : [0]
}

/** @hidden */
@Component({
    selector: 'app-root',
    templateUrl: './appRoot.component.pug',
    styleUrls: ['./appRoot.component.scss'],
    animations: [
        trigger('animateTab', makeTabAnimation('width', 200)),
    ],
})
export class AppRootComponent {
    Platform = Platform
    @Input() ready = false
    @Input() leftToolbarButtons: Command[]
    @Input() rightToolbarButtons: Command[]
    @HostBinding('class.platform-win32') platformClassWindows = process.platform === 'win32'
    @HostBinding('class.platform-darwin') platformClassMacOS = process.platform === 'darwin'
    @HostBinding('class.platform-linux') platformClassLinux = process.platform === 'linux'
    @HostBinding('class.no-tabs') noTabs = false
    @ViewChildren(TabBodyComponent) tabBodies: TabBodyComponent[]
    @ViewChild('activeTransfersDropdown') activeTransfersDropdown: NgbDropdown
    @ViewChild('openTabsDropdown') openTabsDropdown: NgbDropdown
    @ViewChild('tabsScroller') tabsScroller?: ElementRef<HTMLElement>
    unsortedTabs: BaseTabComponent[] = []
    updatesAvailable = false
    activeTransfers: FileTransfer[] = []
    workspaceToolsOpen = false
    savedLayoutsOpen = false
    openTabsMenuOpen = false
    activeSessionsOpen = true
    masterWorkspaceActive = true
    private logger: Logger

    constructor (
        private hotkeys: HotkeysService,
        private commands: CommandService,
        public updater: UpdaterService,
        public hostWindow: HostWindowService,
        public hostApp: HostAppService,
        public config: ConfigService,
        public app: AppService,
        platform: PlatformService,
        log: LogService,
        ngbModal: NgbModal,
        _themes: ThemesService,
    ) {
        // document.querySelector('app-root')?.remove()
        this.logger = log.create('main')
        this.logger.info('v', platform.getAppVersion())

        this.hotkeys.hotkey$.subscribe((hotkey: string) => {
            if (hotkey.startsWith('tab-')) {
                const index = parseInt(hotkey.split('-')[1])
                if (index === 1) {
                    this.selectMasterWorkspace()
                } else if (index - 1 <= this.app.tabs.length) {
                    this.selectAppTab(this.app.tabs[index - 2])
                }
            }
            if (this.app.activeTab && !this.masterWorkspaceActive) {
                if (hotkey === 'close-tab') {
                    this.app.closeTab(this.app.activeTab, true)
                }
                if (hotkey === 'toggle-last-tab') {
                    this.app.toggleLastTab()
                }
                if (hotkey === 'next-tab') {
                    this.app.nextTab()
                }
                if (hotkey === 'previous-tab') {
                    this.app.previousTab()
                }
                if (hotkey === 'move-tab-left') {
                    this.app.moveSelectedTabLeft()
                }
                if (hotkey === 'move-tab-right') {
                    this.app.moveSelectedTabRight()
                }
                if (hotkey === 'duplicate-tab') {
                    this.app.duplicateTab(this.app.activeTab)
                }
                if (hotkey === 'pin-tab') {
                    this.app.toggleTabPinned(this.app.activeTab)
                }
                if (hotkey === 'restart-tab') {
                    this.app.restartTab(this.app.activeTab)
                }
                if (hotkey === 'explode-tab' && this.app.activeTab instanceof SplitTabComponent) {
                    this.app.explodeTab(this.app.activeTab)
                }
                if (hotkey === 'combine-tabs' && this.app.activeTab instanceof SplitTabComponent) {
                    this.app.combineTabsInto(this.app.activeTab)
                }
            }
            if (this.masterWorkspaceActive && hotkey === 'next-tab' && this.app.tabs.length) {
                this.selectAppTab(this.app.tabs[0])
            }
            if (hotkey === 'reopen-tab') {
                this.app.reopenLastTab()
            }
            if (hotkey === 'toggle-fullscreen') {
                hostWindow.toggleFullscreen()
            }
        })

        this.hostWindow.windowCloseRequest$.subscribe(async () => {
            this.app.closeWindow()
        })

        if (window['safeModeReason']) {
            ngbModal.open(SafeModeModalComponent)
        }

        this.app.tabOpened$.subscribe(tab => {
            this.unsortedTabs.push(tab)
            this.noTabs = false
            this.app.emitTabDragEnded()
        })

        this.app.tabRemoved$.subscribe(tab => {
            for (const tabBody of this.tabBodies) {
                if (tabBody.tab === tab) {
                    tabBody.detach()
                }
            }
            this.unsortedTabs = this.unsortedTabs.filter(x => x !== tab)
            this.noTabs = false
            this.app.emitTabDragEnded()
        })

        this.app.activeTabChange$.subscribe(tab => {
            if (this.ready) {
                this.masterWorkspaceActive = !tab
            }
            const animationsEnabled = this.config.store?.accessibility?.animations !== false
            for (const delay of getTabRevealDelays(animationsEnabled)) {
                window.setTimeout(() => this.revealActiveTab(), delay)
            }
        })

        platform.fileTransferStarted$.subscribe(transfer => {
            this.activeTransfers.push(transfer)
            this.activeTransfersDropdown.open()
        })

        config.ready$.toPromise().then(async () => {
            this.activeSessionsOpen = this.config.store.showActiveSessions !== false
            this.leftToolbarButtons = await this.getToolbarButtons(false)
            this.rightToolbarButtons = await this.getToolbarButtons(true)

            setInterval(() => {
                if (this.config.store.enableAutomaticUpdates) {
                    this.updater.check().then(available => {
                        this.updatesAvailable = available
                    })
                }
            }, 3600 * 12 * 1000)
        })
    }

    async ngOnInit () {
        this.config.ready$.toPromise().then(() => {
            this.ready = true
            this.masterWorkspaceActive = true
            this.app.emitReady()
        })

        // While the window is being dragged, suppress the split-pane layout
        // transition (see splitTab.component.scss). Animating pane geometry on
        // every resize frame triggers a full-layer repaint that flickers the
        // terminal; the transition is only wanted for split/close/maximize.
        let resizeEndTimeout: any = null
        window.addEventListener('resize', () => {
            document.body.classList.add('resizing')
            if (resizeEndTimeout) {
                clearTimeout(resizeEndTimeout)
            }
            resizeEndTimeout = setTimeout(() => {
                document.body.classList.remove('resizing')
            }, 200)
        })
    }

    @HostListener('dragover')
    onDragOver () {
        return false
    }

    @HostListener('drop')
    onDrop () {
        return false
    }

    hasVerticalTabs () {
        return this.config.store.appearance.tabsLocation === 'left' || this.config.store.appearance.tabsLocation === 'right'
    }

    get targetTabSize (): any {
        if (this.hasVerticalTabs()) {
            return '*'
        }
        return this.config.store.appearance.flexTabs ? '*' : '200px'
    }

    onTabsReordered (event: CdkDragDrop<BaseTabComponent[]>) {
        const tab: BaseTabComponent = event.item.data
        if (!this.app.tabs.includes(tab)) {
            if (tab.parent instanceof SplitTabComponent) {
                tab.parent.removeTab(tab)
                this.app.wrapAndAddTab(tab)
            }
        }
        this.app.moveTabToIndex(tab, event.currentIndex)
    }

    scrollTabs (direction: number): void {
        const scroller = this.tabsScroller?.nativeElement
        if (!scroller || this.hasVerticalTabs()) {
            return
        }
        scroller.scrollBy({
            left: direction * getTabStripPageStep(scroller.clientWidth),
            behavior: 'smooth',
        })
    }

    getTabLabel (tab: BaseTabComponent, index: number): string {
        return getOpenTabLabel(tab, index)
    }

    onTabsWheel (event: WheelEvent): void {
        const scroller = this.tabsScroller?.nativeElement
        if (!scroller || this.hasVerticalTabs() || scroller.scrollWidth <= scroller.clientWidth) {
            return
        }
        const delta = getTabStripWheelDelta(event.deltaX, event.deltaY, event.deltaMode, scroller.clientWidth)
        if (delta) {
            scroller.scrollLeft += delta
            event.preventDefault()
        }
    }

    onTransfersChange () {
        if (this.activeTransfers.length === 0) {
            this.activeTransfersDropdown.close()
        }
    }

    onOpenTabsOpenChange (open: boolean): void {
        this.openTabsMenuOpen = open
    }

    onOpenTabSelected (tab: BaseTabComponent): void {
        this.openTabsDropdown.close()
        this.selectAppTab(tab)
    }

    selectMasterWorkspace (): void {
        if (this.app.activeTab) {
            this.app.selectTab(null, false)
        }
        this.masterWorkspaceActive = true
        this.hostWindow.setTitle('Master Workspace — Aamir Terminal')
        window.setTimeout(() => this.revealActiveTab())
    }

    selectAppTab (tab: BaseTabComponent): void {
        this.masterWorkspaceActive = false
        this.app.selectTab(tab)
    }

    showActiveTerminal (): void {
        if (this.app.activeTab) {
            this.masterWorkspaceActive = false
        }
    }

    openConnectionsPanel (): void {
        this.setActiveSessionsOpen(true)
    }

    openSnippetsPanel (): void {
        this.workspaceToolsOpen = true
        this.savedLayoutsOpen = false
    }

    toggleActiveSessions (): void {
        this.setActiveSessionsOpen(!this.activeSessionsOpen)
    }

    setActiveSessionsOpen (open: boolean): void {
        const previous = this.activeSessionsOpen
        this.activeSessionsOpen = open
        this.config.store.showActiveSessions = this.activeSessionsOpen
        this.config.save().catch(error => {
            this.logger.warn('Could not save active sessions panel state:', error)
            this.activeSessionsOpen = previous
            this.config.store.showActiveSessions = previous
        })
    }

    @HostBinding('class.vibrant') get isVibrant () {
        return this.config.store?.appearance.vibrancy
    }

    private async getToolbarButtons (aboveZero: boolean): Promise<Command[]> {
        return (await this.commands.getCommands({ tab: this.app.activeTab ?? undefined }))
            .filter(x => x.locations?.includes(aboveZero ? CommandLocation.RightToolbar : CommandLocation.LeftToolbar))
    }

    toggleMaximize (): void {
        this.hostWindow.toggleMaximize()
    }

    protected isTitleBarNeeded (): boolean {
        return (
            this.config.store.appearance.frame === 'full'
            ||
                this.hostApp.platform !== Platform.macOS
                && this.config.store.appearance.frame === 'thin'
                && this.config.store.appearance.tabsLocation !== 'top'
                && this.config.store.appearance.tabsLocation !== 'bottom'
        )
    }

    private revealActiveTab (): void {
        const activeHeader = this.tabsScroller?.nativeElement.querySelector<HTMLElement>('.master-workspace-tab.active, tab-header.active')
        activeHeader?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
}
