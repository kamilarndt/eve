import type { Prompter } from "./prompter.js";

/** Project fields needed by the existing-project picker. */
export interface PickableVercelProject {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
}

/** Inputs for choosing from recent projects with optional server-side search. */
export interface VercelProjectPickerOptions {
  readonly prompter: Prompter;
  readonly team: string;
  readonly projects: readonly PickableVercelProject[];
  search(query: string): Promise<readonly PickableVercelProject[]>;
}

const SEARCH_ALL_PROJECTS = "\0search-all-projects";

function newestProjectsFirst(projects: readonly PickableVercelProject[]): PickableVercelProject[] {
  return projects.toSorted((left, right) => right.updatedAt - left.updatedAt);
}

function mergeProjects(
  current: readonly PickableVercelProject[],
  found: readonly PickableVercelProject[],
): PickableVercelProject[] {
  const projects = new Map(current.map((project) => [project.id, project]));
  for (const project of found) projects.set(project.id, project);
  return newestProjectsFirst([...projects.values()]);
}

/** Shows recent projects and searches the full team scope on request. */
export async function pickExistingVercelProject(
  options: VercelProjectPickerOptions,
): Promise<string> {
  let projects = newestProjectsFirst(options.projects);

  while (true) {
    const selected = await options.prompter.select({
      message: "Project to link",
      search: true,
      placeholder: "type to filter projects",
      options: [
        ...projects.map((project) => ({ value: project.name, label: project.name })),
        { value: SEARCH_ALL_PROJECTS, label: "Search all projects" },
      ],
    });
    if (selected !== SEARCH_ALL_PROJECTS) return selected;

    const query = (
      await options.prompter.text({
        message: "Project name to search",
        validate: (value) =>
          value.trim().length === 0 ? "Project name cannot be empty." : undefined,
      })
    ).trim();
    const found = await options.search(query);
    if (found.length === 0) {
      options.prompter.note(`No projects matched "${query}" in ${options.team}.`);
      continue;
    }
    projects = mergeProjects(projects, found);
  }
}
