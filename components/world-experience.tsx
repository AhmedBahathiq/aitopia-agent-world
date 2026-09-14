"use client";

import {
  Apple, Archive, CloudSun, Droplets, Flame, Hammer, Heart, Languages, Leaf, Map,
  MessageCircle, Mountain, Radio, RefreshCw, ShieldCheck, Sparkles, Swords, Trees, Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  ApiEnvelope, PublicCharacterState, PublicWorldSnapshot, ResolvedEvent, SeasonSummary,
} from "@/shared/contracts";

const eventIcons: Record<ResolvedEvent["kind"], typeof MessageCircle> = {
  speech: MessageCircle, action: Hammer, environment: CloudSun, relationship: Heart,
  birth: Users, death: Archive, discovery: Sparkles, conflict: Swords, migration: Map,
  settlement: Map, government: ShieldCheck, language: Languages, intervention: ShieldCheck,
  migration_record: RefreshCw, milestone: Flame, system: Radio, sexual_assault: ShieldCheck,
};

const weatherNames = { clear: "سماء صافية", cloudy: "غائم", rain: "ممطر", storm: "عاصفة" };
type ConnectionState = "connecting" | "connected" | "disconnected";

export function WorldExperience({ initialWorld, engineUrl }: { initialWorld: PublicWorldSnapshot | null; engineUrl: string | null }) {
  const [world, setWorld] = useState(initialWorld);
  const [seasons, setSeasons] = useState<SeasonSummary[]>([]);
  const [seasonId, setSeasonId] = useState(initialWorld?.seasonId ?? "");
  const [connection, setConnection] = useState<ConnectionState>(initialWorld ? "connected" : "connecting");
  const [selectedId, setSelectedId] = useState(initialWorld?.characters[0]?.id ?? "");
  const [view, setView] = useState<"social" | "omniscient">("social");

  const loadSnapshot = useCallback(async (id: string) => {
    if (!engineUrl || !id) { setConnection("disconnected"); return; }
    try {
      const response = await fetch(`${engineUrl}/api/seasons/${encodeURIComponent(id)}/snapshot?view=${view}`, { cache: "no-store" });
      const envelope = await response.json() as ApiEnvelope<PublicWorldSnapshot>;
      if (!response.ok || !envelope.ok) throw new Error("snapshot_unavailable");
      setWorld(envelope.data);
      setConnection("connected");
    } catch { setConnection("disconnected"); }
  }, [engineUrl, view]);

  const loadSeasons = useCallback(async () => {
    if (!engineUrl) { setConnection("disconnected"); return; }
    try {
      const response = await fetch(`${engineUrl}/api/seasons`, { cache: "no-store" });
      const envelope = await response.json() as ApiEnvelope<SeasonSummary[]>;
      if (!response.ok || !envelope.ok) throw new Error("seasons_unavailable");
      setSeasons(envelope.data);
      const requested = new URLSearchParams(window.location.search).get("season");
      const next = requested && envelope.data.some((season) => season.id === requested)
        ? requested
        : seasonId && envelope.data.some((season) => season.id === seasonId)
          ? seasonId
          : envelope.data[0]?.id ?? "";
      if (next) {
        setSeasonId(next);
        await loadSnapshot(next);
      } else {
        setWorld(null);
        setConnection("connected");
      }
    } catch { setConnection("disconnected"); }
  }, [engineUrl, loadSnapshot, seasonId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSeasons(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSeasons]);
  useEffect(() => {
    if (!seasonId) return;
    const timer = window.setInterval(() => void loadSnapshot(seasonId), 15_000);
    return () => window.clearInterval(timer);
  }, [loadSnapshot, seasonId]);
  useEffect(() => {
    if (!engineUrl || !seasonId || view !== "social") return;
    const streamUrl = new URL(engineUrl);
    streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
    streamUrl.pathname = `/agents/public-stream-agent/${encodeURIComponent(seasonId)}`;
    const socket = new WebSocket(streamUrl);
    socket.onopen = () => setConnection("connected");
    socket.onmessage = (message) => {
      try {
        const payload = JSON.parse(String(message.data)) as { type?: string; state?: PublicWorldSnapshot } | PublicWorldSnapshot;
        const snapshot = "state" in payload ? payload.state : "seasonId" in payload ? payload : undefined;
        if (snapshot?.seasonId === seasonId) setWorld(snapshot);
      } catch { /* polling remains the recovery path */ }
    };
    socket.onerror = () => setConnection("disconnected");
    return () => socket.close();
  }, [engineUrl, seasonId, view]);
  if (!world) {
    return <main className="empty-world"><div className="empty-orbit"><Flame size={30} /></div><span className="eyebrow">آيتوبيا</span><h1>{connection === "connecting" ? "جاري الاتصال بالعالم…" : "العالم ينتظر موسمه الأول"}</h1><p>{connection === "disconnected" ? "تعذر الوصول إلى المحرك الآن. لا نعرض بيانات وهمية؛ حاول مرة أخرى بعد قليل." : "لا توجد حياة بدأت بعد."}</p><button onClick={() => { setConnection("connecting"); void loadSeasons(); }}><RefreshCw size={17} /> إعادة المحاولة</button></main>;
  }

  const selected = world.characters.find((person) => person.id === selectedId) ?? world.characters[0];
  const living = world.characters;
  const dateLabel = world.simDay === 0 ? "قبل اليوم الأول" : `السنة ${Math.floor(world.simDay / 360) + 1} · الشهر ${Math.floor((world.simDay % 360) / 30) + 1} · اليوم ${Math.floor(world.simDay % 30) + 1}`;
  const status = statusLabel(world, connection);
  const resourceCards = [
    { label: "الماء", value: `${Math.floor(world.resources.water)} وحدة`, icon: Droplets, tone: "cyan" },
    { label: "الغذاء", value: `${Math.floor(world.resources.food)} وحدة`, icon: Apple, tone: "amber" },
    { label: "الخشب", value: String(Math.floor(world.resources.wood)), icon: Trees, tone: "green" },
    { label: "المأوى", value: `${Math.floor(world.resources.shelter)} وحدة`, icon: Hammer, tone: "rose" },
  ];

  return <main className="world-shell">
    <header className="topbar">
      <div className="brand-block"><div className="brand-mark"><Flame size={20} /></div><div><h1>آيتوبيا</h1><p>مرصد الحياة على الجزيرة</p></div></div>
      <div className="world-clock" aria-label="حالة العالم"><span className={`live-pill ${status.tone}`}><Radio size={13} /> {status.text}</span><span className="clock-primary">{dateLabel}</span><span className="clock-secondary"><CloudSun size={16} /> {world.temperatureC}° · {weatherNames[world.weather]}</span></div>
      <div className="header-actions"><select className="season-select" value={view} onChange={(event) => setView(event.target.value as "social" | "omniscient")} aria-label="منظور التاريخ"><option value="social">الرواية الاجتماعية</option><option value="omniscient">الحقيقة المرصودة</option></select>{seasons.length > 1 && <select className="season-select" value={seasonId} onChange={(event) => { setSeasonId(event.target.value); void loadSnapshot(event.target.value); }} aria-label="اختيار الموسم">{seasons.map((season) => <option key={season.id} value={season.id}>{season.title}{season.status === "archived" ? " — مؤرشف" : ""}</option>)}</select>}<span className="observer-badge"><span /> مشاهدة عامة</span></div>
    </header>

    <section className="resource-strip" aria-label="موارد الجزيرة"><div className="population-stat"><Users size={19} /><div><strong>{world.livingPopulation}</strong><span>سكان أحياء</span></div></div>{resourceCards.map(({ label, value, icon: Icon, tone }) => <div className={`resource-card ${tone}`} key={label}><Icon size={18} /><span>{label}</span><strong>{value}</strong></div>)}<div className="stability archive-stat"><Archive size={16} /><span>السجل الدائم</span><strong>{world.deceasedPopulation} متوفى</strong></div></section>

    <div className="experience-grid">
      <section className="map-panel" aria-label="خريطة الجزيرة"><div className="map-image" role="img" aria-label="جزيرة استوائية فيها شاطئ وغابة ونبع ومخيم ومرتفعات"><div className="map-vignette" /><div className="zone-label spring"><Droplets size={14} /> النبع</div><div className="zone-label forest"><Trees size={14} /> الغابة</div><div className="zone-label ridge"><Mountain size={14} /> المرتفعات</div><div className="zone-label camp"><Flame size={14} /> المخيم</div><div className="zone-label grassland"><Leaf size={14} /> السهل</div>
        {living.map((person) => <PersonToken key={person.id} person={person} selected={selected?.id === person.id} onSelect={() => setSelectedId(person.id)} speech={world.recentEvents.find((event) => event.kind === "speech" && event.actorId === person.id)?.text} />)}
        <div className={`map-status ${status.tone}`}><span className="weather-dot" />{world.tick === 0 && world.status === "paused" ? "العالم جاهز — لم يبدأ الوقت بعد" : world.status === "archived" ? "هذا الموسم مؤرشف" : world.status === "paused" ? "الموسم متوقف" : "تتجدد الحياة كل 30 ثانية"}</div></div>
        {selected && <article className="agent-drawer" aria-live="polite"><div className="agent-identity"><span className="large-avatar" style={{ background: selected.color }}>{selected.name.slice(0, 1)}</span><div><strong>{selected.name}</strong><span>{Math.floor(selected.ageYears)} سنة · {selected.traits.join("، ")}</span></div></div><div className="agent-metrics"><Metric icon={Heart} label="الصحة" value={selected.health} /><Metric icon={Flame} label="الطاقة" value={selected.energy} /></div><div className="current-intent"><span>النشاط الحالي</span><strong>{selected.currentActivity?.intent ?? "يراقب محيطه دون هدف مفروض"}</strong></div><a href={`/agents/${selected.id}?season=${world.seasonId}`} className="profile-link">السيرة العامة</a></article>}
      </section>

      <aside className="event-panel" aria-label="سجل الأحداث"><div className="panel-heading"><div><span className="eyebrow">المشهد المباشر</span><h2>{view === "social" ? "ما يعرفه المجتمع" : "ما حدث فعليًا"}</h2></div><button className="refresh-button" aria-label="تحديث" onClick={() => void loadSnapshot(seasonId)}><RefreshCw size={16} /></button></div><div className="event-list">{world.recentEvents.length ? world.recentEvents.map((event) => <EventItem key={event.id} event={event} world={world} />) : <div className="empty-events"><Radio size={22} /><strong>لم تبدأ الحياة بعد</strong><span>ستظهر القرارات والحوارات هنا بعد إشارة البدء.</span></div>}</div><div className="observer-note"><ShieldCheck size={17} /><p>الكلام داخل العالم لا يملك صلاحيات تشغيلية. الأحداث الحساسة تُعرض بصياغة مجردة، ولا ننشر الاستدلال الداخلي.</p></div></aside>
    </div>
  </main>;
}

function statusLabel(world: PublicWorldSnapshot, connection: ConnectionState) {
  if (connection === "disconnected") return { text: "إعادة اتصال", tone: "offline" };
  if (world.status === "paused" && world.tick === 0) return { text: "جاهز للبدء", tone: "ready" };
  if (world.status === "paused") return { text: "متوقف", tone: "paused" };
  if (world.status === "ai_paused") return { text: "متوقف مؤقتًا — رصيد AI", tone: "offline" };
  if (world.status === "archived") return { text: "مؤرشف", tone: "archived" };
  if (world.status === "extinct") return { text: "انتهى الموسم", tone: "offline" };
  return { text: "مباشر", tone: "live" };
}

function PersonToken({ person, selected, onSelect, speech }: { person: PublicCharacterState; selected: boolean; onSelect(): void; speech?: string }) {
  return <button className={`person-token ${selected ? "selected" : ""}`} style={{ left: `${person.position.x}%`, top: `${person.position.y}%`, "--person-color": person.color } as React.CSSProperties} onClick={onSelect} aria-label={`عرض حالة ${person.name}`}><span className="token-ring"><span className="token-avatar">{person.name.slice(0, 1)}</span></span><span className="token-name">{person.name}</span>{speech && <span className="speech-bubble">{speech}</span>}</button>;
}

function EventItem({ event, world }: { event: ResolvedEvent; world: PublicWorldSnapshot }) {
  const Icon = eventIcons[event.kind];
  const color = event.actorId ? world.characters.find((person) => person.id === event.actorId)?.color ?? "#6ab7c7" : "#6ab7c7";
  return <article className="event-item"><div className="event-icon" style={{ color, borderColor: `${color}55` }}><Icon size={17} /></div><div className="event-copy"><div className="event-meta"><strong style={{ color }}>{event.actorName}</strong><time>اليوم {Math.floor(event.simDay)}</time></div><p>{event.text}</p><span>{event.omniscientDetail}</span></div></article>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof Heart; label: string; value: number }) {
  return <div className="metric"><span><Icon size={15} /> {label}</span><div className="mini-track"><i style={{ width: `${value}%` }} /></div><strong>{Math.round(value)}%</strong></div>;
}
