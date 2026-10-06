import { describe, expect, it } from "vitest";
import {
  buildImportedTitle,
  classifyJiraIssues,
  findImportedStatus,
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

describe("findImportedStatus", () => {
  const status = (name: string, groupType: "open" | "closed") => ({ id: name, name, groupType });

  it("finds the closed Imported status, ignoring case and spaces", () => {
    const result = findImportedStatus([status("To Do", "open"), status(" imported ", "closed"), status("Done", "closed")]);
    expect(result).toMatchObject({ status: "ready", importedStatus: { id: " imported " } });
  });

  it("never falls back to another closed status", () => {
    expect(findImportedStatus([status("To Do", "open"), status("Done", "closed")])).toEqual({ status: "missing" });
  });

  it("refuses an Imported status that is open", () => {
    expect(findImportedStatus([status("Imported", "open")])).toEqual({ status: "not-closed" });
  });
});

describe("import result helpers", () => {
  it("summarizes the RPC outcome", () => {
    expect(
      summarizeImportOutcome([{ action: "created" }, { action: "created" }, { action: "updated" }, { action: "unchanged" }])
    ).toEqual({ processed: 4, created: 2, updated: 1, unchanged: 1 });
  });

  it("maps database error codes to readable messages, with a safe default", () => {
    expect(importTicketsErrorMessage("import_tickets:not_authorized")).toContain("permission");
    expect(importTicketsErrorMessage("import_tickets:status_not_closed")).toContain("Closed");
    expect(importTicketsErrorMessage("something unexpected")).toContain("nothing was imported");
    expect(importTicketsErrorMessage(undefined)).toContain("nothing was imported");
  });
});
