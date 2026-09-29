/**
 * App Module Registry
 *
 * Declarative configuration for all app modules in the IE Suite.
 * Adding a new app requires only adding an entry here and creating the component —
 * no shell code changes needed.
 */

export interface AppModuleConfig {
  id: string;            // 1-50 chars, alphanumeric + hyphens
  displayName: string;   // 1-100 chars
  routePath: string;     // e.g., "/inventory-assistant"
  icon: string;          // path to icon asset or component name
  status: "active" | "planned";
  description: string;   // 1-300 chars
  order: number;
  tagline: string;       // Short summary for landing page
  features: string[];    // Feature list for landing page card
  componentPath: string; // Lazy import path relative to pages/
}

export const appRegistry: AppModuleConfig[] = [
  {
    id: "inventory-assistant",
    displayName: "Inventory Management Assistant",
    routePath: "/inventory-assistant",
    icon: "/icons/inventory-assistant.png",
    status: "active",
    description:
      "Forecast demand, optimise stock levels, and reduce waste across your supply chain.",
    order: 1,
    tagline: "FORECAST DEMAND · OPTIMISE STOCK · REDUCE WASTE",
    features: [
      "ABC Inventory Analysis",
      "Customer Segmentation",
      "Demand Forecast",
      "Demand Health",
      "Stock Control & Optimisation",
    ],
    componentPath: "./pages/inventory-assistant/index",
  },
  {
    id: "operations-assistant",
    displayName: "Manufacturing Operations Assistant",
    routePath: "/operations-assistant",
    icon: "/icons/operations-assistant.png",
    status: "active",
    description:
      "Balance lines, diagnose machines, and eliminate bottlenecks on the shop floor.",
    order: 2,
    tagline: "BALANCE LINES · DIAGNOSE MACHINES · ELIMINATE BOTTLENECKS",
    features: [
      "Current State Analysis",
      "Line Balancing Simulation",
      "Machine Health Diagnostics",
      "Discrete Event Simulation",
    ],
    componentPath: "./pages/operations-assistant/index",
  },
  {
    id: "production-assistant",
    displayName: "Production Planning Assistant",
    routePath: "/production-assistant",
    icon: "/icons/production-assistant.png",
    status: "planned",
    description:
      "Translate demand signals into production schedules and material plans.",
    order: 3,
    tagline: "",
    features: [],
    componentPath: "",
  },
  {
    id: "quality-assistant",
    displayName: "Quality Control Assistant",
    routePath: "/quality-assistant",
    icon: "/icons/quality-assistant.png",
    status: "planned",
    description: "Monitor, analyse, and improve product and process quality.",
    order: 4,
    tagline: "",
    features: [],
    componentPath: "",
  },
];

/**
 * Validates a single AppModuleConfig entry.
 * Throws a descriptive error if any field violates constraints.
 */
export function validateAppModuleConfig(config: AppModuleConfig): void {
  const ID_REGEX = /^[a-z0-9-]+$/;

  if (
    typeof config.id !== "string" ||
    config.id.length < 1 ||
    config.id.length > 50 ||
    !ID_REGEX.test(config.id)
  ) {
    throw new Error(
      `Invalid id "${config.id}": must be 1-50 characters matching /^[a-z0-9-]+$/`
    );
  }

  if (
    typeof config.displayName !== "string" ||
    config.displayName.length < 1 ||
    config.displayName.length > 100
  ) {
    throw new Error(
      `Invalid displayName "${config.displayName}" for module "${config.id}": must be 1-100 characters`
    );
  }

  if (
    typeof config.description !== "string" ||
    config.description.length < 1 ||
    config.description.length > 300
  ) {
    throw new Error(
      `Invalid description for module "${config.id}": must be 1-300 characters`
    );
  }

  if (config.status !== "active" && config.status !== "planned") {
    throw new Error(
      `Invalid status "${config.status}" for module "${config.id}": must be "active" or "planned"`
    );
  }

  if (
    typeof config.order !== "number" ||
    !Number.isFinite(config.order) ||
    !Number.isInteger(config.order)
  ) {
    throw new Error(
      `Invalid order "${config.order}" for module "${config.id}": must be a finite integer`
    );
  }
}

/**
 * Validates the entire registry.
 * Checks each entry's fields and detects duplicate IDs.
 * Throws on the first violation found.
 */
export function validateRegistry(registry: AppModuleConfig[]): void {
  const seenIds = new Set<string>();

  for (const entry of registry) {
    validateAppModuleConfig(entry);

    if (seenIds.has(entry.id)) {
      throw new Error(
        `Duplicate app module id "${entry.id}" detected in registry`
      );
    }
    seenIds.add(entry.id);
  }
}

/**
 * Returns a sorted copy of the registry.
 * Sorts by ascending order value; ties are broken alphabetically
 * by displayName (case-insensitive).
 */
export function getSortedRegistry(
  registry: AppModuleConfig[]
): AppModuleConfig[] {
  return [...registry].sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: "base",
    });
  });
}
