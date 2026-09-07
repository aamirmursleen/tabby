export interface ProcessTreeEntry {
    pid: number
    ppid: number
}

export function getDescendantProcesses<T extends ProcessTreeEntry> (processes: readonly T[], rootPID: number): T[] {
    const descendants: T[] = []
    const discoveredPIDs = new Set([rootPID])
    const children = new Map<number, T[]>()
    for (const process of processes) {
        const siblings = children.get(process.ppid) ?? []
        siblings.push(process)
        children.set(process.ppid, siblings)
    }
    const parents = [rootPID]
    for (const parent of parents) {
        for (const child of children.get(parent) ?? []) {
            if (!discoveredPIDs.has(child.pid)) {
                descendants.push(child)
                discoveredPIDs.add(child.pid)
                parents.push(child.pid)
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
