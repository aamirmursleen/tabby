# Aamir's Tabby fork

## Workspace close and restoration

Closing the window or choosing Quit asks once: **Save sessions and close all tabs**, or **Cancel**. The workspace is saved before tabs are destroyed. A failed storage write leaves the window open and reports an error. Accepting the dialog enables startup restoration if it was turned off. The individual tab close button still asks for confirmation.

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

The local ARM64 build is installed separately as **Tabby Custom.app**. Quit the old Tabby yourself when ready, then open the custom app. Both use the existing Tabby profile, so do not run both against that profile simultaneously. Keep the original app as a rollback option. The first switch can only restore information that the old version actually saved; exact UUID recovery applies to sessions saved by this fork.

This local development build is ad-hoc signed, not notarized, and does not enable Apple's hardened runtime: ad-hoc signatures have no Developer Team ID for library validation. Electron's configured security fuses remain enabled. A hardened, notarized distribution build requires a valid Apple Developer ID certificate. Update from this fork; an upstream stock-app update would not include these customizations.
