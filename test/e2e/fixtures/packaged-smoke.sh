#!/bin/sh
set -eu
: "${TABBY_PACKAGED_SMOKE_PROFILE:?Test profile is required}"
printf 'PACKAGED_ARM64_PTY_OK\n' > "$TABBY_PACKAGED_SMOKE_PROFILE/pty-output"
printf 'Packaged terminal smoke test passed.\n'
