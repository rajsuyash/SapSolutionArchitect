import { describe, expect, it } from "vitest";
import { overviewStatus } from "../src/lib/project-status";

describe("project status line shared by the overview and the project list", () => {
  it("reads the To-Be progress once the process is mapped, and the stored status before that", () => {
    expect(overviewStatus("SCOPE_PROPOSED", true, { status: "SUCCEEDED" })).toBe("To-Be draft ready");
    expect(overviewStatus("SCOPE_PROPOSED", true, { status: "RUNNING" })).toBe("To-Be being generated");
    expect(overviewStatus("SCOPE_PROPOSED", true, { status: "QUEUED" })).toBe("To-Be being generated");
    expect(overviewStatus("SCOPE_PROPOSED", true, { status: "FAILED" })).toBe("Process mapped");
    expect(overviewStatus("SCOPE_PROPOSED", false, undefined)).toBe("Scope proposed");
    expect(overviewStatus("DRAFT", false, undefined)).toBe("Draft");
    expect(overviewStatus("ACTIVE", true, { status: "SUCCEEDED" })).toBe("Active");
  });
});
