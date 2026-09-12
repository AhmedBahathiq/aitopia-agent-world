import { WorldExperience } from "@/components/world-experience";
import type { ApiEnvelope, PublicWorldSnapshot, SeasonSummary } from "@/shared/contracts";

export const dynamic = "force-dynamic";

export default async function Home() {
  const engineUrl = process.env.ENGINE_PUBLIC_URL ?? null;
  let initialWorld: PublicWorldSnapshot | null = null;
  if (engineUrl) {
    try {
      const seasonResponse = await fetch(`${engineUrl}/api/seasons`, { cache: "no-store" });
      const seasons = await seasonResponse.json() as ApiEnvelope<SeasonSummary[]>;
      const seasonId = seasons.ok ? seasons.data[0]?.id : undefined;
      if (seasonId) {
        const snapshotResponse = await fetch(`${engineUrl}/api/seasons/${encodeURIComponent(seasonId)}/snapshot`, { cache: "no-store" });
        const snapshot = await snapshotResponse.json() as ApiEnvelope<PublicWorldSnapshot>;
        if (snapshot.ok) initialWorld = snapshot.data;
      }
    } catch { /* the client retries without fabricating world data */ }
  }
  return <WorldExperience initialWorld={initialWorld} engineUrl={engineUrl} />;
}
