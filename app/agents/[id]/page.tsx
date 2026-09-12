import { ArrowRight, Brain, MapPin, Shield, Sparkles, Target, Users } from "lucide-react";
import Link from "next/link";
import type { ApiEnvelope, PublicWorldSnapshot } from "@/shared/contracts";

export const dynamic = "force-dynamic";

export default async function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ season?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const engine = process.env.ENGINE_PUBLIC_URL;
  let world: PublicWorldSnapshot | null = null;
  if (engine && query.season) {
    try {
      const response = await fetch(`${engine}/api/seasons/${encodeURIComponent(query.season)}/snapshot`, { cache: "no-store" });
      const envelope = await response.json() as ApiEnvelope<PublicWorldSnapshot>;
      if (response.ok && envelope.ok) world = envelope.data;
    } catch { /* render an honest unavailable state */ }
  }
  const person = world?.characters.find((character) => character.id === id);
  if (!world || !person) return <main className="detail-shell unavailable-profile"><Link className="back-link" href="/"><ArrowRight size={17} /> العودة إلى الجزيرة</Link><section className="detail-card"><h1>السجل غير متاح الآن</h1><p className="muted-copy">تعذر تحميل هذه الشخصية من العالم الحقيقي. لم نستبدلها ببيانات تجريبية.</p></section></main>;

  const relations = world.relationships.filter((relation) => relation.characterAId === person.id || relation.characterBId === person.id);
  const memories = world.recentEvents.filter((event) => event.actorId === person.id || event.targetId === person.id).slice(0, 8);
  const zoneNames = { beach: "الشاطئ", spring: "النبع", forest: "الغابة", grassland: "السهل", camp: "المخيم", ridge: "المرتفعات" };

  return <main className="detail-shell"><Link className="back-link" href={`/?season=${world.seasonId}`}><ArrowRight size={17} /> العودة إلى الجزيرة</Link><section className="profile-hero"><div className="profile-avatar" style={{ background: person.color }}>{person.name.slice(0, 1)}</div><div><span className="eyebrow">سجل شخصية عام</span><h1>{person.name}</h1><p>{Math.floor(person.ageYears)} سنة · {person.lifeStage === "child" ? "طفل" : person.lifeStage === "elder" ? "كبير سن" : "بالغ"} · {person.alive ? "على قيد الحياة" : "متوفى"}</p></div></section>
    <div className="detail-grid"><section className="detail-card"><h2><Target size={18} /> الهدف الحالي</h2><p className="large-copy">{person.goal}</p><div className="stat-grid"><Stat label="الصحة" value={person.health} /><Stat label="الطاقة" value={person.energy} /><Stat label="المعنويات" value={person.morale} /><Stat label="الشبع" value={100 - person.hunger} /></div></section><section className="detail-card"><h2><Sparkles size={18} /> السمات والمهارات</h2><h3>السمات</h3><div className="chips">{person.traits.map((trait) => <span key={trait}>{trait}</span>)}</div><h3>المهارات</h3><div className="chips">{person.skills.length ? person.skills.map((skill) => <span key={skill}>{skill}</span>) : <span>تتطور مع العمر</span>}</div><p className="location"><MapPin size={15} /> {zoneNames[person.position.zone]}</p></section><section className="detail-card"><h2><Users size={18} /> العلاقات المعلنة</h2>{relations.length ? relations.map((relation) => { const otherId = relation.characterAId === person.id ? relation.characterBId : relation.characterAId; const other = world.characters.find((candidate) => candidate.id === otherId); return <div className="relation-row" key={relation.id}><strong>{other?.name ?? "شخصية"}</strong><span>{relation.status === "married" ? "متزوجان" : relation.status === "friend" ? "صداقة" : relation.status === "separated" ? "منفصلان" : "معرفة"}</span></div>; }) : <p className="muted-copy">لا توجد علاقات معلنة بعد.</p>}</section><section className="detail-card memory-card"><h2><Brain size={18} /> أحداث مرتبطة بالشخصية</h2>{memories.length ? memories.map((memory) => <article key={memory.id}><span>{memory.detail}</span><p>{memory.text}</p></article>) : <p className="muted-copy">لم تتشكل أحداث عامة بعد.</p>}<div className="privacy-line"><Shield size={15} /> لا نعرض الاستدلال الداخلي أو الأفكار الخام.</div></section></div>
  </main>;
}

function Stat({ label, value }: { label: string; value: number }) { return <div className="profile-stat"><span>{label}</span><strong>{Math.round(value)}%</strong><i><b style={{ width: `${value}%` }} /></i></div>; }
