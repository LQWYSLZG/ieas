const drawings: Record<string, React.ReactNode> = {
  "inventory-assistant": <>{[[52,50],[96,65],[96,32]].map(([x,y]) => <g key={x+"-"+y} transform={`translate(${x} ${y})`}><path fill="#62543c" d="m0 0 28-15 32 12-29 16z"/><path fill="#403929" d="m0 0 31 13v25L0 25z"/><path fill="#302d25" d="m31 13 29-16v25L31 38z"/><path d="m9 10 10 4m-10 0 7 3m23-8 12-7"/></g>)}</>,
  "operations-assistant": <><path d="m32 89 60 20 71-36-62-18z" fill="#302d25"/><path d="m48 85 23-12 25 9-24 12z" fill="#615139"/><path d="M66 82 80 45l10 4-12 36zM83 43l35-17 6 9-34 17z" fill="#6a5a3d"/><path d="m121 29 22 15-4 7-23-16z" fill="#453c2c"/><path d="m141 46 6 7-4 9m-5-14-3 8 2 6"/>{[[72,82,6],[85,46,8],[120,31,6]].map(([x,y,r])=><circle key={x} cx={x} cy={y} r={r} fill="#383329"/>)}</>,
  "production-assistant": <><path d="m43 41 97-16 12 62-97 16z" fill="#393529"/><path d="m50 48 83-14m-76 29 79-14m-76 28 79-14m-76 28 79-14" opacity=".5"/><path d="m61 57 20-4m4 14 24-4m2 13 18-3" strokeWidth="5"/></>,
  "quality-assistant": <><circle cx="97" cy="62" r="36" fill="#393529"/><circle cx="97" cy="62" r="30" fill="#23231f"/>{Array.from({length:11},(_,i)=><path key={i} d="M97 36v5" transform={`rotate(${i*25-125} 97 62)`}/>)}<path d="m94 64 22-18-17 20z" fill="#dbc18b"/><circle cx="97" cy="62" r="4" fill="#a88a53"/><path d="M92 99v7h10v-7"/></>,
};

export function CategoryPlate({id}: {id:string}) {
  return <svg className="category-plate" viewBox="0 0 200 120" aria-hidden="true" focusable="false">
    <g stroke="currentColor" fill="none" strokeWidth=".7" opacity=".3"><path d="M17 93h165M28 106h146M42 14v90m120-87v82" strokeDasharray="2 5"/><path d="M15 25v-8h8m153 83h8v-8"/></g>
    <g className="plate-object" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" fill="none">{drawings[id]}</g>
  </svg>;
}
