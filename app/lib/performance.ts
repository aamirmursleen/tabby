/**
 * Chromium keeps JavaScript UI work on one event-loop thread. Rasterization is
 * the part of rendering that can be spread across worker threads, so keep that
 * worker pool explicit for the terminal's multi-pane workload.
 */
export const CHROMIUM_RASTER_THREAD_COUNT = 6

export function configureChromiumPerformance (appendSwitch: (name: string, value: string) => void): void {
    appendSwitch('num-raster-threads', String(CHROMIUM_RASTER_THREAD_COUNT))
}
