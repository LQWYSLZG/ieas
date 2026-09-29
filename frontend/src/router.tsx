/**
 * Router Configuration
 *
 * Generates routes dynamically from the App_Registry.
 * - Only "active" modules get navigable routes (planned modules are excluded)
 * - Each active module is lazy-loaded with React.lazy() and wrapped in Suspense + ErrorBoundary
 * - Root path `/` maps to the LandingPage
 * - Unmatched paths fall through to NotFoundPage
 */

import { createBrowserRouter, RouteObject } from "react-router-dom";
import { appRegistry } from "./config/appRegistry";
import { SuiteShell } from "./App";
import { LandingPage } from "./pages/LandingPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoadingSpinner } from "./components/LoadingSpinner";

const LazyFactorySimulator = lazy(
  () =>
    import(
      "./pages/operations-assistant/factory-simulator/components/FactorySimulatorPage"
    )
);

const appRoutes: RouteObject[] = appRegistry
  .filter((app) => app.status === "active")
  .map((app) => {
    const LazyComponent = lazy(() => import(/* @vite-ignore */ app.componentPath));
    return {
      path: app.routePath,
      element: (
        <ErrorBoundary>
          <Suspense fallback={<LoadingSpinner />}>
            <LazyComponent />
          </Suspense>
        </ErrorBoundary>
      ),
    };
  });

// Derive the router basename from Vite's BASE_URL so routes resolve under the
// deployed subpath. In dev, BASE_URL is "/", so basename becomes "" and we pass
// "/". In prod, BASE_URL is "/ieas/", so basename becomes "/ieas". This keeps
// both dev and the GitHub Pages project-page deploy working.
const basename = import.meta.env.BASE_URL.replace(/\/$/, "");

export const router = createBrowserRouter(
  [
    {
      element: <SuiteShell />,
      children: [
        { index: true, element: <LandingPage /> },
        ...appRoutes,
        {
          path: "/operations-assistant/factory-simulator",
          element: (
            <ErrorBoundary>
              <Suspense fallback={<LoadingSpinner />}>
                <LazyFactorySimulator />
              </Suspense>
            </ErrorBoundary>
          ),
        },
        { path: "*", element: <NotFoundPage /> },
      ],
    },
  ],
  { basename: basename || "/" }
);
