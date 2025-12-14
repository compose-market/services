/**
 * Project Template Builder
 * 
 * Reads template files from project-templates/runner and builds a zip archive
 * with the workflow embedded.
 */
import path from "node:path";
import fs from "node:fs/promises";
import type { Archiver } from "archiver";
import type { WorkflowDefinition, ExportMetadata } from "./types.js";

/**
 * Convert a string to a URL-safe slug.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "workflow";
}

/**
 * Add a file to the archive, optionally transforming its content.
 */
async function addFileFromTemplate(
  archive: Archiver,
  templateRoot: string,
  relPath: string,
  destPath: string,
  transform?: (content: string) => string
): Promise<void> {
  const fullPath = path.join(templateRoot, relPath);
  let content = await fs.readFile(fullPath, "utf8");
  if (transform) {
    content = transform(content);
  }
  archive.append(content, { name: destPath });
}

/**
 * Build a minimal Node/TS project for the given workflow into the archive.
 */
export async function addWorkflowProjectToArchive(
  archive: Archiver,
  workflow: WorkflowDefinition,
  meta: ExportMetadata
): Promise<void> {
  const templateRoot = path.join(
    process.cwd(),
    "project-templates",
    "runner"
  );

  // Derive project name and slug
  const projectName =
    meta.projectName?.trim() || workflow.name || `workflow-${workflow.id}`;
  const projectSlug = slugify(projectName);
  const description =
    meta.description?.trim() || workflow.description || "Exported workflow from Compose Market";

  // Serialize workflow to JSON
  const workflowJson = JSON.stringify(workflow, null, 2);

  // Root-level files
  await addFileFromTemplate(
    archive,
    templateRoot,
    "package.json",
    "package.json",
    (content) =>
      content
        .replace(/__PROJECT_NAME__/g, projectSlug)
        .replace(/__DESCRIPTION__/g, description)
  );

  await addFileFromTemplate(archive, templateRoot, "tsconfig.json", "tsconfig.json");
  await addFileFromTemplate(archive, templateRoot, "Dockerfile", "Dockerfile");
  await addFileFromTemplate(archive, templateRoot, ".env.example", ".env.example");

  await addFileFromTemplate(
    archive,
    templateRoot,
    "README.md",
    "README.md",
    (content) =>
      content
        .replace(/__PROJECT_NAME__/g, projectName)
        .replace(/__DESCRIPTION__/g, description)
        .replace(/__WORKFLOW_ID__/g, workflow.id)
  );

  // Source files
  const srcFiles = [
    "config.ts",
    "types.ts",
    "template.ts",
    "payment.ts",
    "workflowEngine.ts",
    "server.ts"
  ];

  for (const file of srcFiles) {
    await addFileFromTemplate(
      archive,
      path.join(templateRoot, "src"),
      file,
      `src/${file}`
    );
  }

  // workflowDefinition.ts - inject the actual workflow JSON
  await addFileFromTemplate(
    archive,
    path.join(templateRoot, "src"),
    "workflowDefinition.ts",
    "src/workflowDefinition.ts",
    (content) => content.replace("__WORKFLOW_JSON__", workflowJson)
  );
}

