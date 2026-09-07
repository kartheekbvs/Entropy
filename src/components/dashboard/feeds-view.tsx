"use client";

import { useMemo, useState } from "react";
import {
  Brain,
  ChartColumn,
  Code2,
  ExternalLink,
  FlaskConical,
  Globe,
  MapPin,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import { Separator } from "@/components/ui/separator";
import {
  ROLE_PRESETS,
  CITY_PRESETS,
  buildBoardLinks,
  RolePreset,
  CityPreset,
} from "@/lib/job-links";

const ROLE_ICONS: Record<string, React.ElementType> = {
  brain: Brain,
  flask: FlaskConical,
  chart: ChartColumn,
  code: Code2,
};

const BOARD_ACCENT: Record<string, string> = {
  Naukri: "border-sky-500/40 hover:border-sky-400/70",
  LinkedIn: "border-sky-500/40 hover:border-sky-400/70",
  "Internshala (Internships)": "border-border hover:border-primary/50",
  "Internshala (Jobs)": "border-border hover:border-primary/50",
  Foundit: "border-border hover:border-primary/50",
  "Google Jobs": "border-border hover:border-primary/50",
};

function Chip({
  active,
  children,
  onClick,
  "aria-pressed": ariaPressed,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
  "aria-pressed"?: boolean;
}) {
  return (
    <Toggle
      size="sm"
      pressed={active}
      onPressedChange={onClick}
      aria-pressed={ariaPressed}
      className={`h-9 gap-1.5 rounded-full border px-3.5 text-xs font-medium data-[state=on]:border-primary/60 data-[state=on]:bg-primary/15 data-[state=on]:text-primary ${
        active ? "" : "border-border bg-secondary/50 text-muted-foreground"
      }`}
    >
      {children}
    </Toggle>
  );
}

export function FeedsView({ onLog }: { onLog: () => void }) {
  const [activeRoles, setActiveRoles] = useState<string[]>(ROLE_PRESETS.map((r) => r.id));
  const [activeCities, setActiveCities] = useState<string[]>(["hyderabad", "bengaluru", "remote"]);
  const [jobAge, setJobAge] = useState(1);
  const [sweepedAt, setSweepedAt] = useState<Date | null>(new Date());

  const combos = useMemo(() => {
    const roles = ROLE_PRESETS.filter((r) => activeRoles.includes(r.id));
    const cities = CITY_PRESETS.filter((c) => activeCities.includes(c.id));
    const list: { role: RolePreset; city: CityPreset; links: ReturnType<typeof buildBoardLinks> }[] = [];
    for (const role of roles) {
      for (const city of cities) {
        list.push({ role, city, links: buildBoardLinks(role, city, jobAge) });
      }
    }
    return list;
  }, [activeRoles, activeCities, jobAge]);

  const toggleRole = (id: string) =>
    setActiveRoles((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleCity = (id: string) =>
    setActiveCities((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const totalLinks = combos.length * 6;

  return (
    <div className="space-y-6">
      <section
        className="rounded-xl border border-border/70 bg-card/80 p-4 sm:p-5"
        aria-labelledby="feed-controls"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="feed-controls" className="text-base font-semibold">
            Daily feed sweep
          </h2>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1">
              {[1, 3, 7].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setJobAge(d)}
                  aria-pressed={jobAge === d}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    jobAge === d
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  ≤ {d}d old
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => setSweepedAt(new Date())}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Re-sweep
            </Button>
          </div>
        </div>

        <Separator className="my-4" />

        <div className="space-y-4">
          <div>
            <p className="microlabel mb-2 text-muted-foreground">Role tracks</p>
            <div className="flex flex-wrap gap-2">
              {ROLE_PRESETS.map((role) => {
                const Icon = ROLE_ICONS[role.icon] ?? Code2;
                return (
                  <Chip key={role.id} active={activeRoles.includes(role.id)} onClick={() => toggleRole(role.id)}>
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {role.label}
                  </Chip>
                );
              })}
            </div>
          </div>
          <div>
            <p className="microlabel mb-2 text-muted-foreground">
              <MapPin className="mr-1 inline h-3 w-3" aria-hidden="true" />
              Locations
            </p>
            <div className="flex flex-wrap gap-2">
              {CITY_PRESETS.map((city) => (
                <Chip key={city.id} active={activeCities.includes(city.id)} onClick={() => toggleCity(city.id)}>
                  {city.label}
                </Chip>
              ))}
            </div>
          </div>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          {combos.length} role × location tracks armed · {totalLinks} deep links ready · filters
          pre-applied (fresher + internship/entry + freshness) ·{" "}
          {sweepedAt && `last sweep ${sweepedAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`}
        </p>
      </section>

      {/* How to use — collapse later if needed */}
      <section className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm" aria-label="Daily routine">
        <p className="font-medium text-primary">The 15-minute daily routine</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>Open each Naukri / LinkedIn link below (they open pre-filtered to fresh, fresher-level jobs).</li>
          <li>Shortlist 5–10 roles, apply on the board, then log them in the Tracker (1 click each).</li>
          <li>For any role you&apos;re unsure about, paste its JD into the Match tab for an instant fit score.</li>
          <li>Log recruiter contacts as they reach out to you in the Contacts tab.</li>
        </ol>
        <Button size="sm" variant="outline" className="mt-3 gap-1.5" onClick={onLog}>
          Go to Tracker
        </Button>
      </section>

      {/* Link cards */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {combos.map(({ role, city, links }) => (
          <Card
            key={`${role.id}-${city.id}`}
            className="flex flex-col border-border/70 bg-card/80 transition-colors hover:border-primary/30"
          >
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  {(() => {
                    const Icon = ROLE_ICONS[role.icon] ?? Code2;
                    return <Icon className="h-4 w-4 text-primary/80" aria-hidden="true" />;
                  })()}
                  {role.label}
                </span>
                <Badge
                  variant="outline"
                  className="shrink-0 border-border/70 bg-secondary/60 text-[10px] font-normal text-muted-foreground"
                >
                  <MapPin className="mr-1 h-3 w-3" aria-hidden="true" />
                  {city.label}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-2">
              {links.map((link) => (
                <a
                  key={link.board}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`group flex items-center justify-between gap-2 rounded-lg border bg-secondary/30 px-3 py-2.5 transition-all hover:bg-primary/10 ${BOARD_ACCENT[link.board] ?? "border-border"}`}
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium group-hover:text-primary">
                      {link.board}
                      {link.accent && (
                        <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                      )}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">{link.note}</p>
                  </div>
                  <ExternalLink
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary"
                    aria-hidden="true"
                  />
                </a>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      {combos.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <Globe className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              Select at least one role track and one location to arm your feed sweep.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
