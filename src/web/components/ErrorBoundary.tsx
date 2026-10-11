import { Component, type ReactNode } from 'react';

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * A bug shows a message instead of a blank page. Changes that weren't saved yet are in the
 * journal, so reloading brings them back.
 */
export class ErrorBoundary extends Component<{ readonly children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="message">
        <p>Something went wrong: {this.state.error.message}</p>
        <p>Changes that weren't saved yet are kept on this computer; reloading brings them back.</p>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
