/**
 * A minimal store around a pure reducer. Key handlers read and update it synchronously (a held key
 * fires faster than React renders), and components subscribe with useSyncExternalStore.
 */
export class Store<S, A> {
  readonly #reducer: (state: S, action: A) => S;
  readonly #listeners = new Set<() => void>();
  #state: S;

  constructor(reducer: (state: S, action: A) => S, initial: S) {
    this.#reducer = reducer;
    this.#state = initial;
  }

  getState = (): S => this.#state;

  /** Applies the action and returns the new state. */
  dispatch = (action: A): S => {
    const next = this.#reducer(this.#state, action);
    if (next !== this.#state) {
      this.#state = next;
      for (const listener of this.#listeners) listener();
    }
    return next;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}
