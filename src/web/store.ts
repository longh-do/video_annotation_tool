/**
 * A minimal store around a pure reducer. Key handlers read and update it synchronously (a held key
 * fires faster than React renders), and components subscribe with useSyncExternalStore.
 */
export class Store<S, A> {
  readonly #reducer: (state: S, action: A) => S;
  readonly #listeners = new Set<() => void>();
  readonly #observers = new Set<(action: A, before: S, after: S) => void>();
  #state: S;

  constructor(reducer: (state: S, action: A) => S, initial: S) {
    this.#reducer = reducer;
    this.#state = initial;
  }

  getState = (): S => this.#state;

  /** Applies the action and returns the new state. */
  dispatch = (action: A): S => {
    const before = this.#state;
    const next = this.#reducer(before, action);
    this.#state = next;
    // Observers only watch (telemetry): one that fails must not keep the change from the
    // listeners, the saver among them.
    for (const observer of this.#observers) {
      try {
        observer(action, before, next);
      } catch (error) {
        console.error(error);
      }
    }
    if (next !== before) for (const listener of this.#listeners) listener();
    return next;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Sees every action with the states around it, even an action that changed nothing. */
  observe(observer: (action: A, before: S, after: S) => void): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }
}
