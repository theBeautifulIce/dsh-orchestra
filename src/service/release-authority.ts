/** Process-local proof for the dedicated release root entrypoint. Ordinary commands never receive it. */
export const releaseRunAuthority = Symbol('release-run-authority')
