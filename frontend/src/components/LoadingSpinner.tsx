import React from "react";

const spinnerStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--spacing-xl, 2rem)",
  gap: "var(--spacing-md, 1rem)",
};

const ringStyles: React.CSSProperties = {
  width: "40px",
  height: "40px",
  border: "4px solid rgba(212, 160, 23, 0.2)",
  borderTopColor: "var(--color-accent, #d4a017)",
  borderRadius: "50%",
  animation: "spinner-rotate 0.8s linear infinite",
};

const labelStyles: React.CSSProperties = {
  color: "var(--color-accent, #d4a017)",
  fontSize: "var(--font-size-body, 0.86rem)",
  fontFamily: "var(--font-family, 'Segoe UI', system-ui, sans-serif)",
};

/**
 * LoadingSpinner — visible loading indicator shown during lazy-load.
 * Uses CSS custom properties for theming and is accessible to screen readers.
 */
export const LoadingSpinner: React.FC = () => {
  return (
    <>
      <style>{`
        @keyframes spinner-rotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div style={spinnerStyles} role="status" aria-label="Loading content">
        <div style={ringStyles} aria-hidden="true" />
        <span style={labelStyles}>Loading…</span>
      </div>
    </>
  );
};
