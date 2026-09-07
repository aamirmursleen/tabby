/** Share in-flight native scans and briefly reuse them across terminal tabs. */
export function createProcessListCache<T> (load: () => Promise<T>, maxAge = 100): () => Promise<T> {
    let cached: Promise<T>|null = null
    let expiresAt = 0
    let loading = false
    return () => {
        if (!cached || !loading && Date.now() >= expiresAt) {
            loading = true
            cached = Promise.resolve().then(load).then(result => {
                expiresAt = Date.now() + maxAge
                loading = false
                return result
            }, error => {
                loading = false
                cached = null
                throw error
            })
        }
        return cached
    }
}
