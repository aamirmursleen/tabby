interface RenderingConfigStore {
    appearance?: {
        vibrancy?: boolean
    }
}

export function terminalAllowsTransparency (configStore: RenderingConfigStore): boolean {
    return configStore.appearance?.vibrancy === true
}
