/**
 * asset - Prefixes a root relative asset path with Vite's base URL.
 *
 * In dev, import.meta.env.BASE_URL is "/", so the returned path is unchanged.
 * In the GitHub Pages build, BASE_URL is "/ieas/", so icons resolve under the
 * deployed subpath instead of 404ing at the domain root. Use this for any
 * runtime rendered img src that points at a static asset in public/.
 */
export function asset(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const clean = path.startsWith("/") ? path : "/" + path;
  return base + clean;
}
