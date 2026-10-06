// Database-level tests for JIR-118's import_external_tickets RPC.
//
// Runs the REAL migration files (20261006000000_import_external_tickets.sql,
// then 20261007000000_import_external_tickets_log_time.sql on top of it,
// in production order) against an embedded Postgres (PGlite) — on top of a minimal stand-in for
// the parts of the schema it touches (the tables it reads/writes and the
// three RLS helper functions it calls, copied from 20260708000000). The
// rest of the production schema (other triggers, RLS policies) is not
// loaded here, so this proves the function's own guarantees, not the
// whole stack.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const readMigration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${name}`, import.meta.url)), "utf8");
const MIGRATION = readMigration("20261006000000_import_external_tickets.sql");
const LOG_TIME_MIGRATION = readMigration("20261007000000_import_external_tickets_log_time.sql");

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
    parent_ticket_id uuid references public.tickets (id),
    updated_at timestamptz not null default now(),
    unique (project_id, ticket_number)
  );
  create table public.ticket_route_aliases (project_id uuid not null, ticket_number integer not null, ticket_id uuid);
  create table public.ticket_time_entries (
    id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.tickets (id) on delete cascade,
    logged_by uuid, minutes integer not null check (minutes > 0), work_date date not null, comment text,
    created_at timestamptz not null default now()
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

type Row = { external_id: string; external_key: string; title: string; type: "task" | "bug"; minutes?: number };
type Outcome = { external_id: string; ticket_id: string; ticket_number: number; action: string; logged_minutes: number };

// The caller's "today" — what the client sends as p_work_date.
const TODAY = new Date().toISOString().slice(0, 10);
const isoDaysFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const SO_1832: Row = { external_id: "12345", external_key: "SO-1832", title: "SO-1832 Fix payment issue", type: "bug" };
const DEP_7: Row = { external_id: "777", external_key: "DEP-7", title: "DEP-7 Release", type: "task" };

let db: PGlite;

async function runImport(
  actor: string | null,
  rows: unknown,
  overrides: { project?: string; source?: string; status?: string; workDate?: string | null } = {}
): Promise<Outcome[]> {
  await db.query("select set_config('test.uid', $1, false)", [actor ?? ""]);
  const result = await db.query<Outcome>(
    "select * from public.import_external_tickets($1, $2, $3, $4::jsonb, $5::date) order by ticket_number",
    [
      overrides.project ?? PROJECT,
      overrides.source ?? "jira",
      overrides.status ?? IMPORTED,
      JSON.stringify(rows),
      overrides.workDate === undefined ? TODAY : overrides.workDate,
    ]
  );
  return result.rows;
}

type TimeEntry = { external_id: string; logged_by: string; minutes: number; work_date: string; comment: string | null };
async function timeEntries(): Promise<TimeEntry[]> {
  return (
    await db.query<TimeEntry>(
      `select t.external_id, e.logged_by, e.minutes, e.work_date::text as work_date, e.comment
       from public.ticket_time_entries e join public.tickets t on t.id = e.ticket_id
       order by e.created_at, e.minutes`
    )
  ).rows;
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
  await db.exec(LOG_TIME_MIGRATION);
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

describe("import_external_tickets — hours typed in the preview", () => {
  it("creates exactly one real time entry for a new ticket with 2h: importer, today, no comment", async () => {
    const [outcome] = await runImport(MEMBER, [{ ...SO_1832, minutes: 120 }]);
    expect(outcome).toMatchObject({ action: "created", logged_minutes: 120 });
    expect(await timeEntries()).toEqual([
      { external_id: "12345", logged_by: MEMBER, minutes: 120, work_date: TODAY, comment: null },
    ]);
    // The ticket itself is still a normal JIR-118 ticket: assigned to the importer, Imported status.
    const ticket = (await db.query("select assignee_profile_id, status_id from public.tickets")).rows[0];
    expect(ticket).toEqual({ assignee_profile_id: MEMBER, status_id: IMPORTED });
  });

  it("creates no time entry for blank, null or zero hours", async () => {
    const outcome = await runImport(MEMBER, [
      SO_1832,
      { ...DEP_7, minutes: 0 },
      { external_id: "9", external_key: "OA-9", title: "OA-9 Nothing", type: "task", minutes: null },
    ]);
    expect(outcome.map((o) => o.logged_minutes)).toEqual([0, 0, 0]);
    expect(await ticketCount()).toBe(3);
    expect(await timeEntries()).toEqual([]);
  });

  it("gives every ticket its own independent entry with the exact minutes", async () => {
    await runImport(MEMBER, [
      { ...SO_1832, minutes: 90 },
      { ...DEP_7, minutes: 20 },
      { external_id: "9", external_key: "OA-9", title: "OA-9 No time", type: "task" },
      { external_id: "10", external_key: "OA-10", title: "OA-10 Tiny", type: "task", minutes: 1 },
    ]);
    const entries = await timeEntries();
    expect(Object.fromEntries(entries.map((e) => [e.external_id, e.minutes]))).toEqual({ "12345": 90, "777": 20, "10": 1 });
    expect(entries.every((e) => e.logged_by === MEMBER && e.work_date === TODAY)).toBe(true);
    expect(await scalar<number>("select sum(minutes)::int as v from public.ticket_time_entries")).toBe(111);
  });

  it("adds a NEW entry on an existing ticket — DEP-994 2h then 3h is two entries, 5h total", async () => {
    const dep994: Row = { external_id: "994", external_key: "DEP-994", title: "DEP-994 OA-907", type: "task" };
    const [first] = await runImport(MEMBER, [{ ...dep994, minutes: 120 }]);
    const firstEntry = await timeEntrySnapshot();

    const [second] = await runImport(MEMBER, [{ ...dep994, minutes: 180 }]);
    expect(second).toMatchObject({ action: "unchanged", ticket_id: first.ticket_id, logged_minutes: 180 });
    expect(await ticketCount()).toBe(1);

    const entries = await timeEntries();
    expect(entries.map((e) => e.minutes)).toEqual([120, 180]);
    expect(await scalar<number>("select sum(minutes)::int as v from public.ticket_time_entries")).toBe(300);
    // The first entry is byte-for-byte what it was before the second import.
    const earliest = await scalar<string>(
      "select json_agg(e)::text as v from (select * from public.ticket_time_entries order by created_at limit 1) e"
    );
    expect(earliest).toBe(firstEntry);
  });

  it("re-importing the same file with the same hours is a new logging action, never deduplicated", async () => {
    await runImport(MEMBER, [{ ...SO_1832, minutes: 60 }]);
    await runImport(MEMBER, [{ ...SO_1832, minutes: 60 }]);
    expect((await timeEntries()).map((e) => e.minutes)).toEqual([60, 60]);
    expect(await ticketCount()).toBe(1);
  });

  it("leaves an existing ticket's entries untouched when re-imported with no hours", async () => {
    const [first] = await runImport(MEMBER, [{ ...SO_1832, minutes: 60 }]);
    await db.query(
      "insert into public.ticket_time_entries (ticket_id, logged_by, minutes, work_date, comment) values ($1, $2, 45, '2026-10-01', 'manual')",
      [first.ticket_id, JUAN]
    );
    const before = await timeEntrySnapshot();
    await runImport(ADMIN, [SO_1832]);
    await runImport(ADMIN, [{ ...SO_1832, title: "SO-1832 Renamed", minutes: 0 }]);
    expect(await timeEntrySnapshot()).toBe(before);
  });

  it("logs time for whoever runs this import, and keeps the existing ticket's assignee, creator and status", async () => {
    const [first] = await runImport(MEMBER, [{ ...SO_1832, minutes: 30 }]);
    await db.query("update public.tickets set status_id = $1 where id = $2", [IN_PROGRESS, first.ticket_id]);
    await runImport(JUAN, [{ ...SO_1832, minutes: 75 }], { status: DONE });
    expect((await timeEntries()).map((e) => [e.logged_by, e.minutes])).toEqual([
      [MEMBER, 30],
      [JUAN, 75],
    ]);
    const ticket = (await db.query("select assignee_profile_id, created_by, status_id from public.tickets")).rows[0];
    expect(ticket).toEqual({ assignee_profile_id: MEMBER, created_by: MEMBER, status_id: IN_PROGRESS });
  });

  it("ignores any person or worklog data sent in a row — only the caller and the typed minutes count", async () => {
    await runImport(MEMBER, [
      {
        ...SO_1832,
        minutes: 15,
        logged_by: JUAN,
        assignee: "Someone From Jira",
        time_spent: 36000,
        log_work: "did work;01/Oct/26 3:00 PM;juan;7200",
        work_date: "2020-01-01",
      },
    ]);
    expect(await timeEntries()).toEqual([
      { external_id: "12345", logged_by: MEMBER, minutes: 15, work_date: TODAY, comment: null },
    ]);
  });

  it("uses the last row's minutes when an Issue id is duplicated in one payload", async () => {
    await runImport(MEMBER, [{ ...SO_1832, minutes: 60 }, { ...SO_1832, minutes: 25 }]);
    expect((await timeEntries()).map((e) => e.minutes)).toEqual([25]);
  });

  it("accepts the caller's local date one day either side of the server's, and nothing further", async () => {
    await runImport(MEMBER, [{ ...SO_1832, minutes: 10 }], { workDate: isoDaysFromToday(-1) });
    await runImport(MEMBER, [{ ...SO_1832, minutes: 10 }], { workDate: isoDaysFromToday(1) });
    expect(await scalar<number>("select count(*)::int as v from public.ticket_time_entries")).toBe(2);
    for (const workDate of [isoDaysFromToday(-2), isoDaysFromToday(2), "2020-01-01", null]) {
      await expect(runImport(MEMBER, [{ ...DEP_7, minutes: 10 }], { workDate })).rejects.toThrow(
        "import_tickets:invalid_work_date"
      );
    }
    expect(await scalar<number>("select count(*)::int as v from public.ticket_time_entries")).toBe(2);
  });

  it("doesn't need a work date when no row logs time (a client that predates this feature)", async () => {
    await db.query("select set_config('test.uid', $1, false)", [MEMBER]);
    const result = await db.query<Outcome>(
      "select * from public.import_external_tickets(p_project_id => $1, p_source => 'jira', p_status_id => $2, p_rows => $3::jsonb)",
      [PROJECT, IMPORTED, JSON.stringify([SO_1832])]
    );
    expect(result.rows[0]).toMatchObject({ action: "created", logged_minutes: 0 });
  });

  it.each([
    ["negative", -30],
    ["fractional", 90.5],
    ["text", "90"],
    ["boolean", true],
    ["too large for the integer column", 123456789012],
  ])("rejects %s minutes and imports nothing", async (_label, minutes) => {
    await expect(runImport(MEMBER, [DEP_7, { ...SO_1832, minutes }])).rejects.toThrow("import_tickets:invalid_minutes");
    expect(await ticketCount()).toBe(0);
    expect(await timeEntries()).toEqual([]);
  });

  it("has no 24-hour maximum per entry — same as Log Time", async () => {
    await runImport(MEMBER, [
      { ...SO_1832, minutes: 1440 },
      { ...DEP_7, minutes: 1441 },
      { external_id: "9", external_key: "OA-9", title: "OA-9 Long", type: "task", minutes: 6000 },
      { external_id: "10", external_key: "OA-10", title: "OA-10 Huge", type: "task", minutes: 999999999 },
    ]);
    expect((await timeEntries()).map((e) => e.minutes).sort((a, b) => a - b)).toEqual([1440, 1441, 6000, 999999999]);
  });

  it("rolls back tickets AND time entries together when anything fails mid-import", async () => {
    // An existing imported ticket that has since been given a child: time can't be logged on it.
    const [parent] = await runImport(MEMBER, [SO_1832]);
    await db.query(
      "insert into public.tickets (project_id, ticket_number, title, status_id, parent_ticket_id) values ($1, 99, 'child', $2, $3)",
      [PROJECT, TODO, parent.ticket_id]
    );
    const ticketsBefore = await ticketCount();

    // Sorted by Issue id text, "100" (new, with hours) is processed before "12345" (the parent) fails.
    await expect(
      runImport(MEMBER, [
        { external_id: "100", external_key: "OA-100", title: "OA-100 New with time", type: "task", minutes: 60 },
        { ...SO_1832, title: "SO-1832 Renamed", minutes: 30 },
      ])
    ).rejects.toThrow("import_tickets:time_on_parent_ticket");

    expect(await ticketCount()).toBe(ticketsBefore);
    expect(await timeEntries()).toEqual([]);
    expect(await scalar<string>("select title as v from public.tickets where external_id = '12345'")).toBe(
      "SO-1832 Fix payment issue"
    );
  });

  it("still allows a parent ticket to be re-imported when no hours are entered for it", async () => {
    const [parent] = await runImport(MEMBER, [SO_1832]);
    await db.query(
      "insert into public.tickets (project_id, ticket_number, title, status_id, parent_ticket_id) values ($1, 99, 'child', $2, $3)",
      [PROJECT, TODO, parent.ticket_id]
    );
    const [again] = await runImport(MEMBER, [{ ...SO_1832, title: "SO-1832 Renamed" }]);
    expect(again.action).toBe("updated");
  });

  it("still rejects unauthorized callers and bad statuses before logging anything", async () => {
    const rows = [{ ...SO_1832, minutes: 60 }];
    await expect(runImport(OUTSIDER, rows)).rejects.toThrow("import_tickets:not_authorized");
    await expect(runImport(null, rows)).rejects.toThrow("import_tickets:not_authorized");
    await expect(runImport(MEMBER, rows, { status: TODO })).rejects.toThrow("import_tickets:status_not_closed");
    await expect(runImport(MEMBER, rows, { status: OTHER_IMPORTED })).rejects.toThrow(
      "import_tickets:status_not_in_project"
    );
    expect(await ticketCount()).toBe(0);
    expect(await timeEntries()).toEqual([]);
  });

  it("is not callable by anon, and leaves no older overload of the function behind", async () => {
    const overloads = await scalar<number>(
      "select count(*)::int as v from pg_proc where proname = 'import_external_tickets'"
    );
    expect(overloads).toBe(1);
    expect(
      await scalar<boolean>(
        "select has_function_privilege('anon', 'public.import_external_tickets(uuid, text, uuid, jsonb, date)', 'execute') as v"
      )
    ).toBe(false);
    expect(
      await scalar<boolean>(
        "select has_function_privilege('authenticated', 'public.import_external_tickets(uuid, text, uuid, jsonb, date)', 'execute') as v"
      )
    ).toBe(true);
  });
});
