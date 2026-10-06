// Database-level tests for JIR-118's import_external_tickets RPC.
//
// Runs the REAL migration file (20261006000000_import_external_tickets.sql)
// against an embedded Postgres (PGlite) — on top of a minimal stand-in for
// the parts of the schema it touches (the tables it reads/writes and the
// three RLS helper functions it calls, copied from 20260708000000). The
// rest of the production schema (other triggers, RLS policies) is not
// loaded here, so this proves the function's own guarantees, not the
// whole stack.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../supabase/migrations/20261006000000_import_external_tickets.sql", import.meta.url)),
  "utf8"
);

const ORG = "00000000-0000-0000-0000-0000000000a1";
const PROJECT = "00000000-0000-0000-0000-0000000000b1";
const OTHER_PROJECT = "00000000-0000-0000-0000-0000000000b2";
const ADMIN = "00000000-0000-0000-0000-0000000000c1";
const MEMBER = "00000000-0000-0000-0000-0000000000c2";
const OUTSIDER = "00000000-0000-0000-0000-0000000000c3";
const JUAN = "00000000-0000-0000-0000-0000000000c4";
const IMPORTED = "00000000-0000-0000-0000-0000000000d1";
const TODO = "00000000-0000-0000-0000-0000000000d2";
const IN_PROGRESS = "00000000-0000-0000-0000-0000000000d3";
const OTHER_IMPORTED = "00000000-0000-0000-0000-0000000000d4";
const DONE = "00000000-0000-0000-0000-0000000000d5";

const STUB_SCHEMA = `
  create role anon;
  create role authenticated;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid
  $$;

  create type public.ticket_type as enum ('task', 'bug');

  create table public.projects (
    id uuid primary key, organization_id uuid not null, status text not null default 'active'
  );
  create table public.organization_memberships (
    organization_id uuid not null, profile_id uuid not null, status text not null, role text not null
  );
  create table public.project_memberships (project_id uuid not null, profile_id uuid not null);
  create table public.ticket_statuses (
    id uuid primary key, project_id uuid not null, name text not null, group_type text not null
  );
  create table public.tickets (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects (id),
    ticket_number integer not null,
    title text not null,
    type public.ticket_type not null default 'task',
    status_id uuid not null references public.ticket_statuses (id),
    assignee_profile_id uuid,
    created_by uuid,
    updated_at timestamptz not null default now(),
    unique (project_id, ticket_number)
  );
  create table public.ticket_route_aliases (project_id uuid not null, ticket_number integer not null, ticket_id uuid);
  create table public.ticket_time_entries (
    id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.tickets (id) on delete cascade,
    logged_by uuid, minutes integer not null, work_date date not null, comment text
  );

  create function public.is_org_member(target_org_id uuid) returns boolean language sql stable as $$
    select exists (select 1 from public.organization_memberships
      where organization_id = target_org_id and profile_id = auth.uid() and status = 'active')
  $$;
  create function public.is_org_admin_or_lead(target_org_id uuid) returns boolean language sql stable as $$
    select exists (select 1 from public.organization_memberships
      where organization_id = target_org_id and profile_id = auth.uid() and status = 'active'
        and role in ('admin', 'project_lead'))
  $$;
  create function public.is_project_member(target_project_id uuid) returns boolean language sql stable as $$
    select exists (select 1 from public.project_memberships
      where project_id = target_project_id and profile_id = auth.uid())
  $$;
`;

const SEED = `
  insert into public.projects (id, organization_id) values ('${PROJECT}', '${ORG}'), ('${OTHER_PROJECT}', '${ORG}');
  insert into public.organization_memberships values
    ('${ORG}', '${ADMIN}', 'active', 'admin'),
    ('${ORG}', '${MEMBER}', 'active', 'member'),
    ('${ORG}', '${JUAN}', 'active', 'member'),
    ('${ORG}', '${OUTSIDER}', 'active', 'member');
  insert into public.project_memberships values ('${PROJECT}', '${MEMBER}'), ('${PROJECT}', '${JUAN}');
  insert into public.ticket_statuses values
    ('${IMPORTED}', '${PROJECT}', 'Imported', 'closed'),
    ('${TODO}', '${PROJECT}', 'To Do', 'open'),
    ('${IN_PROGRESS}', '${PROJECT}', 'In Progress', 'open'),
    ('${DONE}', '${PROJECT}', 'Done', 'closed'),
    ('${OTHER_IMPORTED}', '${OTHER_PROJECT}', 'Imported', 'closed');
`;

type Row = { external_id: string; external_key: string; title: string; type: "task" | "bug" };
type Outcome = { external_id: string; ticket_id: string; ticket_number: number; action: string };

const SO_1832: Row = { external_id: "12345", external_key: "SO-1832", title: "SO-1832 Fix payment issue", type: "bug" };
const DEP_7: Row = { external_id: "777", external_key: "DEP-7", title: "DEP-7 Release", type: "task" };

let db: PGlite;

async function runImport(
  actor: string | null,
  rows: unknown,
  overrides: { project?: string; source?: string; status?: string } = {}
): Promise<Outcome[]> {
  await db.query("select set_config('test.uid', $1, false)", [actor ?? ""]);
  const result = await db.query<Outcome>(
    "select * from public.import_external_tickets($1, $2, $3, $4::jsonb) order by ticket_number",
    [overrides.project ?? PROJECT, overrides.source ?? "jira", overrides.status ?? IMPORTED, JSON.stringify(rows)]
  );
  return result.rows;
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<{ v: T }>(sql, params);
  return result.rows[0].v;
}

const ticketCount = () => scalar<number>("select count(*)::int as v from public.tickets");
const timeEntrySnapshot = () =>
  scalar<string>(
    "select coalesce(json_agg(e order by e.work_date)::text, '[]') as v from public.ticket_time_entries e"
  );

beforeEach(async () => {
  db = new PGlite();
  await db.exec(STUB_SCHEMA);
  await db.exec(MIGRATION);
  await db.exec(SEED);
});

describe("import_external_tickets — new tickets", () => {
  it("creates one native ticket per issue: next numbers, Imported status, assigned to and created by the importer", async () => {
    const outcome = await runImport(MEMBER, [SO_1832, DEP_7]);
    expect(outcome.map((o) => o.action)).toEqual(["created", "created"]);
    expect(outcome.map((o) => o.ticket_number)).toEqual([1, 2]);

    const rows = (
      await db.query<Record<string, unknown>>(
        "select title, type, status_id, assignee_profile_id, created_by, external_source, external_id, external_key from public.tickets order by ticket_number"
      )
    ).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status_id).toBe(IMPORTED);
      expect(row.assignee_profile_id).toBe(MEMBER);
      expect(row.created_by).toBe(MEMBER);
      expect(row.external_source).toBe("jira");
    }
    expect(rows.find((r) => r.external_id === "12345")).toMatchObject({
      title: "SO-1832 Fix payment issue",
      type: "bug",
      external_key: "SO-1832",
    });
  });

  it("numbers past existing tickets and past numbers reserved by moved tickets", async () => {
    await db.exec(`
      insert into public.tickets (project_id, ticket_number, title, status_id) values ('${PROJECT}', 4, 'native', '${TODO}');
      insert into public.ticket_route_aliases (project_id, ticket_number) values ('${PROJECT}', 9);
    `);
    const [created] = await runImport(ADMIN, [SO_1832]);
    expect(created.ticket_number).toBe(10);
  });

  it("never creates a time entry", async () => {
    await runImport(MEMBER, [SO_1832, DEP_7]);
    expect(await scalar<number>("select count(*)::int as v from public.ticket_time_entries")).toBe(0);
  });

  it("collapses a duplicated Issue id inside one payload into a single ticket (last row wins)", async () => {
    const outcome = await runImport(MEMBER, [SO_1832, { ...SO_1832, title: "SO-1832 Newer summary" }]);
    expect(outcome).toHaveLength(1);
    expect(await ticketCount()).toBe(1);
    expect(await scalar<string>("select title as v from public.tickets")).toBe("SO-1832 Newer summary");
  });

  it("keeps the same Issue id independent across projects", async () => {
    await runImport(ADMIN, [SO_1832]);
    const [other] = await runImport(ADMIN, [SO_1832], { project: OTHER_PROJECT, status: OTHER_IMPORTED });
    expect(other.action).toBe("created");
    expect(await ticketCount()).toBe(2);
  });
});

describe("import_external_tickets — re-import", () => {
  it("is idempotent: the same CSV again creates nothing and writes nothing", async () => {
    const [first] = await runImport(MEMBER, [SO_1832]);
    const before = await scalar<string>("select updated_at::text as v from public.tickets");
    const [second] = await runImport(MEMBER, [SO_1832]);
    expect(second).toMatchObject({ action: "unchanged", ticket_id: first.ticket_id, ticket_number: first.ticket_number });
    expect(await ticketCount()).toBe(1);
    expect(await scalar<string>("select updated_at::text as v from public.tickets")).toBe(before);
  });

  it("reuses the ticket when JIRA changed the key/summary/type — identity is the Issue id", async () => {
    const [first] = await runImport(MEMBER, [SO_1832]);
    const [second] = await runImport(MEMBER, [
      { external_id: "12345", external_key: "DEP-90", title: "DEP-90 Fix payment issue (moved)", type: "task" },
    ]);
    expect(second).toMatchObject({ action: "updated", ticket_id: first.ticket_id });
    expect(await ticketCount()).toBe(1);
    const row = (await db.query("select title, type, external_key from public.tickets")).rows[0];
    expect(row).toEqual({ title: "DEP-90 Fix payment issue (moved)", type: "task", external_key: "DEP-90" });
  });

  it("assigns each new ticket to whoever runs that import", async () => {
    await runImport(MEMBER, [SO_1832]);
    await runImport(ADMIN, [DEP_7]);
    const rows = (
      await db.query<{ external_id: string; assignee_profile_id: string }>(
        "select external_id, assignee_profile_id from public.tickets"
      )
    ).rows;
    expect(Object.fromEntries(rows.map((r) => [r.external_id, r.assignee_profile_id]))).toEqual({
      "12345": MEMBER,
      "777": ADMIN,
    });
  });

  it("ignores any assignee sent in a row — only the authenticated caller is ever assigned", async () => {
    await runImport(MEMBER, [
      { ...SO_1832, assignee: "Someone From Jira", assignee_id: "60a8331c", assignee_profile_id: JUAN },
    ]);
    expect(await scalar<string>("select assignee_profile_id::text as v from public.tickets")).toBe(MEMBER);
  });

  it("keeps the original assignee when someone else re-imports the same issue", async () => {
    const [first] = await runImport(MEMBER, [SO_1832]);
    const [unchanged] = await runImport(ADMIN, [SO_1832]);
    const [updated] = await runImport(JUAN, [{ ...SO_1832, title: "SO-1832 Renamed in JIRA" }]);
    expect([unchanged.action, updated.action]).toEqual(["unchanged", "updated"]);
    expect(updated.ticket_id).toBe(first.ticket_id);
    const row = (await db.query("select assignee_profile_id, created_by from public.tickets")).rows[0];
    expect(row).toEqual({ assignee_profile_id: MEMBER, created_by: MEMBER });
  });

  it("keeps a re-imported ticket unassigned if it was unassigned by hand", async () => {
    const [first] = await runImport(MEMBER, [SO_1832]);
    await db.query("update public.tickets set assignee_profile_id = null where id = $1", [first.ticket_id]);
    await runImport(ADMIN, [{ ...SO_1832, title: "SO-1832 Renamed in JIRA" }]);
    expect(await scalar<string | null>("select assignee_profile_id::text as v from public.tickets")).toBeNull();
  });

  it("never changes an existing ticket's status, assignee or creator", async () => {
    const [first] = await runImport(ADMIN, [SO_1832]);
    await db.query("update public.tickets set status_id = $1, assignee_profile_id = $2 where id = $3", [
      IN_PROGRESS,
      JUAN,
      first.ticket_id,
    ]);
    await runImport(MEMBER, [{ ...SO_1832, title: "SO-1832 Renamed in JIRA" }]);
    const row = (
      await db.query("select status_id, assignee_profile_id, created_by, title from public.tickets where id = $1", [
        first.ticket_id,
      ])
    ).rows[0];
    expect(row).toEqual({
      status_id: IN_PROGRESS,
      assignee_profile_id: JUAN,
      created_by: ADMIN,
      title: "SO-1832 Renamed in JIRA",
    });
  });

  it("leaves manually logged time entries exactly as they were, and later ones stay independent", async () => {
    const [first] = await runImport(MEMBER, [SO_1832]);
    await db.query(
      `insert into public.ticket_time_entries (ticket_id, logged_by, minutes, work_date, comment) values
         ($1, $2, 60, '2026-10-05', 'day one'), ($1, $2, 120, '2026-10-06', 'day two')`,
      [first.ticket_id, JUAN]
    );
    const before = await timeEntrySnapshot();

    await runImport(MEMBER, [SO_1832]);
    await runImport(ADMIN, [{ ...SO_1832, external_key: "DEP-90", title: "DEP-90 Fix payment issue" }]);
    expect(await timeEntrySnapshot()).toBe(before);

    await db.query(
      `insert into public.ticket_time_entries (ticket_id, logged_by, minutes, work_date) values
         ($1, $2, 60, '2026-10-07'), ($1, $2, 120, '2026-10-08')`,
      [first.ticket_id, JUAN]
    );
    await runImport(MEMBER, [SO_1832]);
    const totals = (
      await db.query("select count(*)::int as entries, sum(minutes)::int as minutes from public.ticket_time_entries")
    ).rows[0];
    expect(totals).toEqual({ entries: 4, minutes: 360 });
  });

  it("never deletes a ticket that is missing from a later CSV", async () => {
    await runImport(MEMBER, [SO_1832, DEP_7]);
    await runImport(MEMBER, [DEP_7]);
    expect(await ticketCount()).toBe(2);
  });

  it("does not touch native tickets that have no external identity", async () => {
    await db.exec(
      `insert into public.tickets (project_id, ticket_number, title, status_id) values ('${PROJECT}', 1, 'SO-1832 Fix payment issue', '${TODO}')`
    );
    const [created] = await runImport(MEMBER, [SO_1832]);
    expect(created.action).toBe("created");
    expect(await scalar<string>("select status_id::text as v from public.tickets where ticket_number = 1")).toBe(TODO);
  });
});

describe("import_external_tickets — status chosen for the import", () => {
  it("creates new tickets in whichever closed status of the project was selected", async () => {
    await runImport(MEMBER, [SO_1832, DEP_7], { status: DONE });
    const rows = (
      await db.query<{ status_id: string; assignee_profile_id: string }>(
        "select status_id, assignee_profile_id from public.tickets"
      )
    ).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toEqual({ status_id: DONE, assignee_profile_id: MEMBER });
    expect(await scalar<number>("select count(*)::int as v from public.ticket_time_entries")).toBe(0);
  });

  it("never applies a newly selected status to tickets that already exist", async () => {
    const [first] = await runImport(MEMBER, [SO_1832]);
    const outcome = await runImport(ADMIN, [SO_1832, { ...DEP_7 }], { status: DONE });
    expect(outcome.map((o) => [o.external_id, o.action]).sort()).toEqual([
      ["12345", "unchanged"],
      ["777", "created"],
    ]);
    const byExternalId = Object.fromEntries(
      (
        await db.query<{ external_id: string; status_id: string; assignee_profile_id: string; created_by: string }>(
          "select external_id, status_id, assignee_profile_id, created_by from public.tickets"
        )
      ).rows.map((r) => [r.external_id, r])
    );
    expect(byExternalId["12345"]).toMatchObject({ status_id: IMPORTED, assignee_profile_id: MEMBER, created_by: MEMBER });
    expect(byExternalId["777"]).toMatchObject({ status_id: DONE, assignee_profile_id: ADMIN, created_by: ADMIN });
    expect(await ticketCount()).toBe(2);
    expect(first.ticket_id).toBe(outcome.find((o) => o.external_id === "12345")!.ticket_id);
  });

  it("keeps an existing ticket's status even when the re-import also updates its title", async () => {
    await runImport(MEMBER, [SO_1832], { status: DONE });
    await runImport(MEMBER, [{ ...SO_1832, title: "SO-1832 Renamed in JIRA" }], { status: IMPORTED });
    const row = (await db.query("select status_id, title from public.tickets")).rows[0];
    expect(row).toEqual({ status_id: DONE, title: "SO-1832 Renamed in JIRA" });
  });

  it("leaves time entries untouched when a re-import selects a different status", async () => {
    const [first] = await runImport(MEMBER, [SO_1832]);
    await db.query(
      "insert into public.ticket_time_entries (ticket_id, logged_by, minutes, work_date) values ($1, $2, 90, '2026-10-05')",
      [first.ticket_id, JUAN]
    );
    const before = await timeEntrySnapshot();
    await runImport(ADMIN, [{ ...SO_1832, title: "SO-1832 Renamed" }], { status: DONE });
    expect(await timeEntrySnapshot()).toBe(before);
  });

  it("validates the selected status before anything else is written, even if every row already exists", async () => {
    await runImport(MEMBER, [SO_1832]);
    await expect(runImport(MEMBER, [{ ...SO_1832, title: "SO-1832 Renamed" }], { status: TODO })).rejects.toThrow(
      "import_tickets:status_not_closed"
    );
    await expect(
      runImport(MEMBER, [{ ...SO_1832, title: "SO-1832 Renamed" }], { status: OTHER_IMPORTED })
    ).rejects.toThrow("import_tickets:status_not_in_project");
    expect(await scalar<string>("select title as v from public.tickets")).toBe("SO-1832 Fix payment issue");
  });

  it("rejects a status id that doesn't exist", async () => {
    await expect(
      runImport(ADMIN, [SO_1832], { status: "00000000-0000-0000-0000-0000000000ee" })
    ).rejects.toThrow("import_tickets:status_not_in_project");
    expect(await ticketCount()).toBe(0);
  });
});

describe("import_external_tickets — authorization and validation", () => {
  const rejects = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toThrow(code);

  it("rejects an unauthenticated caller", async () => {
    await rejects(runImport(null, [SO_1832]), "import_tickets:not_authorized");
  });

  it("rejects an org member who is neither Admin/Lead nor on the project", async () => {
    await rejects(runImport(OUTSIDER, [SO_1832]), "import_tickets:not_authorized");
    expect(await ticketCount()).toBe(0);
  });

  it("rejects a deactivated account even if it is still on the project", async () => {
    await db.query("update public.organization_memberships set status = 'disabled' where profile_id = $1", [MEMBER]);
    await rejects(runImport(MEMBER, [SO_1832]), "import_tickets:not_authorized");
  });

  it("allows an org Admin who is not on the project", async () => {
    expect((await runImport(ADMIN, [SO_1832]))[0].action).toBe("created");
  });

  it("rejects a status from another project", async () => {
    await rejects(runImport(ADMIN, [SO_1832], { status: OTHER_IMPORTED }), "import_tickets:status_not_in_project");
  });

  it("rejects an open status", async () => {
    await rejects(runImport(ADMIN, [SO_1832], { status: TODO }), "import_tickets:status_not_closed");
  });

  it("rejects an unsupported source", async () => {
    await rejects(runImport(ADMIN, [SO_1832], { source: "trello" }), "import_tickets:unsupported_source");
  });

  it("rejects an unknown or archived project", async () => {
    await rejects(
      runImport(ADMIN, [SO_1832], { project: "00000000-0000-0000-0000-0000000000ff" }),
      "import_tickets:project_not_found"
    );
    await db.query("update public.projects set status = 'archived' where id = $1", [PROJECT]);
    await rejects(runImport(ADMIN, [SO_1832]), "import_tickets:project_archived");
  });

  it("rejects malformed rows atomically — nothing from the same call is created", async () => {
    await rejects(runImport(ADMIN, [SO_1832, { ...DEP_7, title: "  " }]), "import_tickets:invalid_rows");
    await rejects(runImport(ADMIN, [{ ...DEP_7, type: "story" }]), "import_tickets:invalid_rows");
    await rejects(runImport(ADMIN, { not: "an array" }), "import_tickets:invalid_rows");
    expect(await ticketCount()).toBe(0);
  });

  it("enforces one ticket per project + source + Issue id at the index level too", async () => {
    await runImport(ADMIN, [SO_1832]);
    await expect(
      db.query(
        "insert into public.tickets (project_id, ticket_number, title, status_id, external_source, external_id) values ($1, 50, 'dup', $2, 'jira', '12345')",
        [PROJECT, IMPORTED]
      )
    ).rejects.toThrow(/tickets_external_identity_idx/);
  });
});
