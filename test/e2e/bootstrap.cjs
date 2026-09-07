'use strict'
// A separate Electron process/profile: never read the installed app's config,
// register its URL handler, or show native dialogs during automated tests.
const path = require('node:path')
const fs = require('node:fs')
const { app, dialog, globalShortcut } = require('electron')
if (!process.env.TABBY_E2E_PROFILE) { throw new Error('TABBY_E2E_PROFILE is required') }
app.setName('Tabby Regression Test')
app.setPath('userData', process.env.TABBY_E2E_PROFILE)
app.getAppPath = () => path.resolve(__dirname, '../../app')
app.setAsDefaultProtocolClient = () => false
globalShortcut.register = () => false
app.on('browser-window-created', (_event, window) => {
    // Exercise real DOM/GPU/PTY paths without stealing the user's keyboard focus.
    window.show = () => {}
    window.showInactive = () => {}
    window.focus = () => {}
    window.webContents.setBackgroundThrottling(false)
    window.setContentSize(1200, 800)
})
process.env.TABBY_CONFIG_DIRECTORY = process.env.TABBY_E2E_PROFILE
process.env.TABBY_DEV = '1'
// The development launcher path is not a script for Tabby's CLI to execute.
process.argv = [process.execPath]
const configPath = path.join(process.env.TABBY_E2E_PROFILE, 'config.yaml')
if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, 'version: 7\nenableWelcomeTab: false\nenableAnalytics: false\nenableAutomaticUpdates: false\n')
}
global.__testDialogs = []
global.__testDialogResponse = 1
dialog.showMessageBox = async (...args) => {
    global.__testDialogs.push(args.at(-1))
    fs.writeFileSync(path.join(process.env.TABBY_E2E_PROFILE, 'test-dialogs.json'), JSON.stringify(global.__testDialogs))
    return { response: global.__testDialogResponse, checkboxChecked: false }
}
dialog.showErrorBox = (title, content) => { console.error(title, content) }
require('../../app/dist/main.js')
