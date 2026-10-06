import { describe, expect, it } from "vitest";
import {
  IMPORT_MAX_STORABLE_MINUTES,
  JIRA_IMPORT_MAX_FILE_BYTES,
  buildImportedTitle,
  canConfirmImport,
  formatMinutesAsHours,
  parseHoursInput,
  summarizeHours,
  validateImportFile,
  classifyJiraIssues,
  resolveImportStatus,
  mapJiraIssueType,
  parseCsv,
  parseJiraCsv,
  toImportPayload,
  type ExistingImportedTicket,
} from "./jira-csv-import";
import { importTicketsErrorMessage, summarizeImportOutcome } from "./ticket-import";

const rowsOf = (text: string) => {
  const result = parseCsv(text);
  if (result.status !== "ok") throw new Error(result.message);
  return result.rows;
};

describe("parseCsv", () => {
  it("parses a basic file with a header", () => {
    expect(rowsOf("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps commas inside quoted fields", () => {
    expect(rowsOf('k,s\nSO-1,"Fix login, signup and reset"\n')[1]).toEqual(["SO-1", "Fix login, signup and reset"]);
  });

  it("keeps embedded newlines inside quoted fields", () => {
    expect(rowsOf('k,s\nSO-1,"line one\nline two"\nSO-2,next\n')).toEqual([
      ["k", "s"],
      ["SO-1", "line one\nline two"],
      ["SO-2", "next"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(rowsOf('k,s\nSO-1,"The ""Pay now"" button"\n')[1][1]).toBe('The "Pay now" button');
  });

  it("handles CRLF, a BOM, a missing final newline, empty fields and blank lines", () => {
    expect(rowsOf('﻿a,b,c\r\n1,,""\r\n\r\n4,5,6')).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
      ["4", "5", "6"],
    ]);
  });

  it("rejects a quote that never closes instead of guessing", () => {
    const result = parseCsv('k,s\nSO-1,"never closed\nSO-2,x\n');
    expect(result).toMatchObject({ status: "error" });
    expect(result.status === "error" && result.message).toContain("line 2");
  });

  it("rejects text glued to a closing quote and stray quotes in unquoted fields", () => {
    expect(parseCsv('k,s\nSO-1,"quoted"tail\n').status).toBe("error");
    expect(parseCsv('k,s\nSO-1,ta"il\n').status).toBe("error");
  });
});

describe("JIRA field mapping", () => {
  it("maps Bug to bug and everything else to task", () => {
    expect(mapJiraIssueType("Bug")).toBe("bug");
    expect(mapJiraIssueType(" bug ")).toBe("bug");
    for (const other of ["Story", "Task", "Epic", "Sub-task", "Deployment", ""]) {
      expect(mapJiraIssueType(other)).toBe("task");
    }
  });

  it("builds the title as '<Issue key> <Summary>'", () => {
    expect(buildImportedTitle("SO-1832", "Fix payment issue")).toBe("SO-1832 Fix payment issue");
    expect(buildImportedTitle(" DEP-7 ", "  Release\n notes  ")).toBe("DEP-7 Release notes");
  });
});

const HEADER =
  "Issue Type,Issue key,Issue id,Summary,Status,Labels,Labels,Assignee,Assignee Id,Created,Updated,Time Spent,Log Work";

function jiraCsv(...lines: string[]): string {
  return [HEADER, ...lines].join("\n") + "\n";
}

const okResult = (text: string) => {
  const result = parseJiraCsv(text);
  if (result.status !== "ok") throw new Error(result.message);
  return result;
};

describe("parseJiraCsv", () => {
  it("reads only the four mapped fields", () => {
    const result = okResult(
      jiraCsv(
        'Bug,SO-1832,12345,Fix payment issue,Pending Priority,API,UI,Juan Perez,60a8,01/Oct/26 3:21 PM,01/Oct/26 3:58 PM,7200,"did work;01/Oct/26 3:00 PM;juan;7200"'
      )
    );
    expect(result.issues).toEqual([
      { externalId: "12345", externalKey: "SO-1832", title: "SO-1832 Fix payment issue", type: "bug", rowNumber: 1 },
    ]);
    expect(result.rowCount).toBe(1);
    expect(result.invalidRows).toEqual([]);
  });

  it("ignores Assignee: the payload carries no person, and rows differing only by assignee are identical", () => {
    const a = okResult(jiraCsv("Story,SO-1,1,Same,To Do,,,Juan Perez,aaa,,,,"));
    const b = okResult(jiraCsv("Story,SO-1,1,Same,To Do,,,Someone Else,zzz,,,,"));
    expect(toImportPayload(a.issues)).toEqual(toImportPayload(b.issues));
    expect(Object.keys(toImportPayload(a.issues)[0]).sort()).toEqual(["external_id", "external_key", "title", "type"]);
    expect(JSON.stringify(toImportPayload(a.issues))).not.toContain("Juan");
  });

  it("ignores Status, dates and worklog columns: they never reach the payload", () => {
    const a = okResult(jiraCsv("Story,SO-1,1,Same,To Do,,,x,y,01/Oct/26 1:00 PM,01/Oct/26 2:00 PM,0,"));
    const b = okResult(jiraCsv('Story,SO-1,1,Same,Done,,,x,y,05/Oct/26 1:00 PM,06/Oct/26 2:00 PM,36000,"w;d;a;36000"'));
    expect(toImportPayload(a.issues)).toEqual(toImportPayload(b.issues));
  });

  it("finds columns by name regardless of order, case or extra/duplicated headers", () => {
    const result = okResult("summary,Labels,ISSUE ID,Labels,issue key,Issue type\nHello,x,9,y,OA-4,Bug\n");
    expect(result.issues[0]).toMatchObject({ externalId: "9", externalKey: "OA-4", title: "OA-4 Hello", type: "bug" });
  });

  it("does not assume a key prefix", () => {
    const result = okResult(
      jiraCsv("Story,SO-1,1,a,,,,,,,,,", "Story,DEP-2,2,b,,,,,,,,,", "Story,SRE-3,3,c,,,,,,,,,")
    );
    expect(result.issues.map((i) => i.externalKey)).toEqual(["SO-1", "DEP-2", "SRE-3"]);
  });

  it("needs only Issue id, Issue key and Summary — Issue Type is optional and defaults to task", () => {
    const result = okResult("Issue id,Issue key,Summary\n1,SO-1,Hello\n2,DEP-2,World\n");
    expect(result.issues.map((i) => [i.externalId, i.externalKey, i.title, i.type])).toEqual([
      ["1", "SO-1", "SO-1 Hello", "task"],
      ["2", "DEP-2", "DEP-2 World", "task"],
    ]);
    expect(result.invalidRows).toEqual([]);
  });

  it("treats an empty Issue Type cell as task, never as an invalid row", () => {
    const result = okResult("Issue id,Issue key,Summary,Issue Type\n1,SO-1,Hello,\n2,SO-2,Broken,Bug\n");
    expect(result.issues.map((i) => i.type)).toEqual(["task", "bug"]);
    expect(result.invalidRows).toEqual([]);
  });

  it("never rejects a valid file because of other columns, whatever they are", () => {
    const result = okResult(
      'Whatever,Issue id,Custom field (Team),Issue key,Sprint,Sprint,Summary,"Weird, header",Σ Time Spent\n' +
        'x,1,,SO-1,S1,S2,Hello,"a,b",3600\n'
    );
    expect(result.issues).toEqual([
      { externalId: "1", externalKey: "SO-1", title: "SO-1 Hello", type: "task", rowNumber: 1 },
    ]);
  });

  it.each([
    ["Issue key,Summary,Issue Type\nSO-1,x,Bug\n", ["Issue id"]],
    ["Issue id,Summary\n1,x\n", ["Issue key"]],
    ["Issue id,Issue key\n1,SO-1\n", ["Summary"]],
    ["Issue Type,Status,Assignee\nBug,Done,Juan\n", ["Issue id", "Issue key", "Summary"]],
  ])("rejects the whole file and names every missing required column (%#)", (text, missing) => {
    const result = parseJiraCsv(text);
    expect(result.status).toBe("error");
    const message = result.status === "error" ? result.message : "";
    for (const column of missing) expect(message).toContain(column);
    expect(message).not.toContain("Issue Type");
  });

  it("does not substitute a missing required column from a similar one", () => {
    // "Key"/"Id"/"Title" are not "Issue key"/"Issue id"/"Summary".
    expect(parseJiraCsv("Id,Key,Title\n1,SO-1,Hello\n").status).toBe("error");
    expect(parseJiraCsv("Issue id,Parent key,Summary\n1,SO-1,Hello\n").status).toBe("error");
  });

  it("fails on an empty file, a header-only file and malformed CSV", () => {
    expect(parseJiraCsv("").status).toBe("error");
    expect(parseJiraCsv(HEADER + "\n").status).toBe("error");
    expect(parseJiraCsv(jiraCsv('Bug,SO-1,1,"broken,,,,,,,,,')).status).toBe("error");
  });

  it("reports rows missing a required value as invalid and skips only those", () => {
    const result = okResult(
      jiraCsv("Bug,SO-1,1,ok,,,,,,,,,", "Bug,,2,no key,,,,,,,,,", "Bug,SO-3,,no id,,,,,,,,,", "Bug,SO-4,4,   ,,,,,,,,,")
    );
    expect(result.issues.map((i) => i.externalId)).toEqual(["1"]);
    expect(result.invalidRows).toEqual([
      { rowNumber: 2, label: "2", reason: "Missing Issue key" },
      { rowNumber: 3, label: "SO-3", reason: "Missing Issue id" },
      { rowNumber: 4, label: "SO-4", reason: "Missing Summary" },
    ]);
    expect(result.rowCount).toBe(4);
  });

  it("resolves a duplicated Issue id to its last row and reports it", () => {
    const result = okResult(
      jiraCsv("Story,SO-1,1,first,,,,,,,,,", "Story,SO-2,2,other,,,,,,,,,", "Bug,DEP-9,1,latest,,,,,,,,,")
    );
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toMatchObject({ externalId: "1", externalKey: "DEP-9", title: "DEP-9 latest", type: "bug", rowNumber: 3 });
    expect(result.duplicates).toEqual([{ externalId: "1", externalKey: "DEP-9", rowNumbers: [1, 3] }]);
  });
});

describe("classifyJiraIssues", () => {
  const issues = okResult(
    jiraCsv("Bug,SO-1832,12345,Fix payment issue,,,,,,,,,", "Story,DEP-7,777,Release,,,,,,,,,", "Story,OA-1,5,Brand new,,,,,,,,,")
  ).issues;
  const existing: ExistingImportedTicket[] = [
    { externalId: "12345", externalKey: "SO-1832", title: "SO-1832 Fix payment issue", type: "bug", ticketNumber: 200 },
    { externalId: "777", externalKey: "SO-99", title: "SO-99 Release", type: "task", ticketNumber: 201 },
  ];

  it("classifies unknown ids as new, identical ones as unchanged, changed ones as updates", () => {
    const preview = classifyJiraIssues(issues, existing);
    expect(preview.map((p) => [p.issue.externalId, p.action, p.existing?.ticketNumber ?? null])).toEqual([
      ["12345", "unchanged", 200],
      ["777", "update", 201],
      ["5", "create", null],
    ]);
  });

  it("treats everything as new in an empty project, and as unchanged on an immediate re-import", () => {
    expect(classifyJiraIssues(issues, []).every((p) => p.action === "create")).toBe(true);
    const afterImport: ExistingImportedTicket[] = issues.map((issue, i) => ({
      externalId: issue.externalId,
      externalKey: issue.externalKey,
      title: issue.title,
      type: issue.type,
      ticketNumber: i + 1,
    }));
    expect(classifyJiraIssues(issues, afterImport).every((p) => p.action === "unchanged")).toBe(true);
  });

  it("matches by Issue id only — the same key under a different id is a different ticket", () => {
    const [item] = classifyJiraIssues(issues.slice(0, 1), [
      { externalId: "99999", externalKey: "SO-1832", title: "SO-1832 Fix payment issue", type: "bug", ticketNumber: 7 },
    ]);
    expect(item.action).toBe("create");
  });
});

describe("resolveImportStatus", () => {
  const status = (name: string, groupType: "open" | "closed") => ({ id: name, name, groupType });

  it("auto-selects the closed Imported status, even when other closed statuses exist", () => {
    const result = resolveImportStatus([status("To Do", "open"), status("Done", "closed"), status("Imported", "closed")]);
    expect(result).toEqual({ mode: "auto", status: status("Imported", "closed") });
  });

  it("matches Imported ignoring case and surrounding spaces", () => {
    expect(resolveImportStatus([status(" imported ", "closed")])).toMatchObject({ mode: "auto" });
  });

  it("offers exactly the project's closed statuses, in order, when there is no Imported", () => {
    const result = resolveImportStatus([
      status("To Do", "open"),
      status("Shipped", "closed"),
      status("In Progress", "open"),
      status("Won't do", "closed"),
    ]);
    expect(result).toEqual({ mode: "choose", options: [status("Shipped", "closed"), status("Won't do", "closed")] });
  });

  it("offers a single closed status as a choice rather than picking it silently", () => {
    expect(resolveImportStatus([status("To Do", "open"), status("Done", "closed")])).toEqual({
      mode: "choose",
      options: [status("Done", "closed")],
    });
  });

  it("does not treat an open Imported status as valid: falls back to the closed ones, without it", () => {
    const result = resolveImportStatus([status("Imported", "open"), status("Done", "closed")]);
    expect(result).toEqual({ mode: "choose", options: [status("Done", "closed")] });
  });

  it("blocks when the project has no closed status at all", () => {
    expect(resolveImportStatus([status("To Do", "open"), status("Imported", "open")])).toEqual({ mode: "blocked" });
    expect(resolveImportStatus([])).toEqual({ mode: "blocked" });
  });

  it("never offers an open status", () => {
    const result = resolveImportStatus([status("To Do", "open"), status("Review", "open"), status("Done", "closed")]);
    expect(result.mode === "choose" && result.options.every((o) => o.groupType === "closed")).toBe(true);
  });
});

describe("import result helpers", () => {
  it("summarizes the RPC outcome, including time entries and exact minutes", () => {
    expect(
      summarizeImportOutcome([
        { action: "created", logged_minutes: 120 },
        { action: "created", logged_minutes: 0 },
        { action: "updated", logged_minutes: 20 },
        { action: "unchanged", logged_minutes: 180 },
      ])
    ).toEqual({ processed: 4, created: 2, updated: 1, unchanged: 1, timeEntriesCreated: 3, minutesLogged: 320 });
  });

  it("still summarizes a result from a database without the time extension (no logged_minutes)", () => {
    expect(summarizeImportOutcome([{ action: "created" }, { action: "unchanged", logged_minutes: null }])).toEqual({
      processed: 2,
      created: 1,
      updated: 0,
      unchanged: 1,
      timeEntriesCreated: 0,
      minutesLogged: 0,
    });
  });

  it("explains time-related failures", () => {
    expect(importTicketsErrorMessage("import_tickets:invalid_minutes")).toContain("Hours");
    expect(importTicketsErrorMessage("import_tickets:time_on_parent_ticket")).toContain("child tickets");
    expect(importTicketsErrorMessage("import_tickets:invalid_work_date")).toContain("date");
  });

  it("maps database error codes to readable messages, with a safe default", () => {
    expect(importTicketsErrorMessage("import_tickets:not_authorized")).toContain("permission");
    expect(importTicketsErrorMessage("import_tickets:status_not_closed")).toContain("Closed");
    expect(importTicketsErrorMessage("import_tickets:status_not_in_project")).toContain("doesn't belong to this project");
    expect(importTicketsErrorMessage("something unexpected")).toContain("nothing was imported");
    expect(importTicketsErrorMessage(undefined)).toContain("nothing was imported");
  });
});

describe("parseHoursInput", () => {
  it("treats blank and zero as 'log nothing'", () => {
    for (const blank of ["", "   ", "0", "0.0", "0,00", ".0"]) {
      expect(parseHoursInput(blank)).toEqual({ status: "empty" });
    }
  });

  it("accepts whole hours", () => {
    expect(parseHoursInput("2")).toEqual({ status: "valid", minutes: 120 });
    expect(parseHoursInput(" 3 ")).toEqual({ status: "valid", minutes: 180 });
  });

  it("accepts decimal hours, with a dot or a comma, without rounding to a coarser step", () => {
    expect(parseHoursInput("1.5")).toEqual({ status: "valid", minutes: 90 });
    expect(parseHoursInput("0,5")).toEqual({ status: "valid", minutes: 30 });
    expect(parseHoursInput(".25")).toEqual({ status: "valid", minutes: 15 });
    expect(parseHoursInput("0.05")).toEqual({ status: "valid", minutes: 3 });
    expect(parseHoursInput("0.1")).toEqual({ status: "valid", minutes: 6 });
    expect(parseHoursInput("0.33")).toEqual({ status: "valid", minutes: 20 });
    expect(parseHoursInput("12.75")).toEqual({ status: "valid", minutes: 765 });
  });

  it("always produces whole minutes — the unit ticket_time_entries stores", () => {
    for (const text of ["0.01", "0.07", "1.11", "2.99", "7.33"]) {
      const result = parseHoursInput(text);
      expect(result.status === "valid" && Number.isInteger(result.minutes) && result.minutes > 0).toBe(true);
    }
  });

  it("rejects negative values", () => {
    expect(parseHoursInput("-1")).toMatchObject({ status: "invalid", reason: expect.stringContaining("negative") });
    expect(parseHoursInput("-0.5").status).toBe("invalid");
  });

  it("rejects malformed or non-numeric input instead of guessing", () => {
    for (const bad of ["abc", "2h", "1:30", "1.5.2", "1,5,2", "1e2", "+2", "1.555", "2 5", ".", ",", "NaN", "Infinity"]) {
      expect(parseHoursInput(bad).status).toBe("invalid");
    }
  });

  it("has no 24-hour (or any other business) maximum — same as Log Time", () => {
    expect(parseHoursInput("24")).toEqual({ status: "valid", minutes: 1440 });
    expect(parseHoursInput("24.01")).toEqual({ status: "valid", minutes: 1441 });
    expect(parseHoursInput("40")).toEqual({ status: "valid", minutes: 2400 });
    expect(parseHoursInput("100")).toEqual({ status: "valid", minutes: 6000 });
    expect(parseHoursInput("1234.5")).toEqual({ status: "valid", minutes: 74070 });
  });

  it("only refuses a number too large for the minutes column to hold", () => {
    expect(parseHoursInput("16666666")).toEqual({ status: "valid", minutes: 999_999_960 });
    expect(IMPORT_MAX_STORABLE_MINUTES).toBe(999_999_999);
    expect(parseHoursInput("16666667").status).toBe("invalid");
    expect(parseHoursInput("9".repeat(40)).status).toBe("invalid");
  });
});

describe("summarizeHours", () => {
  const ids = ["1", "2", "3", "4"];

  it("defaults to nothing to log when no field was touched", () => {
    expect(summarizeHours(ids, {})).toEqual({
      minutesByExternalId: {},
      totalMinutes: 0,
      ticketCount: 0,
      invalidExternalIds: [],
    });
  });

  it("totals exact minutes across the tickets that have hours", () => {
    const summary = summarizeHours(ids, { "1": "2", "2": "1.5", "3": "", "4": "0.5" });
    expect(summary.minutesByExternalId).toEqual({ "1": 120, "2": 90, "4": 30 });
    expect(summary.totalMinutes).toBe(240);
    expect(summary.ticketCount).toBe(3);
    expect(formatMinutesAsHours(summary.totalMinutes)).toBe("4h");
  });

  it("reports which fields are invalid and never counts them", () => {
    const summary = summarizeHours(ids, { "1": "2", "2": "-1", "3": "abc" });
    expect(summary.invalidExternalIds).toEqual(["2", "3"]);
    expect(summary.totalMinutes).toBe(120);
  });

  it("ignores leftover fields for tickets that aren't in the current preview", () => {
    expect(summarizeHours(["1"], { "1": "1", "999": "5", "998": "nonsense" })).toMatchObject({
      totalMinutes: 60,
      ticketCount: 1,
      invalidExternalIds: [],
    });
  });
});

describe("formatMinutesAsHours", () => {
  it("shows hours with at most two decimals", () => {
    expect([120, 90, 30, 20, 1, 750].map(formatMinutesAsHours)).toEqual(["2h", "1.5h", "0.5h", "0.33h", "0.02h", "12.5h"]);
  });
});

describe("canConfirmImport", () => {
  const noHours = { totalMinutes: 0, invalidExternalIds: [] };

  it("needs a status for new tickets", () => {
    expect(canConfirmImport({ hasNewTicketStatus: false, ticketsToCreateOrUpdate: 3, hours: noHours })).toBe(false);
    expect(canConfirmImport({ hasNewTicketStatus: true, ticketsToCreateOrUpdate: 3, hours: noHours })).toBe(true);
  });

  it("stays blocked by an invalid Hours value even when the status is selected", () => {
    expect(
      canConfirmImport({
        hasNewTicketStatus: true,
        ticketsToCreateOrUpdate: 3,
        hours: { totalMinutes: 120, invalidExternalIds: ["2"] },
      })
    ).toBe(false);
  });

  it("allows an import that only logs time on already-imported, unchanged tickets", () => {
    expect(
      canConfirmImport({ hasNewTicketStatus: true, ticketsToCreateOrUpdate: 0, hours: { totalMinutes: 180, invalidExternalIds: [] } })
    ).toBe(true);
  });

  it("has nothing to do when every ticket is unchanged and no hours were typed", () => {
    expect(canConfirmImport({ hasNewTicketStatus: true, ticketsToCreateOrUpdate: 0, hours: noHours })).toBe(false);
  });
});

describe("toImportPayload with hours", () => {
  const issues = okResult(jiraCsv("Bug,SO-1,1,One,,,,,,,,,", "Story,SO-2,2,Two,,,,,,,,,", "Story,SO-3,3,Three,,,,,,,,,")).issues;

  it("adds minutes only to the tickets that have hours", () => {
    const payload = toImportPayload(issues, { "1": 120, "3": 0 });
    expect(payload).toEqual([
      { external_id: "1", external_key: "SO-1", title: "SO-1 One", type: "bug", minutes: 120 },
      { external_id: "2", external_key: "SO-2", title: "SO-2 Two", type: "task" },
      { external_id: "3", external_key: "SO-3", title: "SO-3 Three", type: "task" },
    ]);
  });

  it("never takes hours from the CSV: time columns in the file produce no minutes", () => {
    const withWorklog = okResult(
      jiraCsv('Story,SO-1,1,One,Done,,,x,y,,,36000,"did work;01/Oct/26 3:00 PM;juan;7200"')
    ).issues;
    const payload = toImportPayload(withWorklog);
    expect(payload).toEqual([{ external_id: "1", external_key: "SO-1", title: "SO-1 One", type: "task" }]);
    expect("minutes" in payload[0]).toBe(false);
  });
});

describe("validateImportFile (file picker and drag & drop share it)", () => {
  it("accepts a CSV by extension or by MIME type", () => {
    expect(validateImportFile({ name: "JIRA.csv", type: "text/csv", size: 1000 })).toBeNull();
    expect(validateImportFile({ name: "export.CSV", type: "", size: 1000 })).toBeNull();
    expect(validateImportFile({ name: "export", type: "text/csv", size: 1000 })).toBeNull();
  });

  it("rejects other file types with a clear message", () => {
    for (const file of [
      { name: "issues.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 10 },
      { name: "screenshot.png", type: "image/png", size: 10 },
      { name: "notes.txt", type: "text/plain", size: 10 },
      { name: "csv", type: "", size: 10 },
    ]) {
      expect(validateImportFile(file)).toContain("Only CSV files");
    }
  });

  it("rejects an oversized CSV", () => {
    expect(validateImportFile({ name: "big.csv", type: "text/csv", size: JIRA_IMPORT_MAX_FILE_BYTES + 1 })).toContain(
      "too large"
    );
    expect(validateImportFile({ name: "ok.csv", type: "text/csv", size: JIRA_IMPORT_MAX_FILE_BYTES })).toBeNull();
  });
});
