export const statusLabel = (status: string) => status === "ACTIVE" ? "Active" : status === "SCOPE_PROPOSED" ? "Scope proposed" : "Draft";

/** The one status rule for a project, shared by the overview and the project list. It goes beyond the stored setup status once the
 * process is mapped or a To-Be exists. Display only: the stored status and the API are unchanged. */
export function overviewStatus(setupStatus: string, mapped: boolean, job: { status: string } | undefined) {
  if (setupStatus === "ACTIVE") return statusLabel(setupStatus);
  if (job?.status === "SUCCEEDED") return "To-Be draft ready";
  if (job?.status === "QUEUED" || job?.status === "RUNNING") return "To-Be being generated";
  return mapped ? "Process mapped" : statusLabel(setupStatus);
}
