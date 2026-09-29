# Industrial Engineering Assistant Suite

A modern web application for industrial engineering analytics, built with a **React (TypeScript)** frontend and a **FastAPI (Python)** backend. The suite provides a unified platform for manufacturing and supply chain planning tools.

## Architecture

```
suite/
├── frontend/          # React + Vite + TypeScript SPA
│   ├── src/
│   │   ├── App.tsx              # Suite shell (layout, sidebar, header)
│   │   ├── router.tsx           # Route generation from app registry
│   │   ├── config/
│   │   │   └── appRegistry.ts   # Declarative app module registry
│   │   ├── components/          # Shared UI components (Sidebar, ErrorBoundary, etc.)
│   │   ├── lib/
│   │   │   └── apiClient.ts    # Shared HTTP client + useApi hook
│   │   ├── pages/              # Route-level page components
│   │   └── styles/
│   │       └── theme.css       # Design tokens (CSS custom properties)
│   ├── public/icons/            # App module icons
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
├── backend/           # FastAPI + Uvicorn API server
│   ├── app/
│   │   ├── main.py             # FastAPI app, router registration, SPA fallback
│   │   ├── config.py           # Environment variable loading
│   │   ├── middleware.py       # CORS (development only)
│   │   └── routers/            # One router per app module
│   │       ├── health.py
│   │       ├── inventory_assistant.py
│   │       └── operations_assistant.py
│   └── requirements.txt
├── docker-compose.yml           # Dev server orchestration
└── README.md                    # This file
```

## Prerequisites

| Tool       | Version   |
|------------|-----------|
| Node.js    | 20+       |
| npm        | 10+       |
| Python     | 3.11+     |
| pip        | 23+       |
| Docker     | 24+ (optional, for containerised dev/deploy) |

## Getting Started

### Install Dependencies

**Frontend:**

```bash
cd suite/frontend
npm install
```

**Backend:**

```bash
cd suite/backend
pip install -r requirements.txt
```

> It's recommended to use a Python virtual environment (`python -m venv .venv`) before installing backend dependencies.

### Start Development Servers

#### Option 1: Docker Compose (recommended)

From the `suite/` directory:

```bash
docker compose up
```

This starts both servers with a single command:
- Frontend dev server at **http://localhost:5173**
- Backend API server at **http://localhost:8000**

#### Option 2: Run manually in separate terminals

**Terminal 1 — Backend:**

```bash
cd suite/backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Terminal 2 — Frontend:**

```bash
cd suite/frontend
npm run dev
```

## Ports

| Service              | Port  | URL                        |
|----------------------|-------|----------------------------|
| Frontend dev server  | 5173  | http://localhost:5173       |
| Backend API server   | 8000  | http://localhost:8000       |

The Vite dev server proxies all `/api` requests to the backend at port 8000, so during development the frontend can call API endpoints without CORS issues.

## Hot Reload

- **Frontend (Vite HMR):** Changes to React components, styles, and TypeScript files are reflected in the browser instantly via Hot Module Replacement — no full page reload required.
- **Backend (uvicorn --reload):** Changes to Python files in `backend/app/` trigger an automatic server restart. Updated responses are served within a few seconds of saving.

## API Endpoints

All API routes are versioned under `/api/v1/`:

| Method | Path                                  | Description               |
|--------|---------------------------------------|---------------------------|
| GET    | `/api/v1/health`                      | Health check (`{"status": "ok"}`) |
| POST   | `/api/v1/inventory-assistant/upload`  | Upload Excel file for inventory analysis |
| POST   | `/api/v1/operations-assistant/upload` | Upload Excel file for operations analysis |

File uploads accept `.xlsx` and `.xls` files up to 10 MB via multipart form data.

## Production Build

### Docker

From the project root or `suite/` directory, build and run the production container:

```bash
cd suite
docker build -t ie-suite .
docker run -p 8080:8080 ie-suite
```

The production container:
- Builds the React frontend into a minified static bundle with tree-shaking
- Serves the static bundle via FastAPI at `/static`
- Handles client-side routing by returning `index.html` for non-API paths
- Exposes a single HTTP port (default `8080`, configurable via `PORT` environment variable)

```bash
# Run on a custom port
docker run -p 3000:3000 -e PORT=3000 ie-suite
```

### Manual Production Build

**Frontend:**

```bash
cd suite/frontend
npm run build
```

This outputs the production bundle to `suite/frontend/dist/`. Copy the contents to `suite/backend/static/` for the API server to serve.

**Backend:**

```bash
cd suite/backend
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## Running Tests

**Frontend (Vitest + React Testing Library + fast-check):**

```bash
cd suite/frontend
npm test
```

**Backend (pytest + Hypothesis):**

```bash
cd suite/backend
python -m pytest
```

## Environment Variables

| Variable            | Default         | Description                              |
|---------------------|-----------------|------------------------------------------|
| `VITE_API_BASE_URL` | `/api/v1`       | Frontend API base URL (build-time)       |
| `ENV`              | `production`    | Set to `development` to enable CORS      |
| `PORT`             | `8080`          | Production server port                   |

## Adding a New App Module

1. Add an entry to `suite/frontend/src/config/appRegistry.ts`
2. Create a page component at `suite/frontend/src/pages/<app-id>/index.tsx`
3. Create a backend router at `suite/backend/app/routers/<app_id>.py`
4. Register the router in `suite/backend/app/main.py`

No changes to the shell, sidebar, or routing code are needed — the registry drives everything declaratively.
