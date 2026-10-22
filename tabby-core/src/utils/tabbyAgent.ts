import type { PartialProfile, Profile } from '../api/profileProvider'

export const TABBY_AGENT_TITLE = 'AI Agent · Tabby'
export const TABBY_AGENT_CWD = '/Users/m.aamirmursleen/tabby'

/** A fixed profile keeps shell input out of the launcher and makes recovery deterministic. */
export function buildTabbyAgentProfile (): PartialProfile<Profile> {
    return {
        type: 'local',
        name: TABBY_AGENT_TITLE,
        disableDynamicTitle: true,
        behaviorOnSessionEnd: 'keep',
        options: {
            command: '/bin/zsh',
            args: [
                '-l',
                '-i',
                '-c',
                `exec codex --sandbox danger-full-access --ask-for-approval never --search --no-alt-screen -C ${TABBY_AGENT_CWD}`,
            ],
            cwd: TABBY_AGENT_CWD,
            env: {},
        },
    }
}
