/** Command registry — central place to register and execute named commands. */

export interface Command {
  id: string;
  title: string;
  category?: string;
  keybinding?: string;
  handler: () => void | Promise<void>;
}

type Unsubscribe = () => void;

class CommandRegistry {
  private commands = new Map<string, Command>();
  private listeners = new Set<() => void>();

  /** Register a single command. Returns unsubscribe function. */
  register(command: Command): Unsubscribe {
    this.commands.set(command.id, command);
    this.notify();
    return () => {
      this.commands.delete(command.id);
      this.notify();
    };
  }

  /** Register multiple commands at once. Returns single unsubscribe. */
  registerMany(commands: Command[]): Unsubscribe {
    for (const cmd of commands) {
      this.commands.set(cmd.id, cmd);
    }
    this.notify();
    return () => {
      for (const cmd of commands) {
        this.commands.delete(cmd.id);
      }
      this.notify();
    };
  }

  /** Execute a command by id. */
  execute(id: string): void {
    const cmd = this.commands.get(id);
    if (cmd) {
      cmd.handler();
    }
  }

  /** Get all registered commands. */
  getAll(): Command[] {
    return Array.from(this.commands.values());
  }

  /** Subscribe to registry changes. */
  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }
}

/** Singleton command registry. */
export const commandRegistry = new CommandRegistry();

/** React hook that re-renders when commands change. */
import { useSyncExternalStore } from "react";

export function useCommands(): Command[] {
  return useSyncExternalStore(
    (cb) => commandRegistry.subscribe(cb),
    () => commandRegistry.getAll(),
  );
}
