import { Link } from "react-router-dom";

/**
 * NotFoundPage
 *
 * Displayed for unmatched routes. Shows a message indicating
 * no matching page exists and provides a link back to the Landing Page.
 */
export function NotFoundPage() {
  return (
    <div style={styles.container}>
      <h1 style={styles.heading}>404</h1>
      <p style={styles.message}>No matching page exists.</p>
      <Link to="/" style={styles.link}>
        Back to Home
      </Link>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "60vh",
    padding: "var(--spacing-xl, 2rem)",
    textAlign: "center",
    color: "var(--color-text-primary, #ffffff)",
  },
  heading: {
    fontSize: "var(--font-size-h1, 2.4rem)",
    fontFamily: "var(--font-family, 'Segoe UI', sans-serif)",
    color: "var(--color-accent, #d4a017)",
    margin: "0 0 var(--spacing-sm, 0.5rem) 0",
  },
  message: {
    fontSize: "var(--font-size-body, 0.86rem)",
    fontFamily: "var(--font-family, 'Segoe UI', sans-serif)",
    color: "var(--color-text-secondary, #b0b8c9)",
    margin: "0 0 var(--spacing-lg, 1.5rem) 0",
  },
  link: {
    fontSize: "var(--font-size-body, 0.86rem)",
    fontFamily: "var(--font-family, 'Segoe UI', sans-serif)",
    color: "var(--color-accent, #d4a017)",
    textDecoration: "underline",
    padding: "var(--spacing-sm, 0.5rem) var(--spacing-md, 1rem)",
    borderRadius: "var(--radius-sm, 4px)",
    transition: "opacity 0.2s ease",
  },
};
