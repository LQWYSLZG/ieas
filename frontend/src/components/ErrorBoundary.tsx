import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

const containerStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--spacing-2xl, 3rem) var(--spacing-xl, 2rem)",
  gap: "var(--spacing-md, 1rem)",
  textAlign: "center",
  fontFamily: "var(--font-family, 'Segoe UI', system-ui, sans-serif)",
};

const iconStyles: React.CSSProperties = {
  fontSize: "2.5rem",
  marginBottom: "var(--spacing-sm, 0.5rem)",
};

const headingStyles: React.CSSProperties = {
  fontSize: "var(--font-size-h4, 1.1rem)",
  fontWeight: 600,
  color: "var(--color-text-primary, #ffffff)",
  margin: 0,
};

const messageStyles: React.CSSProperties = {
  fontSize: "var(--font-size-body, 0.86rem)",
  color: "var(--color-text-secondary, #b0b8c9)",
  margin: 0,
  maxWidth: "400px",
  lineHeight: 1.5,
};

const buttonStyles: React.CSSProperties = {
  marginTop: "var(--spacing-md, 1rem)",
  padding: "var(--spacing-sm, 0.5rem) var(--spacing-lg, 1.5rem)",
  backgroundColor: "var(--color-accent, #d4a017)",
  color: "var(--color-bg-primary, #0e1a3a)",
  border: "none",
  borderRadius: "var(--radius-sm, 4px)",
  fontSize: "var(--font-size-body, 0.86rem)",
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
  minWidth: "44px",
  minHeight: "44px",
};

/**
 * ErrorBoundary — Catches lazy-load failures (network/module resolution errors)
 * and displays a fallback UI with a retry action.
 *
 * On retry, the error state is reset so the wrapped children re-render,
 * triggering another lazy import attempt.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[ErrorBoundary] Module load failure:", error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div style={containerStyles} role="alert" aria-live="assertive">
          <span style={iconStyles} aria-hidden="true">⚠️</span>
          <h2 style={headingStyles}>Failed to load module</h2>
          <p style={messageStyles}>
            The application module could not be loaded. This may be due to a
            network issue or a temporary problem. Please try again.
          </p>
          <button
            style={buttonStyles}
            onClick={this.handleRetry}
            type="button"
            aria-label="Retry loading module"
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
