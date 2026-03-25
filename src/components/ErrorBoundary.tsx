import { Component, type ReactNode, type ErrorInfo } from "react";

interface ErrorBoundaryProps {
  /** Fallback UI rendered when a child component throws. */
  fallback?: ReactNode;
  /** Optional callback when an error is caught. */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Optional key — change it to reset the boundary (e.g., after retrying). */
  resetKey?: string | number;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Generic React error boundary.
 *
 * Catches render-phase errors in any descendant and shows a fallback UI
 * instead of crashing the entire component tree.  Change `resetKey` to
 * clear the error and re-render children (useful after user retries).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (
      this.state.hasError &&
      prevProps.resetKey !== this.props.resetKey
    ) {
      this.setState({ hasError: false, error: null });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex items-center justify-center w-full h-full text-[10px] text-[rgb(var(--color-error))]">
          Render error
        </div>
      );
    }
    return this.props.children;
  }
}
