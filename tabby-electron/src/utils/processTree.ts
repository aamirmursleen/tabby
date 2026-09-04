export interface ProcessTreeEntry {
    pid: number
    ppid: number
}

export function getDescendantProcesses<T extends ProcessTreeEntry> (processes: readonly T[], rootPID: number): T[] {
    const descendants: T[] = []
    const discoveredPIDs = new Set([rootPID])
    let foundProcess = true

    while (foundProcess) {
        foundProcess = false
        for (const process of processes) {
            if (!discoveredPIDs.has(process.pid) && discoveredPIDs.has(process.ppid)) {
                descendants.push(process)
                discoveredPIDs.add(process.pid)
                foundProcess = true
            }
        }
    }

    return descendants
}

export function getTerminalProcessTree<T extends ProcessTreeEntry> (
    processes: readonly T[],
    terminalPID: number,
    processTreeRootPID: number,
): T[] {
    const descendants = getDescendantProcesses(processes, processTreeRootPID)
    if (processTreeRootPID === terminalPID) {
        return descendants
    }
    const root = processes.find(process => process.pid === processTreeRootPID)
    return root ? [root, ...descendants] : descendants
}
