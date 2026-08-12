import {
  InitWarning,
  STUDIO_NOT_INITIALIZED_MESSAGE,
  STUDIO_INITIALIZED_LATE_MSG,
} from './initWarning'

describe('InitWarning', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  test('warns if initialize is not called within the timeout', () => {
    const w = new InitWarning()
    w.startTimer()

    expect(console.warn).not.toHaveBeenCalled()

    jest.advanceTimersByTime(5001)

    expect(console.warn).toHaveBeenCalledWith(STUDIO_NOT_INITIALIZED_MESSAGE)
    expect(w.didWarn).toBe(true)
  })

  test('does not warn if markInitialized() is called before timeout', () => {
    const w = new InitWarning()
    w.startTimer()

    w.markInitialized()

    jest.advanceTimersByTime(5001)

    expect(console.warn).not.toHaveBeenCalled()
    expect(w.didWarn).toBe(false)
  })

  test('clears the timer on markInitialized()', () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout')
    const w = new InitWarning()
    w.startTimer()

    w.markInitialized()

    expect(clearSpy).toHaveBeenCalled()
  })

  test('emits late-init warning if markInitialized() called after timeout', () => {
    const w = new InitWarning()
    w.startTimer()

    jest.advanceTimersByTime(5001)
    expect(console.warn).toHaveBeenCalledWith(STUDIO_NOT_INITIALIZED_MESSAGE)
    ;(console.warn as jest.Mock).mockClear()

    w.markInitialized()

    expect(console.warn).toHaveBeenCalledWith(STUDIO_INITIALIZED_LATE_MSG)
  })

  test('markInitialized() returns false on second call', () => {
    const w = new InitWarning()
    expect(w.markInitialized()).toBe(true)
    expect(w.markInitialized()).toBe(false)
  })
})
