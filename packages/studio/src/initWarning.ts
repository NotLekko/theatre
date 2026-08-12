export const STUDIO_NOT_INITIALIZED_MESSAGE = `You seem to have imported '@theatre/studio' but haven't initialized it. You can initialize the studio by:
\`\`\`
import theatre from '@theatre/core'
theatre.init({studio: true})
\`\`\`

* If you didn't mean to import '@theatre/studio', this means that your bundler is not tree-shaking it. This is most likely a bundler misconfiguration.

* If you meant to import '@theatre/studio' without showing its UI, you can do that by running:

\`\`\`
import theatre from '@theatre/core'
theatre.init({studio: true})
studio.ui.hide()
\`\`\`
`

export const STUDIO_INITIALIZED_LATE_MSG = `You seem to have imported '@theatre/studio' but called \`studio.initialize()\` after some delay.
Theatre.js projects remain in pending mode (won't play their sequences) until the studio is initialized, so you should place the \`studio.initialize()\` line right after the import line:

\`\`\`
import theatre from '@theatre/core'
// ... and other imports

studio.initialize()
\`\`\`
`

export class InitWarning {
  private _initializeFnCalled = false
  private _didWarnAboutNotInitializing = false
  private _timer: ReturnType<typeof setTimeout> | undefined

  startTimer() {
    this._timer = setTimeout(() => {
      if (!this._initializeFnCalled) {
        console.warn(STUDIO_NOT_INITIALIZED_MESSAGE)
        this._didWarnAboutNotInitializing = true
      }
    }, 5000)
  }

  markInitialized(): boolean {
    if (this._initializeFnCalled) return false
    this._initializeFnCalled = true

    if (this._timer !== undefined) {
      clearTimeout(this._timer)
      this._timer = undefined
    }

    if (this._didWarnAboutNotInitializing) {
      console.warn(STUDIO_INITIALIZED_LATE_MSG)
    }

    return true
  }

  get wasCalledBefore(): boolean {
    return this._initializeFnCalled
  }

  get didWarn(): boolean {
    return this._didWarnAboutNotInitializing
  }
}
