# Aamir's Tabby fork

## Aamir Terminal application identity

The current custom app is installed as **Aamir Terminal.app**, with bundle identifier `com.aamirmursleen.terminal` and Electron package product name `Aamir Terminal`. Both identities differ from stock Tabby; changing only the `.app` filename did not separate the running instance or profile.

Its profile is `~/Library/Application Support/Aamir Terminal`. On 2026-09-14, the saved config and local/session storage were copied from the existing `tabby` profile without changing the original. This is a snapshot of saved state, not a transfer of running terminal processes. Subsequent profile changes are independent.

Build the ARM64 app using the dedicated configuration (compile the app/plugins first):

```sh
ditto tabby-core/dist builtin-plugins/tabby-core/dist
ditto tabby-terminal/dist builtin-plugins/tabby-terminal/dist
ditto tabby-ssh/dist builtin-plugins/tabby-ssh/dist
node node_modules/electron-builder/cli.js --config electron-builder.aamir.yml --mac --arm64 --dir
codesign --force --deep --sign - --options 0 'dist/aamir-terminal-arm64/mac-arm64/Aamir Terminal.app'
```

Refresh the staged core, terminal and SSH bundles with the commands above before packaging. The local build uses ad-hoc signing, as described below. Launch the installed build with:

```sh
open -a 'Aamir Terminal'
```

## Pane names and Snippets

Every terminal has a permanent name bar. Click to rename; Enter or clicking away saves, Escape cancels. Clearing the name restores the profile/live-title fallback. Pane names use existing workspace recovery storage.

Version `1.0.236-aamir.8` adds an **Expand pane** button beside the pencil in each split pane's name bar. It fills the terminal area; click **Restore split layout** or press **Esc** to return to the same pane positions and sizes. The existing macOS shortcut, **Command–Option–Enter**, uses the same view. A single pane already fills the area and does not show an expansion button.

Expansion keeps the live tabs and split proportions. Escape is captured before terminal input only while expanded; ordinary terminal Escape, rename cancellation, and editor shortcuts remain available. Closing an expanded pane reveals and focuses a remaining terminal. Resizing the app while expanded preserves the split proportions when restored.

Verification: 155 regression tests, core/terminal TypeScript, core lint and webpack. `test/integration/paneMaximize.cjs` mounts the actual Angular header and split components with real xterm instances in isolated Chromium. It checks all four unequal panes, expand/restore clicks, Escape and key repeat without terminal input leakage, rename/sidebar isolation, terminal dimensions and restoration after window resize. The test uses synthetic output and opens no Electron app, shell, SSH session or user profile; live app interaction remains unverified.

```sh
TABBY_PLAYWRIGHT_PATH=/path/to/playwright node test/integration/paneMaximize.cjs
```

The **Snippets** toolbar button opens a compact sidebar inspired by Termius, with green Run/Paste actions and short command previews. Create snippets, assign them to groups, rename groups, collapse sections, and search by title, command text or group name. Sort commands by name A–Z/Z–A, newest first, or recently updated. Deleting a group moves its snippets to Ungrouped; deleting a snippet requires its own confirmation.

**Run** sends the saved command followed by Enter only to the selected pane's current program. **Paste** inserts without Enter, using bracketed paste when available; multiline paste is rejected if the destination cannot handle it without execution. The editor isolates keyboard shortcuts from terminal shortcuts. Saving or restoring a snippet never runs it automatically.

Entries stay in the existing `workspaceNotes` configuration field, with groups in `workspaceSnippetGroups`. Earlier note records remain stored but are not displayed or made runnable by the Snippets-only interface. Writes are serialized; failed saves preserve existing records and drafts. Malformed imported records are preserved and produce repair feedback instead of crashing or being silently deleted.

Verification: regression tests, core TypeScript/lint, Pug/SCSS compilation, and a static browser design preview. `test/e2e/workspaceTools.cjs` covers grouped snippets and restart flows but was not run for this revision because live app control is blocked.

Version `1.0.236-aamir.4` fixes the Snippets startup crash: literal brace icons are HTML-escaped so Angular does not interpret them as ICU messages. `tabby-core/test/templates.test.cjs` now runs every core Pug component through Angular's real JIT compiler, including the SVG loader used by the build. This check reproduced the startup failure before the fix; all 112 regression tests pass afterward. Template compilation does not replace a live app interaction test.

## SSH key passphrases

Version `1.0.236-aamir.11` adds the missing direct paste flow inside each SSH profile's Private keys section. The profile editor now has **Paste and save key**, which opens a private-key textarea, saves the pasted key into the reusable key library, and immediately attaches it to the current server. The default key name comes from the profile name so a pasted key can be saved and used without visiting the separate SSH settings page.

Version `1.0.236-aamir.10` adds a reusable SSH key library in SSH settings. Private keys can be pasted, imported from a file, or generated as ED25519/RSA keys. The private-key body is saved as a local `0600` file beside the Aamir Terminal config, while `config.yaml` stores only metadata such as label, algorithm, fingerprint and public key. SSH profiles can select saved keys by name and keep existing file-based private-key references for backward compatibility.

Saved key references use the `ssh-key://` file-provider prefix, so existing SSH authentication and WinSCP conversion paths can load them like other private-key files. Public `.pub` lookups return the stored public key when available, which keeps agent-identity probing compatible. Deleting a saved key removes its metadata and private-key file. Passphrases for encrypted saved keys continue to use the existing private-key passphrase flow below.

Verification: 170 regression tests, SSH TypeScript, SSH lint with an expanded Node heap, webpack, and focused key-library tests. Tests cover pasted-key validation, generated ED25519 auth parsing, `0600` storage, no raw private key in config, duplicate-name rejection, failed metadata rollback, delete cleanup, file-provider retrieval, profile attachment of saved keys, and direct profile paste/save. No real user SSH keys or live servers are used in tests.

Version `1.0.236-aamir.5` shares one private-key unlock operation across concurrent connections using the same key in a window. Existing Tabby passphrase identifiers remain compatible. The in-flight operation is removed after success, failure or cancellation; no permanent in-memory passphrase cache is added.

Remembered passphrases are saved only after successful key parsing, and the unlock waits for the credential-storage write. Incorrect input and cancelled prompts no longer delete saved passphrases. Cancel also settles concurrent requests instead of reopening the prompt. Storage-access and save failures produce feedback while allowing manual unlocking. Encrypted PKCS8 PEM keys use the correct native decoder and recognize incorrect-passphrase errors. Profiles restricted to keys or an agent skip unrelated server-password lookups.

macOS can separately request permission for Aamir Terminal Helper (Renderer) to access a saved `ssh-private-key` item. This dialog asks for the login keychain password, not the SSH key passphrase. **Always Allow** remembers permission for the requesting app; **Allow** grants one access. An update to this ad-hoc-signed build can trigger authorization again when its signature changes. The passphrase fixes do not remove this signing limitation.

Verification: 128 regression tests, SSH TypeScript and lint, and native parsing tests with generated encrypted OpenSSH and PKCS8 keys. Tests cover four concurrent unlocks, credential reload, wrong input, cancellation and storage failures. Credential storage and dialogs use test doubles; no live server authentication or real passphrase extraction was performed.

## Rendering when opening another window

Version `1.0.236-aamir.6` repairs terminal glyph recovery when another window takes focus. Visible panes can recover lost WebGL contexts without keyboard focus; automatic context restoration and focus handoffs also refresh the glyph cache. Atlas clears are batched before all pane models are rebuilt, avoiding the shared-cache corruption documented in [xterm.js #6014](https://github.com/xtermjs/xterm.js/issues/6014). A failed WebGL allocation leaves xterm's fallback renderer usable, with bounded retries. Recovery changes rendering only; it preserves the terminal buffer, scroll position and selection.

Verification: all 136 regression tests, terminal TypeScript/lint and webpack pass. `test/integration/renderer.cjs` runs the actual installed xterm/WebGL libraries in an isolated Chromium test with four panes and a second page. It forces real WebGL context loss and restoration and checks glyph pixels before/after; the original code fails the unfocused recovery case and the fix passes all cases. The test opens no Electron app, shell, SSH connection or user profile. Physical multi-monitor app interaction remains unverified.

```sh
TABBY_PLAYWRIGHT_PATH=/path/to/playwright node test/integration/renderer.cjs
```

## Keyboard focus and window isolation

Version `1.0.236-aamir.9` scopes opacity, title-bar control positioning and drag-vibrancy messages to the sending window. IPC and updater listeners are removed when a window closes, including a window closed before renderer readiness. This fixes the recorded `setOpacity` / `setWindowButtonPosition` null-window exceptions. A new window no longer raises and refocuses every existing window when it finishes loading.

Native activation restores Chromium keyboard focus when needed, while preserving DevTools focus and disabled modal parents. Deferred xterm focus requests recheck pane visibility, activity and lifetime. Password dialogs and other editors keep their input instead of a background terminal taking focus during window activation.

Verification: 163 regression tests, main/terminal TypeScript and lint, and both webpack builds pass. `test/integration/inputFocus.cjs` exercises the actual AppService activation handler, ng-bootstrap password component and xterm keyboard input in isolated Chromium. The old code fails the editor-focus case; the fix preserves editor/password input, restores input to the selected pane after a second-page handoff and modal dismissal, and discards inactive-pane requests. Native APIs use event-emitter doubles in the window lifecycle tests. Live macOS window and Keychain interaction remain unverified because desktop app control is blocked.

This version does not change saved credentials or Keychain permissions. An SSH private-key passphrase, Tabby's optional vault passphrase and macOS authorization are separate prompts; the exact dialog text is needed to distinguish them. Stock Tabby uses keytar / macOS Keychain by default or its optional vault; Termius documents an encrypted vault. The ad-hoc signing limitation above still applies after app updates.

```sh
TABBY_PLAYWRIGHT_PATH=/path/to/playwright node test/integration/inputFocus.cjs
```

## Saved tab layouts

Version `1.0.236-aamir.7` adds **Saved layouts** immediately beside **Snippets** in the toolbar. Arrange a tab, choose **Save current tab**, name it, and save. Each card previews the actual split proportions and has Open, Rename, Replace with current tab, and Delete actions. Search matches layout and pane names. Opening creates a new tab without closing current terminals.

Layouts use the existing `split-layout` profile format and remain available through the profile picker. Saves preserve nested splits, pane names, colors, local folders and the focused pane. Snapshot arrays are cloned so later resizing and repeated opens cannot alter the saved layout. Writes are serialized and rolled back on failure; invalid imported layouts remain stored with repair feedback. Pane providers are checked before opening.

Layouts reconnect terminals using their profile settings; terminal output, live PTY IDs and running commands are excluded. Passwords and passphrases are omitted from the layout snapshot and are resolved from the current connection profile or existing credential storage when reopened.

Verification: 148 regression tests, core/terminal TypeScript and lint, Angular template compilation, and webpack. The actual split recovery code reproduces four unequal pane positions in a regression test. An isolated Chromium test mounts the real Angular Saved layouts component and exercises save, open, rename, replace, search, reload, delete and failed-save preservation, including the preview's click behavior and keyboard isolation. Its app/recovery adapters are test doubles, so it does not authenticate to live servers.

```sh
TABBY_PLAYWRIGHT_PATH=/path/to/playwright node test/integration/savedLayouts.cjs
```

## Workspace close and restoration

Closing the window or choosing Quit asks once: **Close program (restore sessions)**, **Close all terminals (no restore)**, or **Cancel**. The default saves the workspace before terminals close and enables startup restoration if necessary. The no-restore choice drains pending autosaves and clears the saved workspace; cancellation and failed saves leave sessions intact. Secondary windows cannot erase the main window’s saved workspace. The individual tab close button still asks for confirmation.

Local restored tabs start their sessions even before you select them. Rendering remains lazy. Saved directories, titles, split layouts and supported recovery state use Tabby's existing recovery providers. Running processes do stop on exit; restoring terminal history is not a live process checkpoint. Arbitrary commands are not automatically replayed.

On macOS, running Codex CLI processes are matched to their open session metadata files. The exact session UUID and directory are saved, avoiding the wrong session when multiple tabs share a folder. Restoration runs through the interactive shell instead of injecting text after a timer. Supported shells: zsh, bash and sh without an existing `-c` command. Unidentified or old Codex tokens open the resume picker instead of guessing the latest session.

The requested command preserves the user's explicit unrestricted flags:

```sh
codex --sandbox danger-full-access --ask-for-approval never resume SESSION_UUID
```

These flags allow Codex to run without sandboxing or approval prompts. The recovery code accepts only this known command plus a validated UUID, not arbitrary stored command text.

The old `tabby-tab-list` customization plugin is skipped in this fork: its searchable tab switcher and confirmations are already built in, and its old recovery patch must not launch Codex a second time. Its installed files are left untouched.

## First performance and reliability patch set

- Local PTY output is acknowledged after the terminal parser consumes it, keeping fast producers from outrunning rendering. Exit is delivered after pending output, and exited PTYs are removed from the registry.
- Concurrent macOS process scans share one short-lived native lookup. Process-tree traversal indexes parent relationships once.
- Workspace saves are serialized and coalesced, with per-tab failure isolation and last-good tokens.
- OSC parsing avoids copying ordinary output and repeatedly concatenating fragmented escape sequences. Malformed OSC buffering is bounded.
- Unchanged font settings avoid redundant reflows; hidden panes skip layout work; renderer teardown unblocks pending writes.
- SFTP uploads use unique temporary files, cancellation checks, and a recoverable backup/rollback replacement path. The original destination is not deleted before replacement. This fallback is not an atomic-rename guarantee on every server.

This is still an ARM64 Electron application, not a native UI rewrite. Renderer pooling, a fully asynchronous recovery store, large-list virtualization, SSH output backpressure and full multi-window workspace persistence remain separate work. No Termius speed-parity claim has been measured.

## Verification

```sh
npm run test:regressions
npm run build:typings
```

Desktop integration (build desktop bundles and Electron native dependencies first; Playwright must be available):

```sh
TABBY_PLAYWRIGHT_PATH=/path/to/playwright node test/e2e/desktop.cjs
```

The desktop test creates a temporary profile, disables URL/global-hotkey registration, does not show its windows, and uses a harmless fake `codex` executable. It tests real PTY output above the flow-control window, native close cancellation, one close-all prompt, restart, folder/title restoration, background startup, exact resume arguments without duplicate launch, and macOS Quit/reopen. Screenshots are saved in the printed temporary profile directory. It never resumes a real Codex conversation or closes the installed Tabby instance.

The regression suite targets changed behavior; it is not a claim of 80% coverage across the whole application. SFTP failure paths are tested with an in-memory server double, not a production server.

A separate packaged-binary smoke test copies the built app into a temporary directory and uses Tabby's existing portable profile mode to launch a harmless shell:

```sh
node test/e2e/packaged.cjs 'dist/custom-arm64/mac-arm64/Tabby Custom.app'
```

## Mac build

The previous local ARM64 build was installed separately as **Tabby Custom.app**; it has been superseded by Aamir Terminal above. Quit the old Tabby yourself when ready, then open the custom app. Both use the existing Tabby profile, so do not run both against that profile simultaneously. Keep the original app as a rollback option. The first switch can only restore information that the old version actually saved; exact UUID recovery applies to sessions saved by this fork.

This local development build is ad-hoc signed, not notarized, and does not enable Apple's hardened runtime: ad-hoc signatures have no Developer Team ID for library validation. Electron's configured security fuses remain enabled. A hardened, notarized distribution build requires a valid Apple Developer ID certificate. Update from this fork; an upstream stock-app update would not include these customizations.
