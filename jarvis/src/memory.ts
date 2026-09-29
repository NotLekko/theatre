import fs from "node:fs";
import path from "node:path";

export interface Memory {
  id: string;
  fact: string;
  savedAt: string;
}

function isMemory(value: unknown): value is Memory {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.fact === "string" && typeof record.savedAt === "string";
}

/** Facts about the user that persist across sessions, stored as a small JSON file. */
export class MemoryStore {
  readonly file: string;
  #memories: Memory[];

  constructor(file: string) {
    this.file = file;
    this.#memories = MemoryStore.#read(file);
  }

  static #read(file: string): Memory[] {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // Refuse to start rather than overwrite a file the user may want to repair.
      throw new Error(`Memory file ${file} is not valid JSON. Fix or remove it and try again.`);
    }
    return Array.isArray(data) ? data.filter(isMemory) : [];
  }

  list(): Memory[] {
    return [...this.#memories];
  }

  add(fact: string): Memory {
    const highest = this.#memories.reduce((max, m) => Math.max(max, Number(m.id.slice(1)) || 0), 0);
    const memory: Memory = { id: `m${highest + 1}`, fact: fact.trim(), savedAt: new Date().toISOString() };
    this.#memories.push(memory);
    this.#save();
    return memory;
  }

  remove(id: string): Memory | undefined {
    const index = this.#memories.findIndex((m) => m.id === id);
    if (index === -1) return undefined;
    const [removed] = this.#memories.splice(index, 1);
    this.#save();
    return removed;
  }

  #save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.#memories, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
