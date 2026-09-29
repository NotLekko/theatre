export interface Reminder {
  id: string;
  message: string;
  dueAt: Date;
}

/** In-process reminders. They fire while JARVIS is running and are lost when it exits. */
export class Reminders {
  #pending = new Map<string, { reminder: Reminder; timer: NodeJS.Timeout }>();
  #nextId = 1;
  #onFire: (reminder: Reminder) => void;

  constructor(onFire: (reminder: Reminder) => void) {
    this.#onFire = onFire;
  }

  add(message: string, delayMs: number): Reminder {
    const reminder: Reminder = { id: `r${this.#nextId++}`, message, dueAt: new Date(Date.now() + delayMs) };
    const timer = setTimeout(() => {
      this.#pending.delete(reminder.id);
      this.#onFire(reminder);
    }, delayMs);
    // A pending reminder shouldn't keep the process alive once the user has left.
    timer.unref();
    this.#pending.set(reminder.id, { reminder, timer });
    return reminder;
  }

  list(): Reminder[] {
    return [...this.#pending.values()]
      .map(({ reminder }) => reminder)
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  }

  cancel(id: string): Reminder | undefined {
    const entry = this.#pending.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.#pending.delete(id);
    return entry.reminder;
  }

  cancelAll(): void {
    for (const { timer } of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
  }
}
