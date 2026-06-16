import type { Item, RolledMod } from "../engine/types";
import { renderMod, modTier } from "../engine/mods";

function ModLines({ mod }: { mod: RolledMod }) {
  const { tier, count } = modTier(mod.def);
  const lines = renderMod(mod);
  const cls = mod.fractured
    ? "mod fractured"
    : mod.desecrated
    ? "mod desecrated"
    : mod.essence
    ? "mod essence"
    : "mod";
  const badge = mod.fractured
    ? "🔒 fractured"
    : mod.desecrated
    ? "desecrated"
    : mod.essence
    ? "essence"
    : null;
  return (
    <div className={cls}>
      {lines.map((l, i) => (
        <div key={i}>
          {l}
          {i === 0 && (
            <span className="tier">
              [{mod.def.type[0]}] T{tier}/{count} · {mod.def.affix}
              {badge && <span className="badge"> · {badge}</span>}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function ItemCard({ item }: { item: Item }) {
  const b = item.base;
  const isWeapon = b.aps !== undefined;
  const qMult = 1 + item.quality / 100;

  let stats: string;
  if (isWeapon) {
    let incPhys = 0;
    for (const m of [...item.prefixes, ...item.suffixes]) {
      if (m.def.group === "LocalPhysicalDamagePercent") incPhys += m.values[0] || 0;
      if (m.def.group === "LocalIncreasedPhysicalDamagePercentAndAccuracyRating")
        incPhys += m.values[0] || 0;
    }
    let addMin = 0,
      addMax = 0;
    for (const m of item.prefixes) {
      if (m.def.group === "LocalPhysicalDamage") {
        addMin += m.values[0] || 0;
        addMax += m.values[1] || 0;
      }
    }
    const totMult = qMult * (1 + incPhys / 100);
    const dmgMin = Math.round(((b.physMin ?? 0) + addMin) * totMult);
    const dmgMax = Math.round(((b.physMax ?? 0) + addMax) * totMult);
    const dps = (((dmgMin + dmgMax) / 2) * (b.aps ?? 1)).toFixed(1);
    stats = `Physical: ${dmgMin}–${dmgMax} · ${b.aps} APS · pDPS ${dps} · Crit ${b.critBase}%`;
  } else {
    // armour: % increased defences group is "DefencesPercent"
    let incDef = 0;
    for (const m of [...item.prefixes, ...item.suffixes]) {
      if (/Defences(Percent)?$/i.test(m.def.group) || m.def.group === "DesBootsDefences")
        incDef += m.values[0] || 0;
    }
    const mult = qMult * (1 + incDef / 100);
    const parts: string[] = [];
    if (b.armour) parts.push(`Armour ${Math.round(b.armour * mult)}`);
    if (b.evasion) parts.push(`Evasion ${Math.round(b.evasion * mult)}`);
    if (b.energyShield) parts.push(`ES ${Math.round(b.energyShield * mult)}`);
    stats = parts.join(" · ");
  }

  const rar = item.rarity.toLowerCase();
  const kind = isWeapon ? "Bow" : "Boots";
  const title =
    item.rarity === "Rare"
      ? `Crafted ${kind}`
      : item.rarity === "Magic"
      ? `Magic ${kind}`
      : b.name;

  return (
    <div className={`item ${rar}`}>
      <div className="name">
        {title}
        <div style={{ fontSize: 12, color: "var(--muted)" }}>{b.name}</div>
      </div>
      <div className="props">
        {stats}
        <br />
        Quality {item.quality}% · iLvl {item.ilvl}
      </div>
      {b.implicit && <div className="implicit">{b.implicit}</div>}
      <div className="mods">
        {item.prefixes.length === 0 && item.suffixes.length === 0 && item.unrevealed === 0 && (
          <div className="muted">no modifiers</div>
        )}
        {item.prefixes.map((m, i) => (
          <ModLines key={"p" + i} mod={m} />
        ))}
        {item.suffixes.map((m, i) => (
          <ModLines key={"s" + i} mod={m} />
        ))}
        {Array.from({ length: item.unrevealed }).map((_, i) => (
          <div key={"u" + i} className="mod desecrated">
            Unrevealed Desecrated Modifier
            <span className="tier"> · unrevealed</span>
          </div>
        ))}
      </div>
      {item.corrupted && <div className="corrupt">Corrupted</div>}
    </div>
  );
}
