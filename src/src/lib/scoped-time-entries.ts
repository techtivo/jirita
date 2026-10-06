import { loadOrganizationLoggedTimeForRange, loadProfileTimeEntriesForRange } from "@/lib/tickets";
import type { OrganizationTimeEntry, OrganizationLoggedTimeResult } from "@/lib/tickets";
import { keepOwnEntries } from "@/lib/time-tracking-scope";

// Time entries for a Project Lead's two scopes (see lib/time-tracking-scope.ts),
// shared by Time Tracking, Reports and the Hours Report so all three read
// other people's time under exactly the same rule: the whole-team read
// (loadOrganizationLoggedTimeForRange) is only ever issued for led-project
// tickets; own-only project tickets go through
// loadProfileTimeEntriesForRange, whose query itself filters
// `logged_by = profileId` — so having access to a member-only project can
// never pull anyone else's hours onto a screen.
export async function loadScopedTimeEntries(
  ledTicketIds: string[],
  ownOnlyTicketIds: string[],
  profileId: string,
  from: string,
  to: string
): Promise<OrganizationLoggedTimeResult> {
  const [ledResult, ownResult] = await Promise.all([
    loadOrganizationLoggedTimeForRange(ledTicketIds, from, to),
    loadProfileTimeEntriesForRange(profileId, ownOnlyTicketIds, from, to),
  ]);
  if (ledResult.status === "error") return ledResult;
  if (ownResult.status === "error") return ownResult;
  const ownEntries = keepOwnEntries(
    ownResult.entries.map((r): OrganizationTimeEntry => ({
      ticketId: r.ticketId,
      loggedBy: r.loggedByProfileId,
      minutes: r.minutes,
      workDate: r.workDate,
      comment: r.comment,
    })),
    profileId
  );
  return { status: "ready", entries: [...ledResult.entries, ...ownEntries] };
}
