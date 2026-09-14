import { ArrowRight, Archive, Brain, MapPin, Shield, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import type { ApiEnvelope, HistoricalPersonSnapshot, PublicCharacterState, PublicWorldSnapshot } from "@/shared/contracts";

export const dynamic = "force-dynamic";

type PersonResponse = { person: PublicCharacterState; claims?: Array<{ id: string; statement: string; confidence: number }> } | HistoricalPersonSnapshot;

export default async function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ season?: string; view?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const engine = process.env.ENGINE_PUBLIC_URL;
  const view = query.view === "social" ? "social" : "omniscient";
  let world: PublicWorldSnapshot | null = null;
  let record: PersonResponse | null = null;
  if (engine && query.season) {
    try {
      const [snapshotResponse, personResponse] = await Promise.all([
        fetch(`${engine}/api/seasons/${encodeURIComponent(query.season)}/snapshot?view=${view}`, { cache: "no-store" }),
        fetch(`${engine}/api/seasons/${encodeURIComponent(query.season)}/characters/${encodeURIComponent(id)}?view=${view}`, { cache: "no-store" }),
      ]);
      const snapshot = await snapshotResponse.json() as ApiEnvelope<PublicWorldSnapshot>;
      const person = await personResponse.json() as ApiEnvelope<PersonResponse>;
      if (snapshotResponse.ok && snapshot.ok) world = snapshot.data;
      if (personResponse.ok && person.ok) record = person.data;
    } catch { /* show an honest unavailable state */ }
  }
  const person = record?.person ?? world?.characters.find((character) => character.id === id);
  if (!world || !person) return <main className="detail-shell unavailable-profile"><Link className="back-link" href="/"><ArrowRight size={17} /> العودة إلى الجزيرة</Link><section className="detail-card"><h1>السجل غير متاح الآن</h1><p className="muted-copy">تعذر تحميل هذه الشخصية من الأرشيف الحقيقي. لم نستبدلها ببيانات تجريبية.</p></section></main>;

  const archived = isHistorical(record) ? record : null;
  const relations = archived?.relationshipHistory ?? world.relationships.filter((relation) => relation.fromId === person.id || relation.toId === person.id);
  const memories = archived?.importantMemories ?? world.recentEvents.filter((event) => event.actorId === person.id || event.targetIds.includes(person.id)).slice(0, 8).map((event) => ({ id: event.id, summary: event.text, simDay: event.simDay }));
  const zoneNames = { beach: "الشاطئ", spring: "النبع", forest: "الغابة", grassland: "السهل", camp: "المخيم", ridge: "المرتفعات" };

  return <main className="detail-shell"><Link className="back-link" href={`/?season=${world.seasonId}`}><ArrowRight size={17} /> العودة إلى الجزيرة</Link><section className="profile-hero"><div className="profile-avatar" style={{ background: person.color }}>{person.name.slice(0, 1)}</div><div><span className="eyebrow">{person.lifeStatus === "deceased" ? "الأرشيف التاريخي الدائم" : "سجل شخصية عام"}</span><h1>{person.name}</h1><p>{Math.floor(person.ageYears)} سنة · {stageLabel(person.lifeStage)} · {person.lifeStatus === "alive" ? "على قيد الحياة" : "متوفى ومحفوظ في الأرشيف"}</p></div></section>
    <div className="detail-grid"><section className="detail-card"><h2><Brain size={18} /> الحالة والنشاط</h2><p className="large-copy">{person.currentActivity?.intent ?? (person.lifeStatus === "deceased" ? "توقفت الجدولة والقرارات بعد الوفاة." : "لا يوجد نشاط جارٍ الآن.")}</p><div className="stat-grid"><Stat label="الصحة" value={person.health} /><Stat label="الطاقة" value={person.energy} /><Stat label="المعنويات" value={person.morale} /><Stat label="الهدوء" value={100 - person.stress} /></div></section><section className="detail-card"><h2><Sparkles size={18} /> السمات والاستعدادات</h2><h3>السمات</h3><div className="chips">{person.traits.map((trait) => <span key={trait}>{trait}</span>)}</div><h3>الاستعدادات</h3><div className="chips">{person.aptitudes.length ? person.aptitudes.map((aptitude) => <span key={aptitude}>{aptitude}</span>) : <span>لم تُرصد بعد</span>}</div><p className="location"><MapPin size={15} /> آخر موقع معروف: {zoneNames[person.position.zone]}</p></section><section className="detail-card"><h2><Users size={18} /> العلاقات والأنساب</h2>{relations.length ? relations.map((relation) => { const fromId = "fromId" in relation ? relation.fromId : ""; const toId = "toId" in relation ? relation.toId : ""; const otherId = fromId === person.id ? toId : fromId; const other = world.characters.find((candidate) => candidate.id === otherId); const labels = "acceptedLabels" in relation ? relation.acceptedLabels : []; return <div className="relation-row" key={relation.id}><strong>{other?.name ?? otherId ?? "شخصية تاريخية"}</strong><span>{labels.length ? labels.join("، ") : "رابطة اتجاهية بلا تسمية مشتركة"}</span></div>; }) : <p className="muted-copy">لا توجد علاقات مفروضة أو معلنة بعد.</p>}<p className="privacy-line"><Archive size={15} /> الأم: {person.motherId ?? "مؤسس"} · الأب: {person.fatherId ?? "مؤسس"}</p></section><section className="detail-card memory-card"><h2><Brain size={18} /> ذكريات وأحداث مهمة</h2>{memories.length ? memories.map((memory) => <article key={memory.id}><span>اليوم {Math.floor(memory.simDay)}</span><p>{"summary" in memory ? memory.summary : ""}</p></article>) : <p className="muted-copy">لم تتشكل ذكريات عامة مهمة بعد.</p>}<div className="privacy-line"><Shield size={15} /> لا نعرض الاستدلال الداخلي، والذاكرة المؤقتة للمتوفى تحفظ مضغوطة خارج الحالة الحية.</div></section></div>
  </main>;
}

function isHistorical(value: PersonResponse | null): value is HistoricalPersonSnapshot { return Boolean(value && "biography" in value); }
function stageLabel(stage: PublicCharacterState["lifeStage"]): string { return ({ infant: "رضيع", young_child: "طفل صغير", child: "طفل", adolescent: "يافع", adult: "بالغ", elder: "كبير سن" } as const)[stage]; }
function Stat({ label, value }: { label: string; value: number }) { return <div className="profile-stat"><span>{label}</span><strong>{Math.round(value)}%</strong><i><b style={{ width: `${value}%` }} /></i></div>; }
